import { atom } from 'nanostores';

export const DEFAULT_AVATARS = [
  { id: 'default', name: 'Default', src: '/avatars/default-avatar.svg' },
  { id: 'female', name: 'Female', src: '/avatars/female-avatar.svg' },
  { id: 'male', name: 'Male', src: '/avatars/male-avatar.svg' },
] as const;

export const DEFAULT_AVATAR = DEFAULT_AVATARS[0].src;

interface Profile {
  username: string;
  bio: string;
  avatar: string;

  /** From the account. Used as the display name when no username is set. */
  email?: string;
}

/*
 * The profile is account state (public.profiles), hydrated by
 * `hydrateProfileFromAccount` on every authenticated load. Unlike the old
 * localStorage copy, it is not persisted in the browser: the UI renders defaults
 * until the account answers, and nothing survives sign-out on a shared device.
 */
export const profileStore = atom<Profile>({ username: '', bio: '', avatar: DEFAULT_AVATAR });

export const updateProfile = (updates: Partial<Profile>) => {
  profileStore.set({ ...profileStore.get(), ...updates });
};

/** Name to show: the chosen username, else the account email, else nothing. */
export function displayName(profile: Profile): string {
  return profile.username?.trim() || profile.email?.trim() || '';
}

/**
 * Push username/avatar to the account, best-effort.
 *
 * The local store is already updated by the caller, so a failure only means the
 * change stays on this device until the next successful save.
 */
export async function saveProfileToAccount(updates: {
  username?: string;
  avatar?: string;
  bio?: string;
}): Promise<boolean> {
  try {
    const response = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
      credentials: 'same-origin',
    });

    return response.ok;
  } catch {
    return false;
  }
}

/** Load the account profile into the store. Called once per authenticated load. */
export async function hydrateProfileFromAccount(): Promise<void> {
  try {
    const response = await fetch('/api/profile', { credentials: 'same-origin' });

    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as {
      profile?: { email?: string | null; username?: string | null; avatar?: string | null; bio?: string | null };
    };

    if (!data.profile) {
      return;
    }

    updateProfile({
      email: data.profile.email ?? undefined,
      username: data.profile.username ?? '',
      bio: data.profile.bio ?? '',
      avatar: data.profile.avatar?.trim() || DEFAULT_AVATAR,
    });
  } catch {
    // Signed out or offline: keep whatever is local.
  }
}
