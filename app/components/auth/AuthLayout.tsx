import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

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
    <div className="flex min-h-full w-full items-center justify-center bg-bolt-elements-background-depth-1 p-4">
      <div className="w-full max-w-sm">
        <Link to="/login" className="mb-8 flex justify-center" aria-label="Koadr">
          <img src="/logo-light-styled.png" alt="Koadr" className="w-[110px] dark:hidden" />
          <img src="/logo-dark-styled.png" alt="Koadr" className="hidden w-[110px] dark:block" />
        </Link>
        <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-6">
          <h1 className="text-lg font-semibold text-bolt-elements-textPrimary">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-bolt-elements-textSecondary">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-bolt-elements-textSecondary">{footer}</div>}
      </div>
    </div>
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
      <span className="mb-1 block text-sm text-bolt-elements-textSecondary">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
        className="w-full rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-2 text-sm text-bolt-elements-textPrimary outline-none focus:ring-2 focus:ring-bolt-elements-focus"
      />
    </label>
  );
}

export function AuthMessage({ error, notice }: { error?: string; notice?: string }) {
  if (error) {
    return (
      <p role="alert" className="mb-3 rounded-md bg-bolt-elements-icon-errorBackground px-3 py-2 text-sm text-red-500">
        {error}
      </p>
    );
  }

  if (notice) {
    return (
      <p className="mb-3 rounded-md bg-bolt-elements-background-depth-3 px-3 py-2 text-sm text-bolt-elements-textSecondary">
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
