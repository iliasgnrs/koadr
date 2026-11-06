import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { ChatOwnershipError, deleteChat, listChats, upsertChat, type StoredChat } from '~/lib/.server/chats';
import { requireApiUser } from '~/lib/auth-guard';

/*
 * Chat history for the signed-in account.
 *
 * The profile id always comes from the session; nothing here trusts a body field
 * for ownership, and the RLS policies would reject it anyway.
 */

const MAX_MESSAGES = 2000;

function fail(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}

export async function loader({ context }: LoaderFunctionArgs) {
  const user = requireApiUser(context);

  try {
    return Response.json({ ok: true, chats: await listChats(user.id) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Could not load chats', 500);
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const user = requireApiUser(context);

  let body: { chat?: StoredChat; id?: string };

  /*
   * Clone: React Router consumes the original body before the action runs. Same
   * trap that broke /api/auth in Slice 1 — see api.auth.spec.ts.
   */
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    return fail('Invalid request body');
  }

  try {
    if (request.method === 'DELETE') {
      if (typeof body.id !== 'string' || !body.id) {
        return fail('Chat id is required');
      }

      await deleteChat(user.id, body.id);

      return Response.json({ ok: true });
    }

    const chat = body.chat;

    if (!chat || typeof chat.id !== 'string' || !chat.id) {
      return fail('Chat with an id is required');
    }

    if (!Array.isArray(chat.messages)) {
      return fail('messages must be an array');
    }

    if (chat.messages.length > MAX_MESSAGES) {
      /*
       * A single chat with more messages than this is a client bug, and accepting
       * it would mean one huge insert holding a connection.
       */
      return fail(`A chat may hold at most ${MAX_MESSAGES} messages`);
    }

    await upsertChat(user.id, { ...chat, messages: chat.messages });

    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ChatOwnershipError) {
      return fail('That chat id belongs to another account', 409);
    }

    console.error(`Chat ${request.method} failed`);

    return fail(error instanceof Error ? error.message : 'Could not save chat', 500);
  }
}
