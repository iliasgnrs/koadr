import { useState } from 'react';
import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { AuthField, AuthLayout, AuthMessage, useAuthSubmit } from '~/components/auth/AuthLayout';

export const meta: MetaFunction = () => [{ title: 'Reset password — Koadr' }];

export default function ForgotPasswordRoute() {
  const [email, setEmail] = useState('');
  const { pending, error, submit } = useAuthSubmit();
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const result = await submit({ action: 'forgot-password', email });

    if (result.ok) {
      setSent(true);
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We'll email you a link to choose a new one."
      footer={
        <Link to="/login" className="text-accent-500 hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <p className="text-sm text-bolt-elements-textSecondary">
          If an account exists for {email}, a reset link is on its way.
        </p>
      ) : (
        <form onSubmit={handleSubmit}>
          <AuthMessage error={error} />
          <AuthField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-accent-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {pending ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
