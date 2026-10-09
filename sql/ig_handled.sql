-- Run this once in the Supabase SQL editor before the Instagram auto-reply can work.
-- Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- One row per comment the webhook has answered. Meta retries a notification until it gets a
-- 200, so the same comment arrives several times; src/app/api/ig-webhook/route.ts inserts
-- here *before* sending anything, and the primary key is what makes a second delivery lose
-- the race rather than posting a duplicate reply.

create table if not exists public.ig_handled (
  comment_id text primary key,
  commenter  text,
  handled_at timestamptz not null default now()
);

-- The webhook is the only thing that touches this table, and it connects with the service
-- key, which bypasses row level security. RLS is still switched on so that the anon key,
-- which ships to the browser, cannot read who commented. No policy is added, so anon gets
-- nothing.
alter table public.ig_handled enable row level security;

-- Lets old rows be cleared out cheaply. Meta only allows a private reply within 7 days of a
-- comment, so anything older than that can never be acted on again:
--   delete from public.ig_handled where handled_at < now() - interval '30 days';
create index if not exists ig_handled_handled_at_idx on public.ig_handled (handled_at);
