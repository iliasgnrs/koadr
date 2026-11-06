-- 0004_chats.sql
--
-- Chat history, server-side.
--
-- Denormalised `profile_id` on `messages` rather than a join through `chats`:
-- every message read is filtered by owner, and a subquery per row on the hottest
-- table in the app is a poor trade for a few bytes. The trade-off is that
-- `messages.profile_id` must stay in sync with its chat — enforced by the
-- composite foreign key below, so it cannot drift.
--
-- Idempotent.

begin;

create table if not exists public.chats (
  id text primary key,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  description text,
  url_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, url_id)
);

create index if not exists chats_profile_updated_idx on public.chats (profile_id, updated_at desc);
-- Satisfies the composite FK below; must exist before `messages` is created.
create unique index if not exists chats_id_profile_idx on public.chats (id, profile_id);

create table if not exists public.messages (
  chat_id text not null,
  id text not null,
  profile_id uuid not null,
  role text,
  content jsonb not null,
  ordinal int not null default 0,
  created_at timestamptz not null default now(),
  primary key (chat_id, id),
  -- Composite FK guarantees messages.profile_id matches the owning chat, so the
  -- denormalised column cannot be forged or drift.
  constraint messages_chat_owner_fk
    foreign key (chat_id, profile_id) references public.chats (id, profile_id) on delete cascade
);

create index if not exists messages_profile_idx on public.messages (profile_id);

drop trigger if exists chats_set_updated_at on public.chats;
create trigger chats_set_updated_at
  before update on public.chats
  for each row execute function public.set_updated_at();

alter table public.chats enable row level security;
alter table public.messages enable row level security;

drop policy if exists chats_own on public.chats;
create policy chats_own on public.chats
  for all
  to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

drop policy if exists messages_own on public.messages;
create policy messages_own on public.messages
  for all
  to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

commit;
