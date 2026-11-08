import { useState } from 'react';
import { Link, Navigate, useLoaderData, useSearchParams } from 'react-router';
import type { LoaderFunctionArgs, MetaFunction } from 'react-router';
import {
  AuthField,
  AuthLayout,
  AuthMessage,
  AuthSubmitButton,
  AuthTextButton,
  useAuthSubmit,
} from '~/components/auth/AuthLayout';
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
          <Link
            to="/signup"
            className="rounded-sm font-medium text-accent-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-accent-300"
          >
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
        <AuthSubmitButton pending={pending} pendingLabel="Signing in…">
          Sign in
        </AuthSubmitButton>
      </form>

      <div className="mt-4 flex items-center justify-between text-sm">
        <AuthTextButton onClick={handleMagicLink}>Email me a magic link</AuthTextButton>
        <Link
          to="/forgot-password"
          className="rounded-sm text-bolt-elements-textSecondary transition-colors hover:text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
        >
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
