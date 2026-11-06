import { useState } from 'react';
import { Link, Navigate, useLoaderData, useSearchParams } from 'react-router';
import type { LoaderFunctionArgs, MetaFunction } from 'react-router';
import { AuthField, AuthLayout, AuthMessage, useAuthSubmit } from '~/components/auth/AuthLayout';
import { getUser } from '~/lib/auth-guard';

export const meta: MetaFunction = () => [{ title: 'Sign in — Koadr' }];

export async function loader({ context }: LoaderFunctionArgs) {
  // Someone who already has a session has no business on the login page.
  return { signedIn: Boolean(getUser(context)) };
}

export default function LoginRoute() {
  const { signedIn } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { pending, error, setError, submit } = useAuthSubmit();
  const [notice, setNotice] = useState(linkError(searchParams.get('error')));

  if (signedIn) {
    return <Navigate to={returnTo} replace />;
  }

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setNotice('');

    const result = await submit({ action: 'login', email, password });

    if (result.ok) {
      // Full reload so the server sees the new session cookie on the next load.
      window.location.assign(returnTo);
    }
  }

  async function handleMagicLink() {
    setNotice('');

    if (!email) {
      setError('Enter your email first, then request a magic link.');
      return;
    }

    const result = await submit({ action: 'magic-link', email });

    if (result.ok) {
      setNotice('Check your inbox for a sign-in link.');
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Your chats and settings follow you across devices."
      footer={
        <>
          No account?{' '}
          <Link to="/signup" className="text-accent-500 hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={handleLogin}>
        <AuthMessage error={error} notice={notice} />
        <AuthField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
        <AuthField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <button
          type="submit"
          disabled={pending}
          className="mt-2 w-full rounded-md bg-accent-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="mt-4 flex items-center justify-between text-sm">
        <button type="button" onClick={handleMagicLink} className="text-bolt-elements-textSecondary hover:underline">
          Email me a magic link
        </button>
        <Link to="/forgot-password" className="text-bolt-elements-textSecondary hover:underline">
          Forgot password?
        </Link>
      </div>
    </AuthLayout>
  );
}

/** Only allow same-origin, absolute-path redirects. */
export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return '/';
  }

  return value;
}

function linkError(code: string | null): string {
  if (!code) {
    return '';
  }

  return code === 'missing_code' ? 'That link is invalid or has expired. Please sign in again.' : code;
}
