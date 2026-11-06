import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Route tests for /api/chats, for the same reason /api/auth has them: the bugs
 * that reach production live in the route, not in the pure helpers.
 */

const store = {
  listChats: vi.fn(),
  upsertChat: vi.fn(),
  deleteChat: vi.fn(),
};

vi.mock('~/lib/.server/chats', async () => {
  // Keep the real error class so `instanceof` works across the mock boundary.
  const actual = await vi.importActual<typeof import('~/lib/.server/chats')>('~/lib/.server/chats');

  return { ...store, ChatOwnershipError: actual.ChatOwnershipError };
});

const { loader, action } = await import('./api.chats');

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
  return new Request('https://koadr.dev/api/chats', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.listChats.mockResolvedValue([]);
  store.upsertChat.mockResolvedValue(undefined);
  store.deleteChat.mockResolvedValue(undefined);
});

describe('/api/chats', () => {
  it('rejects anonymous reads', async () => {
    const response = await call(loader, { request: request('GET'), params: {}, context: { user: null } });

    expect(response.status).toBe(401);
    expect(store.listChats).not.toHaveBeenCalled();
  });

  it('lists the chats for the session user', async () => {
    store.listChats.mockResolvedValue([{ id: 'c1', messages: [], timestamp: '2026-11-06T00:00:00Z' }]);

    const response = await call(loader, { request: request('GET'), params: {}, context: { user } });
    const json = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(json.chats).toHaveLength(1);
    expect(store.listChats).toHaveBeenCalledWith(user.id);
  });

  it('rejects anonymous writes', async () => {
    const response = await call(action, {
      request: request('POST', { chat: { id: 'c1', messages: [] } }),
      params: {},
      context: { user: null },
    });

    expect(response.status).toBe(401);
    expect(store.upsertChat).not.toHaveBeenCalled();
  });

  it('saves a chat under the session profile, ignoring any claimed owner', async () => {
    const response = await call(action, {
      request: request('POST', {
        chat: { id: 'c1', messages: [{ id: 'm1', role: 'user' }], profile_id: 'someone-else' },
      }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(200);
    expect(store.upsertChat).toHaveBeenCalledWith(user.id, expect.objectContaining({ id: 'c1' }));
  });

  it('rejects a chat without an id', async () => {
    const response = await call(action, {
      request: request('POST', { chat: { messages: [] } }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(400);
    expect(store.upsertChat).not.toHaveBeenCalled();
  });

  it('rejects a non-array message list', async () => {
    const response = await call(action, {
      request: request('POST', { chat: { id: 'c1', messages: 'nope' } }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(400);
  });

  it('answers 409 instead of a silent success when the id belongs to another account', async () => {
    const chatsModule = await vi.importActual<typeof import('~/lib/.server/chats')>('~/lib/.server/chats');

    store.upsertChat.mockRejectedValue(new chatsModule.ChatOwnershipError());

    const response = await call(action, {
      request: request('POST', { chat: { id: 'taken', messages: [] } }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(409);
  });

  it('refuses an absurdly large chat instead of issuing one huge insert', async () => {
    const messages = Array.from({ length: 2001 }, (_, i) => ({ id: `m${i}`, role: 'user' }));

    const response = await call(action, {
      request: request('POST', { chat: { id: 'c1', messages } }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(400);
    expect(store.upsertChat).not.toHaveBeenCalled();
  });

  it('deletes a chat', async () => {
    const response = await call(action, {
      request: request('DELETE', { id: 'c1' }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(200);
    expect(store.deleteChat).toHaveBeenCalledWith(user.id, 'c1');
  });

  it('requires an id to delete', async () => {
    const response = await call(action, { request: request('DELETE', {}), params: {}, context: { user } });

    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const response = await call(action, { request: request('POST', 'not json'), params: {}, context: { user } });

    expect(response.status).toBe(400);
  });

  it('turns a storage failure into a 500 without leaking detail', async () => {
    store.upsertChat.mockRejectedValue(new Error('connection refused'));

    const response = await call(action, {
      request: request('POST', { chat: { id: 'c1', messages: [] } }),
      params: {},
      context: { user },
    });

    expect(response.status).toBe(500);
  });
});
