import type { UIMessage } from 'ai';
import { getPgPool } from './pg';

/*
 * Server-side chat history.
 *
 * Written through Supabase (anon key + the caller's session, so RLS applies), and
 * read the same way. That means a bug here cannot cross accounts: the policy does
 * the filtering, not this module.
 *
 * The shape mirrors `ChatHistoryItem` in app/lib/persistence/useChatHistory.ts so
 * the client adapter is a thin mapping rather than a second data model.
 */

/** Raised when a chat id already exists under a different account. */
export class ChatOwnershipError extends Error {
  constructor() {
    super('Chat belongs to another account');
    this.name = 'ChatOwnershipError';
  }
}

export interface StoredChat {
  id: string;
  urlId?: string;
  description?: string;
  messages: UIMessage[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

type ChatRow = {
  id: string;
  url_id: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type MessageRow = { chat_id: string; id: string; content: unknown; ordinal: number };

function toStoredChat(row: ChatRow, messages: UIMessage[]): StoredChat {
  return {
    id: row.id,
    urlId: row.url_id ?? undefined,
    description: row.description ?? undefined,
    messages,
    timestamp: row.created_at,
    metadata: row.metadata ?? undefined,
  };
}

/**
 * Replace a chat's messages wholesale.
 *
 * Delete-then-insert rather than diffing: the UI already holds the full message
 * list when it persists, and streaming appends to that list, so a diff would have
 * to reconstruct the same information. It runs inside a transaction so a failure
 * cannot leave a chat with no messages.
 */
export async function upsertChat(profileId: string, chat: StoredChat & { snapshot?: unknown }): Promise<void> {
  /*
   * One transaction for the chat row and its messages: a half-written chat shows
   * up in the sidebar with no content, which is worse than a failed save.
   */
  const client = await getPgPool().connect();

  try {
    await client.query('begin');

    /*
     * The conflicting id may belong to another account. `where profile_id = $2`
     * makes that a zero-row update instead of a takeover, and the check below
     * turns it into an explicit error rather than a silent success.
     */
    const chatWrite = await client.query(
      `insert into public.chats (id, profile_id, description, url_id, metadata, snapshot, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
       on conflict (id) do update
         set description = excluded.description,
             url_id = excluded.url_id,
             metadata = excluded.metadata,
             snapshot = coalesce(excluded.snapshot, public.chats.snapshot),
             updated_at = now()
         where public.chats.profile_id = $2`,
      [
        chat.id,
        profileId,
        chat.description ?? null,
        chat.urlId ?? null,
        JSON.stringify(chat.metadata ?? {}),
        chat.snapshot === undefined ? null : JSON.stringify(chat.snapshot),
      ],
    );

    if (chatWrite.rowCount === 0) {
      throw new ChatOwnershipError();
    }

    await client.query('delete from public.messages where chat_id = $1 and profile_id = $2', [chat.id, profileId]);

    if (chat.messages.length > 0) {
      const params: unknown[] = [];

      const placeholders = chat.messages.map((message, index) => {
        const base = index * 6;

        params.push(chat.id, message.id, profileId, message.role ?? null, index, JSON.stringify(message));

        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb)`;
      });

      await client.query(
        `insert into public.messages (chat_id, id, profile_id, role, ordinal, content) values ${placeholders.join(', ')}`,
        params,
      );
    }

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Per-chat project snapshot (the files the workbench held at save time). */
export async function setChatSnapshot(profileId: string, chatId: string, snapshot: unknown): Promise<void> {
  await getPgPool().query('update public.chats set snapshot = $3::jsonb where id = $1 and profile_id = $2', [
    chatId,
    profileId,
    snapshot === undefined ? null : JSON.stringify(snapshot),
  ]);
}

export async function getChatSnapshot(profileId: string, chatId: string): Promise<unknown | null> {
  const { rows } = await getPgPool().query<{ snapshot: unknown }>(
    'select snapshot from public.chats where id = $1 and profile_id = $2',
    [chatId, profileId],
  );

  return rows[0]?.snapshot ?? null;
}

export async function listChats(profileId: string): Promise<StoredChat[]> {
  const pool = getPgPool();

  const { rows } = await pool.query<ChatRow>(
    `select id, url_id, description, metadata, created_at
       from public.chats
      where profile_id = $1
      order by created_at desc`,
    [profileId],
  );

  if (rows.length === 0) {
    return [];
  }

  const { rows: messageRows } = await pool.query<MessageRow>(
    `select chat_id, id, content, ordinal
       from public.messages
      where profile_id = $1
      order by chat_id, ordinal asc`,
    [profileId],
  );

  const byChat = new Map<string, UIMessage[]>();

  for (const row of messageRows) {
    const list = byChat.get(row.chat_id) ?? [];

    list.push(row.content as UIMessage);
    byChat.set(row.chat_id, list);
  }

  return rows.map((row) => toStoredChat(row, byChat.get(row.id) ?? []));
}

export async function deleteChat(profileId: string, id: string): Promise<void> {
  // messages cascade via the composite FK.
  await getPgPool().query('delete from public.chats where id = $1 and profile_id = $2', [id, profileId]);
}
