-- PAR index. The chain and Arweave are the source of truth; every row here can be rebuilt from them.
-- Writes come only from the PAR server (service role) after it read the facts on chain. Anyone can read.

create table public.items (
  cluster text not null check (cluster in ('devnet', 'mainnet-beta')),
  record text not null,
  title text not null,
  mint text not null,
  pool text not null,
  config text not null,
  creator text not null,
  vault text not null,
  rail text not null check (rail in ('creator', 'escrow')),
  listing text,
  name text not null,
  symbol text not null,
  quote text not null,
  sheet_uri text not null,
  sheet_sha256 text not null check (sheet_sha256 ~ '^[0-9a-f]{64}$'),
  image_sha256 text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
  sale_delay_days smallint not null check (sale_delay_days between 1 and 365),
  burn_percent smallint not null check (burn_percent between 0 and 100),
  status text not null default 'created'
    check (status in ('created', 'graduated', 'open', 'sold', 'reclaimed')),
  graduated_at timestamptz,
  opens_at timestamptz,
  sold_at timestamptz,
  buyer text,
  sheet text not null check (length(sheet) <= 110000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (cluster, record),
  unique (cluster, title),
  unique (cluster, mint),
  unique (cluster, pool)
);

create index items_creator on public.items (cluster, creator, created_at desc);
create index items_status on public.items (cluster, status, created_at desc);

create table public.pools (
  cluster text not null check (cluster in ('devnet', 'mainnet-beta')),
  pool text not null,
  config text not null,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (cluster, pool)
);

create index pools_recent on public.pools (cluster, created_at desc) where not hidden;

create table public.events (
  id bigint generated always as identity primary key,
  cluster text not null,
  record text not null,
  kind text not null check (kind in ('record', 'title', 'deposit', 'graduated', 'price', 'sold', 'reclaimed')),
  signature text,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now(),
  foreign key (cluster, record) references public.items (cluster, record) on delete cascade,
  unique (cluster, kind, signature)
);

create index events_record on public.events (cluster, record, at);

alter table public.items enable row level security;
alter table public.pools enable row level security;
alter table public.events enable row level security;

create policy "public read" on public.items for select to anon, authenticated using (true);
create policy "public read" on public.pools for select to anon, authenticated using (not hidden);
create policy "public read" on public.events for select to anon, authenticated using (true);
