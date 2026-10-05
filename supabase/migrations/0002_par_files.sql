-- Pictures, the platform fee, and the watcher heartbeat.
-- Practice-network rows and real-network rows stay apart by the cluster column.
-- The chain and Arweave remain the proof. These rows are PAR's copy.

alter table public.pools
  add column if not exists creator text,
  add column if not exists mint text,
  add column if not exists name text,
  add column if not exists symbol text,
  add column if not exists uri text;

create table if not exists public.settings (
  id text primary key,
  body jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.pictures (
  id text primary key check (id ~ '^[a-f0-9]{12}$'),
  wallet text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer not null check (bytes > 0 and bytes <= 1500000),
  created_at timestamptz not null default now()
);

create index if not exists pictures_wallet on public.pictures (wallet, created_at desc);

create table if not exists public.jobs (
  name text primary key,
  cluster text not null check (cluster in ('devnet', 'mainnet-beta')),
  last_at timestamptz,
  ok boolean not null default false,
  note text not null default '',
  watched integer not null default 0,
  marked integer not null default 0,
  settled integer not null default 0,
  wake_at timestamptz
);

alter table public.settings enable row level security;
alter table public.pictures enable row level security;
alter table public.jobs enable row level security;

drop policy if exists "no public read" on public.jobs;
create policy "no public read" on public.jobs for select to anon, authenticated using (false);

drop policy if exists "public read" on public.settings;
create policy "public read" on public.settings for select to anon, authenticated using (true);

drop policy if exists "public read" on public.pictures;
create policy "public read" on public.pictures for select to anon, authenticated using (true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('par-pictures', 'par-pictures', false, 1500000, array['image/jpeg']::text[])
on conflict (id) do nothing;
