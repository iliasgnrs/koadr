import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AuthParticles } from './AuthParticles';

/*
 * Shared shell for the auth pages.
 *
 * These routes deliberately do not render the app header or sidebar: there is no
 * session yet, and mounting the chat chrome would start its stores (and its
 * network calls) before the user is signed in.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-full w-full items-center justify-center bg-bolt-elements-background-depth-1 p-4">
      <AuthParticles />
      <div className="relative z-10 w-full max-w-sm">
        <Link to="/login" className="mb-8 flex flex-col items-center gap-3" aria-label="Koadr home">
          {/* The source art is 5:1, so the height is set to keep the wordmark crisp at this size. */}
          <img src="/logo-light-styled.png" alt="Koadr" className="h-9 w-auto dark:hidden" />
          <img src="/logo-dark-styled.png" alt="Koadr" className="hidden h-9 w-auto dark:block" />
        </Link>
        <div className="rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2/80 p-6 shadow-2xl backdrop-blur-xl">
          <h1 className="text-lg font-semibold text-bolt-elements-textPrimary">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-bolt-elements-textSecondary">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-bolt-elements-textSecondary">{footer}</div>}
      </div>
    </div>
  );
}

/** Text-style secondary action: no UA button chrome, normalised colour and focus ring. */
export function AuthTextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm bg-transparent p-0 font-inherit text-bolt-elements-textSecondary transition-colors hover:text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
    >
      {children}
    </button>
  );
}

/*
 * White on Koadr orange is only 2.9:1, so accent CTAs use the near-black brand
 * ink instead (5.4–6.1:1 across the whole accent-intensity range).
 */
export function AuthSubmitButton({
  pending,
  pendingLabel,
  children,
}: {
  pending: boolean;
  pendingLabel: string;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-2 w-full rounded-md bg-accent-500 px-3 py-2 text-sm font-semibold text-[#1A1A1A] transition hover:bg-accent-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-300 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-2 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

export function AuthField({
  label,
  type = 'text',
  value,
  onChange,
  autoComplete,
  required = true,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-sm font-medium text-bolt-elements-textSecondary">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
        className="w-full rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-2 text-sm text-bolt-elements-textPrimary outline-none transition placeholder:text-bolt-elements-textTertiary focus:border-accent-500 focus:ring-2 focus:ring-accent-500/40"
      />
    </label>
  );
}

export function AuthMessage({ error, notice }: { error?: string; notice?: string }) {
  if (error) {
    return (
      <p
        role="alert"
        className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500 dark:text-red-300"
      >
        {error}
      </p>
    );
  }

  if (notice) {
    return (
      <p className="mb-3 rounded-md border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-bolt-elements-textSecondary">
        {notice}
      </p>
    );
  }

  return null;
}

export type AuthResult = { ok: true; data?: Record<string, unknown> } | { ok: false; error: string };

/** POSTs to the server-side auth route; the session cookie is set there. */
export async function postAuth(payload: Record<string, unknown>): Promise<AuthResult> {
  try {
    const response = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
    });

    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };

    if (!response.ok || !data.ok) {
      return { ok: false, error: data.error || 'Something went wrong. Please try again.' };
    }

    return { ok: true, data: data as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'Network error. Check your connection and try again.' };
  }
}

/** Shared pending/error handling so every page reports state the same way. */
export function useAuthSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(payload: Record<string, unknown>): Promise<AuthResult> {
    setPending(true);
    setError('');

    const result = await postAuth(payload);

    setPending(false);

    if (!result.ok) {
      setError(result.error);
    }

    return result;
  }

  return { pending, error, setError, submit };
}
