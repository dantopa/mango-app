-- Which Android apps the notification reader forwards, per user.
--
-- The list used to be compiled into the APK, so adding a bank meant rebuilding and
-- reinstalling it. Now the phone downloads it from GET /api/push-ingest/apps, and a
-- row here is all it takes. The built-in defaults (package-whitelist.ts) still apply
-- without a row; a row only records a decision: allow an app the defaults do not
-- know, or block one they do.
--
-- Rows are written by the phone when the user answers "¿Registrar los pagos de esta
-- app?" and by the settings screen.

create table public.push_ingest_apps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  package_name text not null check (package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$' and length(package_name) <= 255),
  label text check (label is null or length(label) <= 80),
  decision text not null check (decision in ('allowed', 'blocked')),
  decided_via text not null default 'device' check (decided_via in ('device', 'web')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, package_name)
);

alter table public.push_ingest_apps enable row level security;

create policy "push_ingest_apps_select_own" on public.push_ingest_apps
  for select using ((select auth.uid()) = user_id);
create policy "push_ingest_apps_insert_own" on public.push_ingest_apps
  for insert with check ((select auth.uid()) = user_id);
create policy "push_ingest_apps_update_own" on public.push_ingest_apps
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "push_ingest_apps_delete_own" on public.push_ingest_apps
  for delete using ((select auth.uid()) = user_id);
