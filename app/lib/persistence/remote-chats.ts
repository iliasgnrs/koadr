import type { UIMessage } from 'ai';

/*
 * Client-side chat history over the account API.
 *
 * IndexedDB stays the local cache so a reload is instant and works offline; the
 * server is the durable copy that makes history follow the user. Writes go out on
 * a debounce because streaming appends a message on every chunk boundary, and a
 * request per chunk would be both wasteful and racy.
 */

export interface RemoteChat {
  id: string;
  urlId?: string;
  description?: string;
  messages: UIMessage[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

const WRITE_DEBOUNCE_MS = 1200;

/** chatId -> timer, so saving one chat does not starve another. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const latest = new Map<string, RemoteChat>();

async function push(chat: RemoteChat): Promise<void> {
  try {
    await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat }),
      credentials: 'same-origin',
    });
  } catch {
    /*
     * Offline or signed out. The IndexedDB copy is already written by the caller,
     * and the next successful save reconciles, so this is not surfaced.
     */
  }
}

/** Queue a save; repeated calls for the same chat collapse into one request. */
export function queueChatSave(chat: RemoteChat): void {
  latest.set(chat.id, chat);

  if (pending.has(chat.id)) {
    return;
  }

  pending.set(
    chat.id,
    setTimeout(() => {
      pending.delete(chat.id);

      const queued = latest.get(chat.id);

      if (queued) {
        latest.delete(chat.id);
        void push(queued);
      }
    }, WRITE_DEBOUNCE_MS),
  );
}

/** Flush immediately, for the moments where losing the tail would be visible. */
export async function saveChatNow(chat: RemoteChat): Promise<void> {
  const timer = pending.get(chat.id);

  if (timer) {
    clearTimeout(timer);
    pending.delete(chat.id);
  }

  latest.delete(chat.id);

  await push(chat);
}

export async function fetchRemoteChats(): Promise<RemoteChat[] | null> {
  try {
    const response = await fetch('/api/chats', { credentials: 'same-origin' });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { chats?: RemoteChat[] };

    return data.chats ?? [];
  } catch {
    return null;
  }
}

export async function deleteRemoteChat(id: string): Promise<boolean> {
  try {
    const response = await fetch('/api/chats', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      credentials: 'same-origin',
    });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch a single chat by id, for cache misses.
 *
 * Returns the same shape IndexedDB stores, so the caller can repopulate the local
 * cache and every downstream read keeps working unchanged.
 */
export async function fetchRemoteChat(id: string): Promise<RemoteChat | null> {
  const chats = await fetchRemoteChats();

  if (!chats) {
    return null;
  }

  return chats.find((chat) => chat.id === id || chat.urlId === id) ?? null;
}

/**
 * Write a chat fetched from the account into the local IndexedDB cache.
 *
 * Mirrors the record shape `setMessages` writes, so a hydrated chat is
 * indistinguishable from one created on this browser.
 */
export async function writeRemoteChatLocally(database: IDBDatabase, chat: RemoteChat): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('chats', 'readwrite');
    const store = transaction.objectStore('chats');

    store.put({
      id: chat.id,
      messages: chat.messages,
      urlId: chat.urlId,
      description: chat.description,
      timestamp: chat.timestamp,
      metadata: chat.metadata,
    });

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
