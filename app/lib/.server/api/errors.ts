import { APICallError, InvalidToolInputError, NoSuchToolError, ToolChoiceViolationError } from 'ai';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.errors');

/**
 * Error shape returned by the chat/llmcall routes.
 *
 * This is a wire contract, not an internal detail: Chat.client.tsx parses the
 * failure body and reads `statusCode`, `isRetryable`, `provider` and `message`
 * to pick the alert type (authentication / rate_limit / quota / network). Adding
 * a field is safe; renaming or removing one silently degrades every error alert
 * in the UI to "Request Failed".
 */
export interface ApiErrorBody {
  error: true;
  message: string;
  statusCode: number;
  isRetryable: boolean;
  provider: string;
}

/**
 * A failure with a deliberate HTTP status, so the wrapper does not have to guess.
 *
 * Anything thrown that is *not* an ApiError becomes a 500. That is why a plain
 * `throw new Error('bad input')` in a route used to surface as an opaque server
 * error: there was no way to say "this one is the client's fault".
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly isRetryable: boolean;
  readonly provider?: string;

  constructor(
    message: string,
    options: { status?: number; code?: string; isRetryable?: boolean; provider?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });

    this.name = 'ApiError';
    this.status = options.status ?? 500;
    this.code = options.code ?? 'internal_error';
    this.isRetryable = options.isRetryable ?? this.status >= 500;
    this.provider = options.provider;
  }

  /**
   * The wire body for this failure.
   *
   * A getter rather than a plain field because subclasses (PayloadTooLargeError,
   * ValidationError, …) override `name`, so anything identifying this error by
   * its `name` must not be matching on it. See `isTypedApiError` in security.ts.
   */
  get body(): ApiErrorBody {
    return {
      error: true,
      message: this.message,
      statusCode: this.status,
      isRetryable: this.isRetryable,
      provider: this.provider ?? 'unknown',
    };
  }
}

/** The request body could not be parsed, or failed schema validation. */
export class ValidationError extends ApiError {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message, { status: 400, code: 'invalid_request', isRetryable: false });
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/** The body exceeded the route's byte budget. */
export class PayloadTooLargeError extends ApiError {
  constructor(limitBytes: number) {
    super(`Request body is too large. The limit is ${formatBytes(limitBytes)}.`, {
      status: 413,
      code: 'payload_too_large',
      isRetryable: false,
    });
    this.name = 'PayloadTooLargeError';
  }
}

/** The client stopped sending before the body was complete. */
export class RequestTimeoutError extends ApiError {
  constructor(timeoutMs: number) {
    super(`Request body timed out after ${Math.round(timeoutMs / 1000)}s.`, {
      status: 408,
      code: 'request_timeout',
      isRetryable: true,
    });
    this.name = 'RequestTimeoutError';
  }
}

/** The client disconnected mid-body. Not an error worth a stack trace. */
export class RequestAbortedError extends ApiError {
  constructor() {
    super('Request cancelled.', { status: 499, code: 'client_closed_request', isRetryable: false });
    this.name = 'RequestAbortedError';
  }
}

/**
 * Credentials problems, normalised across providers.
 *
 * Every provider phrases this differently ("Incorrect API key", "invalid x-api-key",
 * 401, 403), so the routes matched on substrings of the provider's message. Keep
 * provider diagnostics out of the client response because they can contain
 * request URLs or credential data.
 */
export function toMissingCredentialError(provider: string, providerMessage?: string): ApiError {
  if (providerMessage) {
    logger.warn('Provider credential error');
  }

  return new ApiError('Invalid or missing API key', {
    status: 401,
    code: 'missing_api_key',
    isRetryable: false,
    provider,
  });
}

/**
 * Turn an unknown tool name into something actionable.
 *
 * A real session called `project_read_command_output`, which has never existed —
 * the tool is `project_get_process_output`. The old message ("use one of the
 * supplied tools") gave the model nothing to correct towards, so it retried and
 * burned the turn. Naming the closest match costs one string compare and usually
 * ends the loop immediately.
 */
function describeUnknownTool(error: unknown, fallbackTools: string[] = []): string {
  const requested =
    typeof error === 'object' && error !== null && 'toolName' in error
      ? String((error as { toolName: unknown }).toolName)
      : '';
  const supplied =
    typeof error === 'object' && error !== null && 'availableTools' in error
      ? ((error as { availableTools?: string[] }).availableTools ?? [])
      : [];

  /*
   * The SDK never populates `availableTools`, so the caller passes the real list.
   * Prefer the error's own list when a provider does supply one.
   */
  const available = supplied.length ? supplied : fallbackTools;

  if (!requested) {
    return 'The model requested an unavailable tool. Use one of the supplied tools instead.';
  }

  /*
   * Only echo a name that looks like one of ours. The sanitisation tests feed
   * arbitrary strings (`secret-value`) through this path and require that nothing
   * of the sort is reflected back to the client; a provider diagnostic could
   * carry anything, so the pattern is the gate rather than trust in the caller.
   */
  if (!/^[a-z][a-z0-9_]{2,64}$/.test(requested)) {
    return 'The model requested an unavailable tool. Use one of the supplied tools instead.';
  }

  const suggestion = findClosestTool(requested, available);

  return suggestion
    ? `Tool "${requested}" does not exist. Did you mean "${suggestion}"? Use only the supplied tool names.`
    : `Tool "${requested}" does not exist. Use only the supplied tool names.`;
}

/**
 * Closest available name by token overlap, e.g. `project_read_command_output`
 * against `project_get_process_output` shares the `project` prefix and the
 * `output` suffix. Deliberately simple: a wrong suggestion is harmless, because
 * the model still has to pick a name that exists.
 */
function findClosestTool(requested: string, available: string[]): string | undefined {
  if (!available.length) {
    return undefined;
  }

  const tokens = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );

  const wanted = tokens(requested);

  let best: string | undefined;
  let bestScore = 0;

  /*
   * Prefix and suffix carry more signal than any single token. `project_..._output`
   * is a much better guess than `project_run_command` for
   * `project_read_command_output`, even though both share two tokens with it —
   * which is exactly the tie that picked the wrong tool on the first attempt.
   */
  const head = (value: string) => value.toLowerCase().split('_')[0];
  const tail = (value: string) => value.toLowerCase().split('_').pop() ?? '';

  for (const candidate of available) {
    const overlap = [...tokens(candidate)].filter((token) => wanted.has(token)).length;

    const score =
      overlap + (head(candidate) === head(requested) ? 1 : 0) + (tail(candidate) === tail(requested) ? 2 : 0);

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  // Require at least the shared namespace token, or any coincidence would suggest.
  return bestScore >= 2 ? best : undefined;
}

/** Converts a streaming provider error to a client-safe hint without forwarding diagnostics. */
export function toSafeStreamErrorMessage(error: unknown, availableTools: string[] = []): string {
  const providerMessage = error instanceof Error ? error.message : String(error);
  const normalizedMessage = providerMessage.toLowerCase();

  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;

  /*
   * Log the diagnostic, not just the class. "Streaming provider error (UnknownError)"
   * gave no way to tell a bad model name from a rejected tool call, which cost a
   * full debugging round trip on a live failure.
   */
  logger.error(
    `Streaming provider error (${error instanceof Error ? error.name : 'UnknownError'}): ${providerMessage.slice(0, 500)}`,
  );

  if ((error instanceof Error && error.name === 'TimeoutError') || /timeout|timed\s*out/.test(normalizedMessage)) {
    return 'Custom error: The AI provider stopped responding before the next step completed. Completed file changes and tool results are preserved. Retry to continue, or select a different model.';
  }

  if (ToolChoiceViolationError.isInstance(error)) {
    return 'Custom error: The selected model returned text instead of the required tool call, so the build could not continue. Retry or select a model that reliably supports tool calling.';
  }

  if (InvalidToolInputError.isInstance(error) || normalizedMessage.startsWith('invalid input for tool ')) {
    return 'Custom error: The model supplied invalid tool arguments. Retry the tool call using its declared input schema.';
  }

  if (NoSuchToolError.isInstance(error) || normalizedMessage.startsWith('model tried to call unavailable tool ')) {
    return `Custom error: ${describeUnknownTool(error, availableTools)}`;
  }

  if (providerMessage.includes('model') && providerMessage.includes('not found')) {
    return 'Custom error: Invalid model selected. Please check that the model name is correct and available.';
  }

  if (providerMessage.includes('Invalid JSON response')) {
    return 'Custom error: The AI service returned an invalid response. This may be due to an invalid model name, API rate limiting, or server issues. Try selecting a different model or check your API key.';
  }

  if (
    providerMessage.includes('API key') ||
    providerMessage.includes('unauthorized') ||
    providerMessage.includes('authentication')
  ) {
    return 'Custom error: Invalid or missing API key. Please check your API key configuration.';
  }

  if (providerMessage.includes('token') && providerMessage.includes('limit')) {
    return 'Custom error: Token limit exceeded. The conversation is too long for the selected model. Try using a model with larger context window or start a new conversation.';
  }

  if (statusCode === 429 || normalizedMessage.includes('rate limit') || providerMessage.includes('429')) {
    return 'Custom error: API rate limit exceeded, or the provider rejected the request for account reasons. Check your provider account and try again.';
  }

  if (providerMessage.includes('network') || providerMessage.includes('timeout')) {
    return 'Custom error: Network error. Please check your internet connection and try again.';
  }

  /*
   * APICallError was previously unhandled, so every provider HTTP failure landed on
   * the generic "check your provider settings" string, whatever the real status was.
   * A 402 (out of credit) or a 400 (malformed request) both looked identical.
   */
  if (APICallError.isInstance(error)) {
    const apiStatus = typeof statusCode === 'number' ? statusCode : undefined;

    if (apiStatus === 402) {
      return 'Custom error: The provider rejected the request for billing reasons. Add credit to the provider account and try again.';
    }

    if (apiStatus === 403) {
      return 'Custom error: The provider refused access. Check that the API key has permission to use the selected model.';
    }

    if (apiStatus === 400 || apiStatus === 422) {
      return 'Custom error: The provider rejected the request as invalid. This usually means the conversation is too long or contains content the model cannot accept. Start a new chat or select a different model.';
    }

    if (apiStatus === 404) {
      return 'Custom error: The provider could not find the selected model or endpoint. Check that the model name is correct and available.';
    }

    if (typeof apiStatus === 'number' && apiStatus >= 500) {
      return 'Custom error: The provider is returning server errors. Wait a moment and retry.';
    }
  }

  return 'Custom error: The AI provider request failed. Check your provider settings and try again.';
}

/** Wraps a plain-text provider stream so late failures become a safe text chunk. */
export function toSafeTextStream(stream: ReadableStream<string>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const encoder = new TextEncoder();

  let failed = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (failed) {
        controller.close();
        return;
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          reader.releaseLock();
          controller.close();

          return;
        }

        controller.enqueue(encoder.encode(value));
      } catch (error) {
        failed = true;

        /*
         * Classify before masking. This used to emit the generic "provider
         * request failed" text for every exception, so a NoSuchToolError — a
         * model/tool-registration mismatch we can act on — looked like an API key
         * problem. The user-visible text stays safe either way.
         */
        const safeMessage = toSafeStreamErrorMessage(error);

        reader.releaseLock();
        controller.enqueue(encoder.encode(safeMessage));
        controller.close();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/** Returns a fixed client-safe token-limit response. */
export function toTokenLimitError(provider: string): ApiError {
  return new ApiError(
    'Token limit exceeded. Try reducing your request size or using a model with higher token limits.',
    {
      status: 400,
      code: 'token_limit_exceeded',
      isRetryable: false,
      provider,
    },
  );
}

/** Identifies provider token-limit diagnostics without forwarding their text. */
export function isTokenLimitFailure(error: unknown): error is Error {
  if (!(error instanceof Error) || isTypedFailure(error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  return (
    /\bmax[_ -]?tokens?\b/.test(message) ||
    /\btoken\s+limit\s+(?:exceeded|exceeds|reached)\b/.test(message) ||
    /\b(?:maximum|max)\s+context\s+length\b/.test(message) ||
    /\bcontext\s+length\b.{0,40}\b(?:exceed(?:ed|s)?|maximum|limit)\b/.test(message) ||
    /\btoo\s+many\s+tokens\b/.test(message) ||
    /\brequested\s+tokens\b.{0,40}\b(?:exceed(?:ed|s)?|maximum|limit)\b/.test(message)
  );
}

function isTypedFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && 'status' in error;
}

/**
 * Builds the failure response for a caught error.
 *
 * Deliberately does not echo the raw error message for unexpected errors: a
 * thrown Error from deep inside the provider SDK can contain the request URL,
 * which for several providers embeds the key in a query string. Known ApiErrors
 * carry their own vetted message; anything else becomes a generic string.
 */
export function toApiErrorResponse(error: unknown, fallbackProvider = 'unknown'): Response {
  if (error instanceof ApiError) {
    return Response.json(
      {
        error: true,
        message: error.message,
        statusCode: error.status,
        isRetryable: error.isRetryable,
        provider: error.provider ?? fallbackProvider,
      } satisfies ApiErrorBody,
      { status: error.status, headers: { 'Content-Type': 'application/json' } },
    );
  }

  /*
   * Aborts surface as a generic 500 everywhere else, which makes a user pressing
   * "stop" look like a server fault. 499 is the conventional client-closed code
   * and is not retryable.
   */
  if (isAbortError(error)) {
    return Response.json(
      {
        error: true,
        message: 'Request cancelled.',
        statusCode: 499,
        isRetryable: false,
        provider: fallbackProvider,
      } satisfies ApiErrorBody,
      { status: 499, headers: { 'Content-Type': 'application/json' } },
    );
  }

  logger.error('Unhandled route error');

  return Response.json(
    {
      error: true,
      message: 'An unexpected error occurred',
      statusCode: 500,
      isRetryable: true,
      provider: fallbackProvider,
    } satisfies ApiErrorBody,
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  );
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.code === 'client_closed_request';
  }

  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }

  return `${Math.round(bytes / 1024)} KB`;
}
