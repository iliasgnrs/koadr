import { describe, expect, it } from 'vitest';
import { getUser, requireApiUser, requireUser } from './auth-guard';

const user = { id: '11111111-1111-1111-1111-111111111111', email: 'a@example.com' };

function request(path = '/'): Request {
  return new Request(`https://koadr.dev${path}`);
}

describe('auth guard', () => {
  it('treats a missing context as signed out', () => {
    expect(getUser(undefined)).toBeNull();
    expect(getUser({})).toBeNull();
    expect(getUser({ user: null })).toBeNull();
  });

  it('returns the resolved user untouched', () => {
    expect(getUser({ user })).toEqual(user);
  });

  it('redirects a page load to /login and preserves the target', () => {
    let thrown: unknown;

    try {
      requireUser({ user: null }, request('/chat/abc?x=1'));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);

    const response = thrown as Response;

    expect(response.status).toBe(302);

    const location = response.headers.get('Location') ?? '';

    expect(location).toContain('/login');
    expect(location).toContain(`returnTo=${encodeURIComponent('/chat/abc?x=1')}`);
  });

  it('does not add a returnTo when already heading to the root', () => {
    let thrown: unknown;

    try {
      requireUser({ user: null }, request('/'));
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Response).headers.get('Location')).toBe('/login');
  });

  it('lets a signed-in user through', () => {
    expect(requireUser({ user }, request('/'))).toEqual(user);
  });

  it('answers API callers with 401 instead of an HTML redirect', () => {
    let thrown: unknown;

    try {
      requireApiUser({ user: null });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });

  it('lets a signed-in caller into an API route', () => {
    expect(requireApiUser({ user })).toEqual(user);
  });
});
