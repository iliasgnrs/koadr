import { APICallError, InvalidToolInputError, NoSuchToolError } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  toApiErrorResponse,
  ApiError,
  isTokenLimitFailure,
  toMissingCredentialError,
  toSafeStreamErrorMessage,
  toSafeTextStream,
  toTokenLimitError,
  resolveToolAlias,
  TOOL_ALIASES,
} from './errors';
import { PROJECT_TOOL_NAMES } from '~/lib/runtime/projectMcp.shared';

describe('toMissingCredentialError', () => {
  it('does not serialize provider diagnostics into the 401 response', async () => {
    const secretDiagnostic = 'https://provider.example/?api_key=secret-value';
    const response = toApiErrorResponse(toMissingCredentialError('Example', secretDiagnostic));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      message: 'Invalid or missing API key',
      statusCode: 401,
      isRetryable: false,
      provider: 'Example',
    });
    expect(JSON.stringify(body)).not.toContain(secretDiagnostic);
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });
});

describe('toSafeStreamErrorMessage', () => {
  it('explains tool validation failures without exposing raw arguments or provider details', () => {
    const invalid = new InvalidToolInputError({
      toolName: 'project_list_paths',
      toolInput: 'secret-value',
      cause: new Error('invalid schema'),
    });

    const missing = new NoSuchToolError({ toolName: 'secret-value' });

    expect(toSafeStreamErrorMessage(invalid)).toContain('invalid tool arguments');
    expect(toSafeStreamErrorMessage(missing)).toContain('unavailable tool');
    expect(toSafeStreamErrorMessage(invalid)).not.toContain('secret-value');
    expect(toSafeStreamErrorMessage(missing)).not.toContain('secret-value');
    expect(toSafeStreamErrorMessage(invalid.message)).toContain('invalid tool arguments');
    expect(toSafeStreamErrorMessage(missing.message)).toContain('unavailable tool');
    expect(toSafeStreamErrorMessage(missing.message)).not.toContain('secret-value');
  });

  it('suggests the real tool when the model invents a similar name', () => {
    /*
     * The live failure: the model called `project_read_command_output`, which has
     * never existed, while `project_get_process_output` was available. A dead-end
     * message cost the rest of the turn.
     */
    const error = new NoSuchToolError({
      toolName: 'project_read_command_output',
      availableTools: ['project_write_file', 'project_run_command', 'project_get_process_output'],
    });

    const message = toSafeStreamErrorMessage(error);

    expect(message).toContain('project_read_command_output');
    expect(message).toContain('Did you mean "project_get_process_output"');
  });

  it('suggests from the caller-supplied list when the SDK omits availableTools', () => {
    /*
     * The SDK constructs NoSuchToolError with only `toolName`, so `availableTools`
     * is always undefined on a real error. The previous test above passed the list
     * itself and therefore never exercised production behaviour — the suggestion
     * could not fire, and every unknown tool got the same dead-end message.
     */
    const error = new NoSuchToolError({ toolName: 'project_read_command_output' });

    const message = toSafeStreamErrorMessage(error, [
      'project_write_file',
      'project_run_command',
      'project_get_process_output',
    ]);

    expect(message).toContain('Did you mean "project_get_process_output"');
  });

  it('does not guess when nothing is close', () => {
    const error = new NoSuchToolError({
      toolName: 'project_frobnicate_everything',
      availableTools: ['web_fetch', 'web_search'],
    });

    expect(toSafeStreamErrorMessage(error)).not.toContain('Did you mean');
  });

  it('never reflects a name that does not look like a tool identifier', () => {
    // Sanitisation: arbitrary strings must not come back to the client.
    const error = new NoSuchToolError({ toolName: '<script>alert(1)</script>' });

    const message = toSafeStreamErrorMessage(error);

    expect(message).not.toContain('script');
    expect(message).toContain('unavailable tool');
  });

  it('recognizes a provider 429 even when its message does not mention the status', () => {
    const error = Object.assign(new Error('Provider returned error: secret-value'), { statusCode: 429 });

    expect(toSafeStreamErrorMessage(error)).toContain('API rate limit exceeded');
    expect(toSafeStreamErrorMessage(error)).not.toContain('secret-value');
  });

  it('recognizes capitalized rate-limit messages', () => {
    expect(toSafeStreamErrorMessage(new Error('Rate limit exceeded: free-models-per-day'))).toContain(
      'API rate limit exceeded',
    );
  });

  it('returns a generic message instead of an unknown provider diagnostic', () => {
    const diagnostic = 'Request https://provider.example/?api_key=secret-value failed';
    const responseMessage = toSafeStreamErrorMessage(new Error(diagnostic));

    expect(responseMessage).toBe(
      'Custom error: The AI provider request failed. Check your provider settings and try again.',
    );
    expect(responseMessage).not.toContain(diagnostic);
    expect(responseMessage).not.toContain('secret-value');
  });

  it('retains safe credential guidance without echoing provider details', () => {
    const responseMessage = toSafeStreamErrorMessage(
      new Error('Invalid API key https://provider.example/?api_key=secret-value'),
    );

    expect(responseMessage).toContain('Invalid or missing API key');
    expect(responseMessage).not.toContain('provider.example');
    expect(responseMessage).not.toContain('secret-value');
  });

  it('identifies SDK chunk timeouts as an unfinished provider step, preserving safe recovery guidance', () => {
    const hint = toSafeStreamErrorMessage(new DOMException('Chunk timeout of 45000ms exceeded', 'TimeoutError'));
    expect(hint).toContain('provider stopped responding');
    expect(hint).toContain('tool results are preserved');
    expect(hint).not.toContain('internet connection');
  });
});

describe('toSafeTextStream', () => {
  it('replaces a post-response provider stream error with generic text', async () => {
    const diagnostic = 'https://provider.example/?api_key=secret-value';

    let pulls = 0;

    const upstream = new ReadableStream<string>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue('partial response');
        } else {
          controller.error(new Error(diagnostic));
        }
      },
    });

    // Construct the HTTP response before consuming the stream, matching the route's timing.
    const response = new Response(toSafeTextStream(upstream), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });

    const body = await response.text();

    expect(body).toContain('partial response');
    expect(body).toContain('The AI provider request failed');
    expect(body).not.toContain(diagnostic);
    expect(body).not.toContain('secret-value');
  });
});

describe('toTokenLimitError', () => {
  it('returns a fixed client message without provider diagnostics', async () => {
    const response = toApiErrorResponse(toTokenLimitError('Example'));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      message: 'Token limit exceeded. Try reducing your request size or using a model with higher token limits.',
      statusCode: 400,
      provider: 'Example',
    });
    expect(JSON.stringify(body)).not.toContain('https://provider.example');
  });

  it('recognizes provider token diagnostics but leaves typed failures alone', () => {
    expect(isTokenLimitFailure(new Error('max_tokens exceeded at https://provider.example?key=secret'))).toBe(true);
    expect(isTokenLimitFailure(new Error('max_tokens exceeded'))).toBe(true);
    expect(isTokenLimitFailure(new Error('maximum context length is 4097 tokens'))).toBe(true);
    expect(isTokenLimitFailure(new Error('Access token expired'))).toBe(false);
    expect(isTokenLimitFailure(new Error('Invalid API token'))).toBe(false);
    expect(isTokenLimitFailure(new ApiError('Typed token failure', { status: 400, code: 'token_limit' }))).toBe(false);
  });

  it('reports the provider status instead of the generic settings hint', () => {
    /*
     * APICallError used to fall through to "check your provider settings", so a
     * 402 (no credit) and an oversized-context 400 looked identical to the user and
     * to the agent, which then retried the same doomed request.
     */
    const make = (statusCode: number) =>
      new APICallError({
        message: `status ${statusCode}`,
        url: 'https://provider.example',
        requestBodyValues: {},
        statusCode,
      });

    expect(toSafeStreamErrorMessage(make(402))).toContain('billing');
    expect(toSafeStreamErrorMessage(make(400))).toContain('rejected the request as invalid');
    expect(toSafeStreamErrorMessage(make(403))).toContain('refused access');
    expect(toSafeStreamErrorMessage(make(404))).toContain('could not find the selected model');
    expect(toSafeStreamErrorMessage(make(503))).toContain('server errors');
  });
});

describe('resolveToolAlias', () => {
  const available = ['project_get_process_output', 'project_run_command', 'project_patch_file', 'project_list_paths'];

  it('maps the exact name the model invented to the tool it meant', () => {
    expect(resolveToolAlias('project_read_command_output', available)).toBe('project_get_process_output');
    expect(resolveToolAlias('project_apply_patch', available)).toBe('project_patch_file');
  });

  it('leaves a real name untouched', () => {
    expect(resolveToolAlias('project_run_command', available)).toBe('project_run_command');
  });

  it('refuses a name that only shares the namespace prefix', () => {
    /*
     * `project_query_database` shares `project_` with everything and nothing else
     * with a real tool; resolving it would run an unrelated effect.
     */
    expect(resolveToolAlias('project_query_database', available)).toBeUndefined();
  });
});

describe('TOOL_ALIASES contract', () => {
  /*
   * An alias is only useful if its target is a tool the model can actually be
   * offered. Renaming or removing a project tool would otherwise leave a silent
   * no-op alias that quietly stops recovering the invented name it was added for.
   */
  it('only points at names in PROJECT_TOOL_NAMES', () => {
    const known = new Set<string>(PROJECT_TOOL_NAMES);

    for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
      expect(known.has(target), `${alias} -> ${target}`).toBe(true);
    }
  });

  it('never shadows a real tool name', () => {
    const known = new Set<string>(PROJECT_TOOL_NAMES);

    for (const alias of Object.keys(TOOL_ALIASES)) {
      expect(known.has(alias), alias).toBe(false);
    }
  });
});
