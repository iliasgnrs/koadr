import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The chat box cannot read a stored key back (keys are write-only), so it asks
 * this route whether one exists. Only the masked hint may cross the wire.
 */

const pgQuery = vi.fn();

vi.mock('~/lib/.server/pg', () => ({
  getPgPool: () => ({ query: pgQuery }),
}));

const { loader } = await import('./api.settings.keys');

const user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'a@example.com' };

async function call(args: unknown): Promise<Response> {
  try {
    return (await loader(args as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) {
      return thrown;
    }

    throw thrown;
  }
}

function request(query: string) {
  return new Request(`https://koadr.dev/api/settings/keys${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/api/settings/keys loader', () => {
  it('rejects anonymous reads with 401', async () => {
    const response = await call({ request: request('?provider=Deepseek'), context: { user: null } });

    expect(response.status).toBe(401);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('reports a configured provider with its hint and no key', async () => {
    pgQuery.mockResolvedValue({ rows: [{ provider: 'Deepseek', hint: '…abcd', updated_at: 'x' }] });

    const response = await call({ request: request('?provider=Deepseek'), context: { user } });
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, configured: true, hint: '…abcd' });
    expect(pgQuery.mock.calls[0][1]).toEqual([user.id]);
  });

  it('reports a provider the account has no key for', async () => {
    pgQuery.mockResolvedValue({ rows: [] });

    const response = await call({ request: request('?provider=Deepseek'), context: { user } });

    expect(await response.json()).toEqual({ ok: true, configured: false, hint: null });
  });

  it('still lists every provider summary without a query', async () => {
    pgQuery.mockResolvedValue({ rows: [{ provider: 'OpenAI', hint: '…1234', updated_at: 'x' }] });

    const response = await call({ request: request(''), context: { user } });

    expect(await response.json()).toEqual({
      ok: true,
      keys: [{ provider: 'OpenAI', hint: '…1234', updated_at: 'x' }],
    });
  });
});
