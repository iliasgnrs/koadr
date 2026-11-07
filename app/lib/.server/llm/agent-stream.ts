import {
  generateId,
  NoSuchToolError,
  ToolChoiceViolationError,
  wrapLanguageModel,
  type LanguageModel,
  type StreamTextOnErrorRetryCallback,
} from 'ai';
import { resolveToolAlias } from '~/lib/.server/api/errors';

const DEFAULT_ATTEMPT_LIMITS = { firstMs: 120_000, idleMs: 120_000, attemptMs: 300_000 };
const MAX_RECOVERY_ATTEMPTS = 2;
const MAX_RECOVERED_CALLS = 8;

type StreamModel = Exclude<LanguageModel, string>;

/**
 * Rebuilds a model around a wrapped `doStream`.
 *
 * A bare `{ ...model, doStream }` loses `provider` and `supportedUrls`: both are
 * non-enumerable on provider models, and the SDK calls `model.provider.split('.')`
 * before every request, so a spread copy fails with "Cannot read properties of
 * undefined (reading 'split')" for every provider.
 */
function withStreamOverride(model: StreamModel, doStream: StreamModel['doStream']): StreamModel {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: model.doGenerate.bind(model),
    doStream,
  } as StreamModel;
}

/** Recover complete JSON calls to available tools or retry once. Effects still use normal validation and approvals. */
export function withAgentToolCallRecovery(model: LanguageModel, onRetry: () => void) {
  if (typeof model === 'string') {
    return model;
  }

  const normalized = wrapLanguageModel({ model, middleware: [] });

  return withStreamOverride(normalized, async (params: Parameters<typeof normalized.doStream>[0]) => {
    const choice = params.toolChoice;

    /*
     * `auto` on a thinking-mode model is the same intent as `required`, since the
     * provider refuses a forced tool_choice there. Keep the retry path so a text
     * reply (or a call to a tool filtered out of this step) is still corrected.
     */
    if (!choice || (choice.type !== 'required' && choice.type !== 'tool' && choice.type !== 'auto')) {
      return normalized.doStream(params);
    }

    const cancellation = new AbortController();

    const abortSignal = params.abortSignal
      ? AbortSignal.any([params.abortSignal, cancellation.signal])
      : cancellation.signal;

    const initial = await normalized.doStream({ ...params, abortSignal });
    type Part = Awaited<ReturnType<typeof normalized.doStream>>['stream'] extends ReadableStream<infer T> ? T : never;

    let reader: ReadableStreamDefaultReader<Part> | undefined;
    let cancelled = false;

    return {
      ...initial,
      stream: new ReadableStream<Part>({
        async start(controller) {
          try {
            for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS && !cancelled; attempt++) {
              const correction =
                'Your previous response did not call a required tool. Use the supplied native tools interface now. Do not print JSON or function calls as text. Follow the tool schema exactly.';
              const retryPrompt =
                params.prompt[0]?.role === 'system'
                  ? [
                      { ...params.prompt[0], content: `${params.prompt[0].content}\n\n${correction}` },
                      ...params.prompt.slice(1),
                    ]
                  : [{ role: 'system' as const, content: correction }, ...params.prompt];

              const result =
                attempt === 0 ? initial : await normalized.doStream({ ...params, prompt: retryPrompt, abortSignal });

              if (cancelled) {
                await result.stream.cancel();
                return;
              }

              reader = result.stream.getReader();

              const buffered: Part[] = [];

              let satisfied = false;
              let failed = false;
              let finished = false;

              while (!cancelled) {
                const { done, value } = await reader.read();

                if (done) {
                  break;
                }

                if (
                  value.type === 'tool-call' &&
                  (choice.type === 'auto' || choice.type === 'required' || value.toolName === choice.toolName)
                ) {
                  satisfied = true;
                }

                if (satisfied) {
                  for (const part of buffered.splice(0)) {
                    controller.enqueue(part);
                  }
                  controller.enqueue(value);
                } else {
                  buffered.push(value);
                }

                failed ||= value.type === 'error';

                if (value.type === 'finish') {
                  finished = true;
                  void reader.cancel().catch(() => undefined);
                  break;
                }
              }

              reader.releaseLock();
              reader = undefined;

              if (cancelled) {
                return;
              }

              if (finished && !satisfied && !failed) {
                const text = buffered
                  .filter((part) => part.type === 'text-delta')
                  .map((part) => part.delta)
                  .join('');

                /*
                 * Under `auto` the model may answer in text, which is legitimate; only
                 * JSON or tool markup that names a real tool is treated as a failed call.
                 */
                const recoveryChoice = choice.type === 'auto' ? undefined : choice;
                const allowAnyAvailable = choice.type === 'auto';

                const available = new Set(
                  params.tools?.filter((tool) => tool.type === 'function').map((tool) => tool.name),
                );

                const markupCalls = recoverMarkupToolCalls(text, available, allowAnyAvailable, recoveryChoice);

                const calls = markupCalls.length
                  ? markupCalls
                  : recoverJsonToolCalls(text, params.tools, recoveryChoice, allowAnyAvailable);

                const finish = buffered.find((part) => part.type === 'finish');

                if (calls.length && finish?.type === 'finish') {
                  for (const part of buffered.filter(
                    (part) => !part.type.startsWith('text-') && part.type !== 'finish',
                  )) {
                    controller.enqueue(part);
                  }

                  for (const call of calls) {
                    controller.enqueue({
                      type: 'tool-call',
                      toolCallId: generateId(),
                      toolName: call.name,
                      input: JSON.stringify(call.input),
                      providerMetadata: { bolt: { recoveredFromText: true } },
                    });
                  }
                  controller.enqueue({
                    ...finish,
                    finishReason: { unified: 'tool-calls', raw: 'recovered-tool-calls' },
                  });
                  controller.close();

                  return;
                }
              }

              if (attempt === 0 && finished && !satisfied && !failed) {
                onRetry();
                continue;
              }

              /*
               * Nothing was recovered. Strip markup before flushing, or the user
               * sees a tool call that will never execute. When something was
               * stripped, say so: an empty turn looks like a hang, and the note
               * also replaces the retry that used to burn a step on the same
               * unparseable output.
               */
              let stripped = false;

              for (const part of buffered) {
                if (part.type === 'text-delta') {
                  const delta = stripLeftoverToolMarkup(part.delta);

                  stripped ||= delta !== part.delta;
                  controller.enqueue({ ...part, delta });
                } else {
                  controller.enqueue(part);
                }
              }

              if (stripped) {
                controller.enqueue({
                  type: 'text-delta',
                  id: generateId(),
                  delta:
                    '\n\nI could not run the previous tool call because it was written as text instead of a native call. Tell me to retry and I will use the tools interface.',
                  providerMetadata: { bolt: { recoveredFromText: false } },
                });
              }

              controller.close();

              return;
            }
          } catch (error) {
            void reader?.cancel(error).catch(() => undefined);

            if (!cancelled) {
              controller.enqueue({ type: 'error', error });
              controller.close();
            }
          }
        },
        async cancel(reason) {
          cancelled = true;
          cancellation.abort(reason);
          await reader?.cancel(reason);
        },
      }),
    };
  });
}

/**
 * Some models print tool calls as provider-specific markup instead of using the
 * native tool interface, e.g.
 *
 *   <||DSML|| invoke name="project_get_process_output">
 *   <||DSML|| parameter name="processId" string="true">abc<||DSML|| parameter>
 *   </||DSML|| invoke>
 *
 * The delimiters vary (`<||DSML||`, `antml:`, plain XML), so match on the tag
 * names. Well-formed calls are worth rescuing: the alternative is a turn that
 * only renders text and never runs the command.
 */
/*
 * Bar variants seen in the wild: ASCII `|`, full-width `｜` (U+FF5C), and the
 * heavy/double forms some models emit. Matching only ASCII is what let
 * `｜｜DSML｜｜ invoke ...` through as visible text: the recovery regex found no
 * block, so the raw markup was flushed to the UI and the turn stalled waiting
 * for a tool result that could never arrive.
 */
const TOOL_MARKUP_BARS = '[|\uFF5C\u2225\u2016]';

/*
 * Optional run of bars followed by optional whitespace, e.g. `||DSML|| `,
 * `｜｜DSML｜｜ `, or nothing at all for the `antml:` form.
 *
 * The whitespace matters: the original matched `||DSML|| invoke` only because of
 * `\s*` after the bars. Widening the bars alone was not enough — the run is
 * matched as a unit here so the pattern stays valid inside a template literal.
 */
const TOOL_MARKUP_BARS_OPT = `${TOOL_MARKUP_BARS}{0,2}\\s*`;
const TOOL_MARKUP_PREFIX = `(?:${TOOL_MARKUP_BARS_OPT})?(?:(?:DSML|antml)${TOOL_MARKUP_BARS_OPT}|antml:)?`;

/*
 * Some providers omit the leading `<` entirely: the live failure was
 * `｜｜DSML｜｜ invoke name="...">` with no angle bracket. The bar-prefixed forms
 * are therefore matched with an optional `<`; the plain `antml:` form still
 * requires it, because without it any prose would match.
 */
const TOOL_MARKUP_BLOCK = new RegExp(
  `(?:<|${TOOL_MARKUP_BARS_OPT})${TOOL_MARKUP_PREFIX}invoke\\b[^>]*>[\\s\\S]*?(?:<|\/|${TOOL_MARKUP_BARS_OPT})${TOOL_MARKUP_PREFIX}invoke>`,
  'g',
);

/*
 * Closing tags come in four shapes: `</x:parameter>`, `</｜｜DSML｜｜ parameter>`,
 * `<｜｜DSML｜｜ parameter>` (no slash), and `｜｜DSML｜｜ parameter>` (no `<`).
 *
 * The old terminator `(?:<|\/|bars)` consumed only one character, so the value
 * kept the rest: `p-1</｜｜DSML｜｜ parameter>` captured as `p-1<`. That failed the
 * tool's input schema, the retry re-sent the identical argument, and the turn
 * looked hung. Group 1 surfaces a bar-delimited close so the value can drop the
 * stray `<`; a value legitimately ending in `<` (e.g. code) is unaffected because
 * the group is only set when the parameter closes with bars.
 */
const TOOL_MARKUP_PARAMETER = new RegExp(
  `(?:<|${TOOL_MARKUP_BARS_OPT})${TOOL_MARKUP_PREFIX}parameter\\b[^>]*\\bname\\s*=\\s*"([^"]+)"[^>]*>` +
    `([\\s\\S]*?)` +
    `(?:(?:<\\/|(?=(${TOOL_MARKUP_BARS}))|${TOOL_MARKUP_BARS_OPT})${TOOL_MARKUP_PREFIX}parameter>|(${TOOL_MARKUP_BARS_OPT})${TOOL_MARKUP_PREFIX}parameter>)`,
  'g',
);

function coerceMarkupValue(raw: string, isString: boolean, barDelimitedClose = false): unknown {
  const trimmed = raw.trim();
  const value = barDelimitedClose && trimmed.endsWith('<') ? trimmed.slice(0, -1).trim() : trimmed;

  if (isString) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function recoverMarkupToolCalls(
  text: string,
  available: Set<string>,
  allowAnyAvailable: boolean,
  choice?: { type: 'required' } | { type: 'tool'; toolName: string },
): Array<{ name: string; input: Record<string, unknown> }> {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];

  for (const block of text.match(TOOL_MARKUP_BLOCK) ?? []) {
    const requested = block.match(/\binvoke\b[^>]*\bname\s*=\s*"([^"]+)"/)?.[1];

    if (!requested) {
      return [];
    }

    /*
     * A recovered call is the last chance to act on the model's intent, so a known
     * near-miss (`project_read_command_output`) resolves to the real tool here. The
     * tool's own input schema still validates the arguments before anything runs.
     */
    const name = available.has(requested) ? requested : resolveToolAlias(requested, [...available]);

    if (!name || !available.has(name)) {
      return [];
    }

    const input: Record<string, unknown> = {};

    for (const parameter of block.matchAll(TOOL_MARKUP_PARAMETER)) {
      const barDelimitedClose = Boolean(parameter[3] ?? parameter[4]);

      input[parameter[1]] = coerceMarkupValue(
        parameter[2],
        /\bstring\s*=\s*"true"/.test(parameter[0]),
        barDelimitedClose,
      );
    }

    calls.push({ name, input });
  }

  if (!calls.length || calls.length > MAX_RECOVERED_CALLS) {
    return [];
  }

  if (allowAnyAvailable) {
    return calls;
  }

  return choice?.type === 'required' || calls.some((call) => call.name === choice?.toolName) ? calls : [];
}

/**
 * Last line of defence: drop any leftover provider markup from text that is about
 * to be shown to the user.
 *
 * Recovery above only *rescues* well-formed calls. When a call cannot be rescued
 * — an unknown tool name, a half-written block, a delimiter we do not recognise —
 * the markup must not be rendered as prose. Leaving it visible is what made the
 * UI look hung: the user sees a tool call that will never run.
 */
/*
 * Two alternatives: an unpaired closer (or a truncated opener) on its own, and a
 * complete opening tag through its closing tag.
 */
const LEFTOVER_MARKUP = new RegExp(
  `(?:<|${TOOL_MARKUP_BARS_OPT})${TOOL_MARKUP_PREFIX}(?:\\/|${TOOL_MARKUP_BARS_OPT})(?:invoke|parameter)\\b[^>]*>` +
    `|<${TOOL_MARKUP_PREFIX}(?:invoke|parameter)\\b[^>]*>[\\s\\S]*?` +
    `<\\/${TOOL_MARKUP_PREFIX}(?:invoke|parameter)>`,
  'g',
);

function stripLeftoverToolMarkup(text: string): string {
  return text
    .replace(LEFTOVER_MARKUP, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Attempts to recover tool calls from JSON text when the AI prints JSON instead of calling tools.
 *
 * @param text - The text response from the AI that may contain JSON tool calls
 * @param tools - Available tool definitions to validate against
 * @param choice - The tool choice constraint (required or specific tool)
 * @returns Array of recovered tool calls with name and input, or empty array if recovery fails
 *
 * @example
 * // Input text: '[{"name": "project_read_file", "parameters": {"path": "src/App.tsx"}}]'
 * // Returns: [{ name: "project_read_file", input: { path: "src/App.tsx" } }]
 */
function recoverJsonToolCalls(
  text: string,
  tools: Parameters<Exclude<LanguageModel, string>['doStream']>[0]['tools'],
  choice?: { type: 'required' } | { type: 'tool'; toolName: string },
  allowAnyAvailable = false,
): Array<{ name: string; input: Record<string, unknown> }> {
  try {
    const trimmed = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, '$1');

    let parsed: unknown = JSON.parse(trimmed);

    for (
      let depth = 0;
      depth < 2 && Array.isArray(parsed) && parsed.length === 1 && Array.isArray(parsed[0]);
      depth++
    ) {
      parsed = parsed[0];
    }

    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    const available = new Set(tools?.filter((tool) => tool.type === 'function').map((tool) => tool.name));

    if (!candidates.length || candidates.length > MAX_RECOVERED_CALLS) {
      return [];
    }

    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return [];
      }

      const entry = candidate as Record<string, unknown>;
      const requested = entry.name;
      const input = entry.parameters;

      const name =
        typeof requested === 'string' && !available.has(requested)
          ? resolveToolAlias(requested, [...available])
          : requested;

      if (
        typeof name !== 'string' ||
        !available.has(name) ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(entry).some((key) => key !== 'name' && key !== 'parameters')
      ) {
        return [];
      }

      calls.push({ name, input: input as Record<string, unknown> });
    }

    if (allowAnyAvailable) {
      return calls;
    }

    return choice?.type === 'required' || calls.some((call) => call.name === choice?.toolName) ? calls : [];
  } catch {
    return [];
  }
}

/** Each model attempt has its own deadline, so a timeout can be retried with a fresh signal. */
export function withAgentStreamDeadlines(model: LanguageModel, limits = DEFAULT_ATTEMPT_LIMITS) {
  if (typeof model === 'string') {
    return model;
  }

  const normalized = wrapLanguageModel({ model, middleware: [] });

  return withStreamOverride(normalized, async (params: Parameters<typeof normalized.doStream>[0]) => {
    const attempt = new AbortController();
    const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, attempt.signal]) : attempt.signal;
    const timeout = () => attempt.abort(new DOMException('Agent model response timed out.', 'TimeoutError'));

    let idleTimer = setTimeout(timeout, limits.firstMs);

    const attemptTimer = setTimeout(timeout, limits.attemptMs);

    const cleanup = () => {
      clearTimeout(idleTimer);
      clearTimeout(attemptTimer);
    };

    let abortHandler: () => void = () => undefined;

    const aborted = new Promise<never>((_, reject) => {
      abortHandler = () => reject(signal.reason);

      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
    const release = () => {
      cleanup();
      signal.removeEventListener('abort', abortHandler);
    };

    try {
      const result = await Promise.race([normalized.doStream({ ...params, abortSignal: signal }), aborted]);
      const reader = result.stream.getReader();

      let finished = false;

      return {
        ...result,
        stream: new ReadableStream<
          Awaited<ReturnType<typeof normalized.doStream>>['stream'] extends ReadableStream<infer T> ? T : never
        >({
          async pull(controller) {
            if (finished) {
              return;
            }

            try {
              const { done, value } = await Promise.race([reader.read(), aborted]);

              if (done) {
                finished = true;
                release();
                reader.releaseLock();
                controller.close();

                return;
              }

              // A completed attempt must not be replayed because its transport fails afterward.
              if (value.type === 'finish') {
                finished = true;
                release();
                controller.enqueue(value);
                controller.close();
                void reader.cancel().catch(() => undefined);

                return;
              }

              if (
                ['text-delta', 'reasoning-delta', 'tool-input-start', 'tool-input-delta', 'tool-call'].includes(
                  value.type,
                )
              ) {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(timeout, limits.idleMs);
              }

              controller.enqueue(value);
            } catch (error) {
              finished = true;
              release();
              void reader.cancel(error).catch(() => undefined);
              controller.enqueue({ type: 'error', error });
              controller.close();
            }
          },
          async cancel(reason) {
            finished = true;
            attempt.abort(reason);
            release();
            await reader.cancel(reason);
          },
        }),
      };
    } catch (error) {
      release();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'error' as const, error });
            controller.close();
          },
        }),
      };
    }
  });
}

/**
 * The SDK buffers tool inputs until an attempt succeeds, preserving earlier steps on retry.
 *
 * `NoSuchToolError` is retried. The active tool set is recomputed by `prepareStep`
 * for every step, so a call to a tool that was not offered on the previous step
 * can still succeed on the next one — that is the whole point of the plan gate.
 * Treating it as fatal ended the turn with no preview, which is why a fresh chat
 * died at the first `project_list_paths` before `agent_plan` had run.
 */
export function createAgentStreamRecovery(onRetry: (reason: 'tool-call' | 'provider') => void) {
  let retried = false;
  let firstError: unknown;

  const onError: StreamTextOnErrorRetryCallback = ({ error }) => {
    firstError ??= error;

    if (retried || ToolChoiceViolationError.isInstance(error)) {
      return undefined;
    }

    const message = error instanceof Error ? error.message.toLowerCase() : '';
    const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;

    if (
      (error instanceof Error && error.name === 'AbortError') ||
      (typeof status === 'number' && status >= 400 && status < 500)
    ) {
      return undefined;
    }

    /*
     * `NoSuchToolError` reports itself as a bare Error with the tool name in the
     * message, so it is matched by name and text rather than by class instance.
     */
    const unavailableTool =
      NoSuchToolError.isInstance(error) || /unavailable tool|no such tool|does not exist/.test(message);

    if (unavailableTool) {
      retried = true;
      onRetry('tool-call');

      return { retry: true };
    }

    const retryable =
      (error instanceof Error && error.name === 'TimeoutError') ||
      /network|fetch failed|connection|timed?\s*out|timeout/.test(message) ||
      (typeof status === 'number' && status >= 500);

    if (!retryable) {
      return undefined;
    }

    retried = true;
    onRetry('provider');

    return { retry: true };
  };

  return {
    onError,
    getError: (error: unknown) => firstError ?? error,
    stepSucceeded: () => {
      firstError = undefined;
    },
  };
}

/**
 * The exact set of tool names offered on this request.
 *
 * A live session called `project_read_command_output` — a name that never existed.
 * The retry hint ("did you mean project_get_process_output?") recovers *after* a
 * wasted step, and a model that keeps guessing still burns the turn. Listing the
 * real names costs one short block and removes the guess.
 */
export function getToolCatalogue(names: string[]): string {
  const unique = [...new Set(names)].sort();

  if (unique.length === 0) {
    return '';
  }

  return [
    '<available_tools>',
    `These are the only tools that exist on this request: ${unique.join(', ')}.`,
    'Call a tool by one of these exact names. Never construct a tool name from parts, and never print a tool call as text, JSON or provider markup; printed calls do not execute.',
    'If none of these tools can do what is needed, explain the limitation to the user instead of calling an invented name.',
    '</available_tools>',
  ].join('\n');
}
