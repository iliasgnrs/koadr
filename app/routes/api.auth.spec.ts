import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Route-level tests for /api/auth.
 *
 * The guard tests covered the wrong layer: all three bugs that shipped to
 * production lived in this route's request/response handling, not in the guard.
 * These tests pin the behaviour that actually broke:
 *
 *   - the session cookies must be copied onto the response (or the browser never
 *     gets a session and every request looks anonymous);
 *   - the body must be read from a clone (React Router consumes the original);
 *   - failures must map to the right status, and must not leak whether an email
 *     address is registered.
 */

const auth = {
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOtp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
};

const sessionHeaders = vi.fn();

vi.mock('~/lib/.server/supabase', () => ({
  getSupabaseSession: async () => ({ client: { auth }, headers: sessionHeaders(), user: null }),
}));

const { action, loader } = await import('./api.auth');

function post(body: unknown, raw = false): Request {
  return new Request('https://koadr.dev/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

async function run(body: unknown, raw = false) {
  const response = (await action({ request: post(body, raw), params: {}, context: {} } as never)) as Response;

  return { response, json: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionHeaders.mockReturnValue(new Headers());
  auth.signUp.mockResolvedValue({ error: null });
  auth.signInWithPassword.mockResolvedValue({ error: null });
  auth.signInWithOtp.mockResolvedValue({ error: null });
  auth.resetPasswordForEmail.mockResolvedValue({ error: null });
  auth.updateUser.mockResolvedValue({ error: null });
  auth.signOut.mockResolvedValue({ error: null });
});

describe('/api/auth', () => {
  it('rejects an unparseable body without calling Supabase', async () => {
    const { response, json } = await run('not json', true);

    expect(response.status).toBe(400);
    expect(json.error).toBe('Invalid request body');
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('signs a user up and reports that verification still applies', async () => {
    const { response, json } = await run({ action: 'signup', email: 'A@Example.COM ', password: 'longenough' });

    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, needsVerification: true });

    // Email is normalised before it reaches Supabase.
    expect(auth.signUp).toHaveBeenCalledWith({ email: 'a@example.com', password: 'longenough' });
  });

  it('copies session cookies onto the response', async () => {
    const headers = new Headers();

    headers.append('Set-Cookie', 'sb-access-token=abc; HttpOnly; Secure');
    headers.append('Set-Cookie', 'sb-refresh-token=def; HttpOnly; Secure');
    sessionHeaders.mockReturnValue(headers);

    const { response } = await run({ action: 'login', email: 'a@example.com', password: 'longenough' });

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([
      'sb-access-token=abc; HttpOnly; Secure',
      'sb-refresh-token=def; HttpOnly; Secure',
    ]);
  });

  it('rejects a short password before calling Supabase', async () => {
    const { response } = await run({ action: 'signup', email: 'a@example.com', password: 'short' });

    expect(response.status).toBe(400);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('requires an email for signup', async () => {
    const { response } = await run({ action: 'signup', email: '  ', password: 'longenough' });

    expect(response.status).toBe(400);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('maps a failed login to 401', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } });

    const { response, json } = await run({ action: 'login', email: 'a@example.com', password: 'wrongpass' });

    expect(response.status).toBe(401);
    expect(json.error).toBe('Invalid login credentials');
  });

  it('always reports success for forgot-password, even when the address is unknown', async () => {
    /*
     * Supabase returns an error object for unknown addresses; the route must not
     * pass that on, or it becomes an account-enumeration oracle.
     */
    auth.resetPasswordForEmail.mockResolvedValue({ error: null });

    const { response, json } = await run({ action: 'forgot-password', email: 'nobody@example.com' });

    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('nobody@example.com', expect.any(Object));
  });

  it('requires a session for reset-password', async () => {
    auth.updateUser.mockResolvedValue({ error: { message: 'Auth session missing!', status: 401 } });

    const { response } = await run({ action: 'reset-password', password: 'longenough' });

    expect(response.status).toBe(401);
  });

  it('logs out and still returns ok when Supabase errors softly', async () => {
    auth.signOut.mockResolvedValue({ error: { message: 'token revoked', status: 400 } });

    const { response, json } = await run({ action: 'logout' });

    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true });
  });

  it('surfaces a hard logout failure', async () => {
    auth.signOut.mockResolvedValue({ error: { message: 'upstream down', status: 503 } });

    const { response } = await run({ action: 'logout' });

    expect(response.status).toBe(500);
  });

  it('rejects an unknown action', async () => {
    const { response } = await run({ action: 'delete-everything' });

    expect(response.status).toBe(400);
  });

  it('answers GET with 405', async () => {
    const response = (await loader()) as Response;

    expect(response.status).toBe(405);
  });
});
