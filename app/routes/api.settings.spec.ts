import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INTERFACE_OPTIONS } from '~/lib/settings-sync';

/*
 * Route-level tests for /api/settings.
 *
 * Slice 1 shipped broken because only the guard was tested, so the route's own
 * request/response behaviour is pinned here: who is allowed through, which
 * payloads are rejected, and what shape goes to Supabase.
 */

const db = {
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
  upsert: vi.fn(),
};

vi.mock('~/lib/.server/supabase', () => ({
  getSupabaseSession: async () => ({ client: { from: () => db }, headers: new Headers(), user: null }),
}));

const { loader, action } = await import('./api.settings');

type SessionUser = { id: string; email: string };

const user: SessionUser = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'a@example.com' };

function req(body?: unknown) {
  return new Request('https://koadr.dev/api/settings', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/*
 * `requireApiUser` throws a Response rather than returning one. React Router
 * turns a thrown Response into the response, so production is correct — but a
 * direct call has to catch it here to observe the same thing.
 */
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

async function runLoader(signedIn: SessionUser | null) {
  const response = await call(loader, { request: req(), params: {}, context: { user: signedIn } });

  return { response, json: (await response.json()) as Record<string, any> };
}

async function runAction(signedIn: SessionUser | null, body: unknown) {
  const response = await call(action, { request: req(body), params: {}, context: { user: signedIn } });

  return { response, json: (await response.json()) as Record<string, any> };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.select.mockReturnValue(db);
  db.eq.mockReturnValue(db);
  db.maybeSingle.mockResolvedValue({ data: null, error: null });
  db.upsert.mockResolvedValue({ error: null });
});

describe('/api/settings', () => {
  it('rejects anonymous reads with 401', async () => {
    const { response } = await runLoader(null);

    expect(response.status).toBe(401);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns null settings when the account has no row yet', async () => {
    const { response, json } = await runLoader(user);

    expect(response.status).toBe(200);
    expect(json.settings).toBeNull();
    expect(db.eq).toHaveBeenCalledWith('profile_id', user.id);
  });

  it('normalises the stored interface options on read', async () => {
    db.maybeSingle.mockResolvedValue({
      data: {
        theme: 'dark-ocean-depths',
        interface_options: { accentIntensity: 90 },
        updated_at: '2026-11-06T00:00:00Z',
      },
      error: null,
    });

    const { json } = await runLoader(user);

    expect(json.settings.theme).toBe('dark-ocean-depths');

    // Missing fields are filled from defaults, so the client never sees a partial object.
    expect(json.settings.interfaceOptions.cornerRadius).toBe(DEFAULT_INTERFACE_OPTIONS.cornerRadius);
    expect(json.settings.interfaceOptions.accentIntensity).toBe(90);
  });

  it('surfaces a database read error as 500', async () => {
    db.maybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const { response } = await runLoader(user);

    expect(response.status).toBe(500);
  });

  it('rejects anonymous writes with 401', async () => {
    const { response } = await runAction(null, { theme: 'light' });

    expect(response.status).toBe(401);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unknown theme instead of persisting it', async () => {
    const { response } = await runAction(user, { theme: 'dark-does-not-exist' });

    expect(response.status).toBe(400);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('upserts with the session profile id and a fresh timestamp', async () => {
    const { response } = await runAction(user, {
      theme: 'dark',
      interfaceOptions: { accentIntensity: 70 },
    });

    expect(response.status).toBe(200);

    const [row, options] = db.upsert.mock.calls[0];

    expect(options).toEqual({ onConflict: 'profile_id' });
    expect(row.profile_id).toBe(user.id);
    expect(row.theme).toBe('dark');
    expect(row.interface_options.accentIntensity).toBe(70);
    expect(typeof row.updated_at).toBe('string');
  });

  it('never accepts a profile id from the request body', async () => {
    const attacker = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    await runAction(user, { theme: 'light', profile_id: attacker });

    // RLS would block this anyway, but the route must not even offer it.
    expect(db.upsert.mock.calls[0][0].profile_id).toBe(user.id);
  });

  it('persists the sanitized provider map with the rest of the row', async () => {
    const { response } = await runAction(user, {
      theme: 'light',
      providerSettings: {
        OpenAI: { settings: { enabled: true, models: ['runtime-only'] } },
        Anthropic: { settings: { enabled: false } },
      },
    });

    expect(response.status).toBe(200);
    expect(db.upsert.mock.calls[0][0].provider_settings).toEqual({
      OpenAI: { settings: { enabled: true } },
      Anthropic: { settings: { enabled: false } },
    });
  });

  it('rejects a provider map with invalid keys', async () => {
    const { response } = await runAction(user, { providerSettings: { 'bad name!': { settings: {} } } });

    expect(response.status).toBe(400);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('returns the stored provider map on read', async () => {
    db.maybeSingle.mockResolvedValue({
      data: {
        theme: 'light',
        interface_options: null,
        provider_settings: { OpenAI: { settings: { enabled: true } } },
        updated_at: 'x',
      },
      error: null,
    });

    const { json } = await runLoader(user);

    expect(json.settings.providerSettings).toEqual({ OpenAI: { settings: { enabled: true } } });
  });

  it('rejects malformed JSON', async () => {
    const response = await call(action, {
      request: new Request('https://koadr.dev/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(400);
  });
});
