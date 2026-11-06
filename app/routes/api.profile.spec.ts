import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Route tests for /api/profile: identity is what the sidebar shows, so the
 * email fallback and the validation rules are worth pinning.
 */

const db = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
const pgQuery = vi.fn();

vi.mock('~/lib/.server/supabase', () => ({
  getSupabaseSession: async () => ({ client: { from: () => db }, headers: new Headers(), user: null }),
}));

vi.mock('~/lib/.server/pg', () => ({
  getPgPool: () => ({ query: pgQuery }),
}));

const { loader, action } = await import('./api.profile');

const user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'ilias@example.com' };

async function call(fn: any, args: unknown): Promise<Response> {
  try {
    return (await fn(args)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) {
      return thrown;
    }

    throw thrown;
  }
}

function request(method: string, body?: unknown) {
  return new Request('https://koadr.dev/api/profile', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.select.mockReturnValue(db);
  db.eq.mockReturnValue(db);
  db.maybeSingle.mockResolvedValue({ data: null, error: null });
  pgQuery.mockResolvedValue({ rowCount: 1 });
});

describe('/api/profile', () => {
  it('rejects anonymous reads', async () => {
    const response = await call(loader, { request: request('GET'), params: {}, context: { user: null } });

    expect(response.status).toBe(401);
  });

  it('returns the email even when no username was chosen', async () => {
    pgQuery.mockResolvedValue({ rows: [{ username: null, avatar_url: null, onboarding_completed_at: null }] });

    const response = await call(loader, { request: request('GET'), params: {}, context: { user } });
    const json = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);

    // This is the fallback the sidebar needs: a signed-in user is never "Guest".
    expect(json.profile.email).toBe('ilias@example.com');
    expect(json.profile.username).toBeNull();
  });

  it('returns the stored username and avatar', async () => {
    pgQuery.mockResolvedValue({
      rows: [
        {
          username: 'ilias',
          avatar_url: 'data:image/png;base64,xx',
          onboarding_completed_at: '2026-11-06T00:00:00Z',
        },
      ],
    });

    const response = await call(loader, { request: request('GET'), params: {}, context: { user } });
    const json = (await response.json()) as Record<string, any>;

    expect(json.profile.username).toBe('ilias');
    expect(json.profile.onboardingCompleted).toBe(true);
    expect(json.profile.avatar).toBe('data:image/png;base64,xx');
  });

  it('reports onboarding as not completed for a fresh account', async () => {
    pgQuery.mockResolvedValue({ rows: [{ username: null, avatar_url: null, onboarding_completed_at: null }] });

    const response = await call(loader, { request: request('GET'), params: {}, context: { user } });
    const json = (await response.json()) as Record<string, any>;

    expect(json.profile.onboardingCompleted).toBe(false);
  });

  it('rejects anonymous writes', async () => {
    const response = await call(action, {
      request: request('POST', { username: 'x' }),
      params: {},
      context: { user: null },
    });

    expect(response.status).toBe(401);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('rejects a username with invalid characters', async () => {
    const response = await call(action, {
      request: request('POST', { username: 'bad name!' }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(400);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('rejects a single-character username', async () => {
    const response = await call(action, {
      request: request('POST', { username: 'a' }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(400);
  });

  it('accepts clearing the username, which falls back to the email', async () => {
    const response = await call(action, {
      request: request('POST', { username: '' }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(200);
    expect(pgQuery).toHaveBeenCalled();
  });

  it('saves a valid username', async () => {
    const response = await call(action, {
      request: request('POST', { username: 'ilias.g' }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(200);

    const [sql, params] = pgQuery.mock.calls[0];

    expect(sql).toContain('update public.profiles');
    expect(params[0]).toBe(user.id);
    expect(params[1]).toBe('ilias.g');
  });

  it('maps a duplicate username to 409', async () => {
    pgQuery.mockRejectedValue(new Error('duplicate key value violates unique constraint "profiles_username_key"'));

    const response = await call(action, {
      request: request('POST', { username: 'taken' }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(409);
  });

  it('rejects an oversized avatar', async () => {
    const response = await call(action, {
      request: request('POST', { avatar: 'x'.repeat(400_001) }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(400);
  });

  it('rejects an empty update', async () => {
    const response = await call(action, { request: request('POST', {}), params: {}, context: { user } });

    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const response = await call(action, { request: request('POST', 'nope'), params: {}, context: { user } });

    expect(response.status).toBe(400);
  });
});
