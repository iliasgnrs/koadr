import { useState } from 'react';
import { Link, useLoaderData } from 'react-router';
import type { LoaderFunctionArgs, MetaFunction } from 'react-router';
import { AuthField, AuthLayout, AuthMessage, useAuthSubmit } from '~/components/auth/AuthLayout';
import { getUser } from '~/lib/auth-guard';

export const meta: MetaFunction = () => [{ title: 'Choose a new password — Koadr' }];

export async function loader({ context }: LoaderFunctionArgs) {
  /*
   * Reaching this page requires a session: the recovery link is exchanged for
   * one by /auth/callback before redirecting here. Without it there is nothing
   * to update, so send the user back to request a fresh link.
   */
  return { signedIn: Boolean(getUser(context)) };
}

export default function ResetPasswordRoute() {
  const { signedIn } = useLoaderData<typeof loader>();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { pending, error, setError, submit } = useAuthSubmit();
  const [done, setDone] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    const result = await submit({ action: 'reset-password', password });

    if (result.ok) {
      setDone(true);
    }
  }

  if (!signedIn) {
    return (
      <AuthLayout title="Link expired" subtitle="Reset links can only be used once.">
        <Link to="/forgot-password" className="text-accent-500 hover:underline">
          Request a new link
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      {done ? (
        <p className="text-sm text-bolt-elements-textSecondary">
          Password updated.{' '}
          <Link to="/" className="text-accent-500 hover:underline">
            Continue to Koadr
          </Link>
        </p>
      ) : (
        <form onSubmit={handleSubmit}>
          <AuthMessage error={error} />
          <AuthField
            label="New password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
          <AuthField
            label="Confirm new password"
            type="password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
          />
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-accent-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {pending ? 'Updating…' : 'Update password'}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
