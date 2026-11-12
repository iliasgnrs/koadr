import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

/*
 * Per-chat deployment targets (Netlify site, Vercel project, GitHub/GitLab repo,
 * Supabase project).
 *
 * These used to be `localStorage` keys like `netlify-site-<chatId>`, so a chat
 * opened on another device forgot where it had been deployed. They now live in
 * the chat's own `metadata.deployments` jsonb column, which means they travel
 * with the chat and are deleted with it.
 */

export type DeploymentTargetKey =
  'netlifySiteId' | 'vercelProjectId' | 'githubRepo' | 'gitlabRepo' | 'supabaseProjectId';

export type DeploymentTargets = Partial<Record<DeploymentTargetKey, unknown>>;

type State = {
  byChat: Record<string, DeploymentTargets>;
  loaded: Record<string, boolean>;
};

export const useDeploymentTargets = create<State>(() => ({ byChat: {}, loaded: {} }));

async function fetchChatMetadata(chatId: string): Promise<{ metadata: Record<string, unknown> } | null> {
  try {
    const response = await fetch('/api/chats', { credentials: 'same-origin' });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { chats?: { id: string; metadata?: Record<string, unknown> }[] };
    const chat = data.chats?.find((entry) => entry.id === chatId);

    return chat ? { metadata: chat.metadata ?? {} } : null;
  } catch {
    return null;
  }
}

async function pushDeploymentTarget(chatId: string, key: DeploymentTargetKey, value: unknown): Promise<void> {
  const current = useDeploymentTargets.getState().byChat[chatId] ?? {};
  const deployments = { ...current, [key]: value };

  useDeploymentTargets.setState((state) => ({
    byChat: { ...state.byChat, [chatId]: deployments },
  }));

  const chat = await fetchChatMetadata(chatId);

  if (!chat) {
    return;
  }

  await fetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat: { id: chatId, metadata: { ...chat.metadata, deployments } } }),
    credentials: 'same-origin',
  });
}

/** Read the stored target for a chat (null when none or not loaded yet). */
export function useDeploymentTarget(chatId: string | undefined, key: DeploymentTargetKey) {
  const loaded = useDeploymentTargets((state) => (chatId ? state.loaded[chatId] : true));
  const value = useDeploymentTargets((state) => (chatId ? state.byChat[chatId]?.[key] : undefined));

  useEffect(() => {
    if (!chatId || useDeploymentTargets.getState().loaded[chatId]) {
      return undefined;
    }

    let active = true;

    void fetchChatMetadata(chatId).then((chat) => {
      if (!active) {
        return;
      }

      useDeploymentTargets.setState((state) => ({
        byChat: { ...state.byChat, [chatId]: (chat?.metadata.deployments as DeploymentTargets) ?? {} },
        loaded: { ...state.loaded, [chatId]: true },
      }));
    });

    return () => {
      active = false;
    };
  }, [chatId]);

  const set = useCallback(
    (next: unknown) => {
      if (chatId) {
        void pushDeploymentTarget(chatId, key, next);
      }
    },
    [chatId, key],
  );

  return { value, set, loaded };
}
