import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The connection route must never hand a token back to the browser: the loader
 * returns summaries only, and a write without a token must not erase the stored
 * credential (the server merges it).
 */

const store = {
  listConnections: vi.fn(),
  saveConnection: vi.fn(),
  deleteConnection: vi.fn(),
  isConnectionProvider: (value: unknown) =>
    ['github', 'gitlab', 'netlify', 'vercel', 'supabase'].includes(String(value)),
};

vi.mock('~/lib/.server/connections', () => store);

const { loader, action } = await import('./api.connections');

const user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'a@example.com' };

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
  return new Request('https://koadr.dev/api/connections', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.listConnections.mockResolvedValue({ github: { user: { login: 'octo' } } });
  store.saveConnection.mockResolvedValue(undefined);
  store.deleteConnection.mockResolvedValue(undefined);
});

describe('/api/connections', () => {
  it('requires a session', async () => {
    const response = await call(loader, { request: request('GET'), params: {}, context: { user: null } });

    expect(response.status).toBe(401);
  });

  it('returns the stored summaries', async () => {
    const response = await call(loader, { request: request('GET'), params: {}, context: { user } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, connections: { github: { user: { login: 'octo' } } } });
  });

  it('rejects an unknown provider', async () => {
    const response = await call(action, {
      request: request('POST', { provider: 'bitbucket', connection: { token: 'x' } }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(400);
    expect(store.saveConnection).not.toHaveBeenCalled();
  });

  it('writes only scalar fields under the session profile', async () => {
    await call(action, {
      request: request('POST', { provider: 'gitlab', connection: { token: 'glpat', nested: { a: 1 }, n: 2 } }),
      params: {},
      context: { user },
    });

    expect(store.saveConnection).toHaveBeenCalledWith(user.id, 'gitlab', { token: 'glpat', n: 2 });
  });

  it('deletes by provider', async () => {
    const response = await call(action, {
      request: request('DELETE', { provider: 'vercel' }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(200);
    expect(store.deleteConnection).toHaveBeenCalledWith(user.id, 'vercel');
  });
});
