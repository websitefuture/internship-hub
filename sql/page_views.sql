-- Run this once in the Supabase SQL editor before the view tracker can record anything.
-- Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- The site's own page-view counter. It works the same on any host, keeps every day forever,
-- and sets no cookies. src/app/api/track/route.ts writes here with the service key;
-- src/app/admin/stats/page.tsx reads the summary views below.
--
-- No IP addresses are stored. "visitor" is a hash of (secret, IP, browser, date), so it can
-- count distinct visitors within one day but cannot follow anyone from one day to the next.

create table if not exists public.page_views (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  path          text not null,
  referrer_host text,
  utm_source    text,
  country       text,
  device        text,
  visitor       text not null
);
create index if not exists page_views_at_idx on public.page_views (at);

-- Added Oct 15 2026: which address the view used (internshipnest.com or the old vercel.app one)
-- and which app or browser ("Instagram app", "Safari"), so /admin/stats can show who is real.
alter table public.page_views add column if not exists site text;
alter table public.page_views add column if not exists browser text;

-- Vercel Web Analytics history, imported once before leaving Vercel, so the dashboard shows
-- one continuous record instead of starting from zero on the day the tracker went live.
create table if not exists public.vercel_history (
  day      date primary key,
  views    integer not null,
  visitors integer not null
);

-- Only the server (service key, which bypasses RLS) touches these. RLS on with no policies
-- means the anon key that ships to the browser can read nothing.
alter table public.page_views enable row level security;
alter table public.vercel_history enable row level security;

-- security_invoker keeps the views under the same RLS as the table: without it a view runs
-- as its owner and would hand the whole table to the anon key.
create or replace view public.pv_daily with (security_invoker = true) as
  select (at at time zone 'UTC')::date as day, count(*)::int as views, count(distinct visitor)::int as visitors
  from public.page_views group by 1;

create or replace view public.pv_sources with (security_invoker = true) as
  select coalesce(utm_source, referrer_host, '(direct)') as source, count(*)::int as views
  from public.page_views group by 1;

create or replace view public.pv_paths with (security_invoker = true) as
  select path, count(*)::int as views from public.page_views group by 1;

-- Distinct devices ever, counted only from views carrying the browser's anonymous device id
-- (visitor starts with 'd'). The per-day address hashes can't be counted across days.
create or replace view public.pv_devices with (security_invoker = true) as
  select count(distinct visitor)::int as devices from public.page_views where visitor like 'd%';

create or replace view public.pv_countries with (security_invoker = true) as
  select coalesce(country, '(unknown)') as country, count(*)::int as views from public.page_views group by 1;
