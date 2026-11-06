import { useState } from 'react';
import { Link, Navigate, useLoaderData, useSearchParams } from 'react-router';
import type { LoaderFunctionArgs, MetaFunction } from 'react-router';
import { safeReturnTo } from './login';
import { AuthField, AuthLayout, AuthMessage, useAuthSubmit } from '~/components/auth/AuthLayout';
import { getUser } from '~/lib/auth-guard';

export const meta: MetaFunction = () => [{ title: 'Create account — Koadr' }];

export async function loader({ context }: LoaderFunctionArgs) {
  return { signedIn: Boolean(getUser(context)) };
}

export default function SignupRoute() {
  const { signedIn } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { pending, error, setError, submit } = useAuthSubmit();
  const [notice, setNotice] = useState('');

  if (signedIn) {
    return <Navigate to={returnTo} replace />;
  }

  async function handleSignup(event: React.FormEvent) {
    event.preventDefault();
    setNotice('');

    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    const result = await submit({ action: 'signup', email, password });

    if (!result.ok) {
      return;
    }

    /*
     * With mail confirmation on, signUp() returns no session — the user has to
     * click the emailed link. With it off (local testing), Supabase returns a
     * session immediately and the cookie is already set.
     */
    setNotice('Account created. Check your inbox to confirm your email, then sign in.');
  }

  return (
    <AuthLayout
      title="Create your account"
      footer={
        <>
          Already have one?{' '}
          <Link to="/login" className="text-accent-500 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSignup}>
        <AuthMessage error={error} notice={notice} />
        <AuthField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
        <AuthField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />
        <AuthField
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />
        <p className="mb-3 text-xs text-bolt-elements-textTertiary">At least 8 characters.</p>
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-accent-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  );
}
