import { useState } from 'react';
import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { AuthField, AuthLayout, AuthMessage, AuthSubmitButton, useAuthSubmit } from '~/components/auth/AuthLayout';

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
        <Link
          to="/login"
          className="rounded-sm font-medium text-accent-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-accent-300"
        >
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
          <AuthSubmitButton pending={pending} pendingLabel="Sending…">
            Send reset link
          </AuthSubmitButton>
        </form>
      )}
    </AuthLayout>
  );
}
