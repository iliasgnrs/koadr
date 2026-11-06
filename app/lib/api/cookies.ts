export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function parseCookies(cookieHeader: string | null) {
  const cookies: Record<string, string> = {};

  if (!cookieHeader) {
    return cookies;
  }

  // Split the cookie string by semicolons and spaces
  const items = cookieHeader.split(';').map((cookie) => cookie.trim());

  items.forEach((item) => {
    const [name, ...rest] = item.split('=');

    if (name && rest.length > 0) {
      try {
        // Decode the name and value, and join value parts in case it contains '='
        const decodedName = decodeURIComponent(name.trim());
        const decodedValue = decodeURIComponent(rest.join('=').trim());
        cookies[decodedName] = decodedValue;
      } catch {
        cookies[name.trim()] = rest.join('=').trim();
      }
    }
  });

  return cookies;
}

export function getApiKeysFromCookie(cookieHeader: string | null): Record<string, string> {
  const cookies = parseCookies(cookieHeader);

  return safeJsonParse<Record<string, string>>(cookies.apiKeys, {});
}

/**
 * Resolve the provider keys to use for this request.
 *
 * Signed-in requests read the encrypted account store; the cookie is only read as
 * a migration fallback for accounts that have not moved their keys yet. This is
 * the single chokepoint the API routes go through, so no route has to know where
 * the keys live.
 *
 * A key stored on the account always wins over a stale cookie value for the same
 * provider.
 */
export async function getApiKeysForRequest(
  cookieHeader: string | null,
  userId?: string | null,
): Promise<Record<string, string>> {
  const fromCookie = getApiKeysFromCookie(cookieHeader);

  if (!userId) {
    return fromCookie;
  }

  try {
    const { getUserApiKeys } = await import('~/lib/.server/api-keys');

    return { ...fromCookie, ...(await getUserApiKeys(userId)) };
  } catch (error) {
    /*
     * A failure here must not take the whole request down: fall back to the
     * cookie so a signed-in user with un-migrated keys still works. The keys are
     * not logged either way.
     */
    console.error('Could not read stored API keys:', error instanceof Error ? error.message : 'unknown error');

    return fromCookie;
  }
}

export function getProviderSettingsFromCookie(cookieHeader: string | null): Record<string, any> {
  const cookies = parseCookies(cookieHeader);
  return safeJsonParse<Record<string, any>>(cookies.providers, {});
}
