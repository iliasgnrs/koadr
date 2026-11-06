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

const storedProfile = typeof window !== 'undefined' ? localStorage.getItem('bolt_profile') : null;

function loadProfile(): Profile {
  if (storedProfile) {
    try {
      const parsed = JSON.parse(storedProfile) as Partial<Profile>;

      return {
        username: parsed.username ?? '',
        bio: parsed.bio ?? '',
        avatar: parsed.avatar?.trim() || DEFAULT_AVATAR,
        email: parsed.email,
      };
    } catch (error) {
      console.error('Failed to load saved profile:', error);
    }
  }

  return { username: '', bio: '', avatar: DEFAULT_AVATAR };
}

export const profileStore = atom<Profile>(loadProfile());

export const updateProfile = (updates: Partial<Profile>) => {
  profileStore.set({ ...profileStore.get(), ...updates });

  if (typeof window !== 'undefined') {
    localStorage.setItem('bolt_profile', JSON.stringify(profileStore.get()));
  }
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
export async function saveProfileToAccount(updates: { username?: string; avatar?: string }): Promise<boolean> {
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
      profile?: { email?: string | null; username?: string | null; avatar?: string | null };
    };

    if (!data.profile) {
      return;
    }

    updateProfile({
      email: data.profile.email ?? undefined,
      ...(data.profile.username ? { username: data.profile.username } : {}),
      ...(data.profile.avatar ? { avatar: data.profile.avatar } : {}),
    });
  } catch {
    // Signed out or offline: keep whatever is local.
  }
}
