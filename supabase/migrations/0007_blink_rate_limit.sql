-- Bounded, privacy-preserving request counters for the public Blink Action API.
-- Only the PAR server's service role can invoke the function or read the counters.

create table public.blink_rate_limit (
  key_hash text primary key check (key_hash ~ '^[a-f0-9]{64}$'),
  window_start timestamptz not null,
  hit_count integer not null check (hit_count > 0),
  updated_at timestamptz not null default now()
);

alter table public.blink_rate_limit enable row level security;
revoke all on table public.blink_rate_limit from anon, authenticated;
grant select, insert, update, delete on table public.blink_rate_limit to service_role;

create or replace function public.allow_blink_request(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_hits integer;
begin
  if p_key_hash !~ '^[a-f0-9]{64}$' or p_limit < 1 or p_limit > 1000
     or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit parameters';
  end if;

  v_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into public.blink_rate_limit (key_hash, window_start, hit_count, updated_at)
  values (p_key_hash, v_window, 1, clock_timestamp())
  on conflict (key_hash) do update
    set window_start = excluded.window_start,
        hit_count = case
          when public.blink_rate_limit.window_start = excluded.window_start
            then public.blink_rate_limit.hit_count + 1
          else 1
        end,
        updated_at = excluded.updated_at
  returning hit_count into v_hits;

  -- Occasionally clean expired identities without scanning the table on every request.
  if right(p_key_hash, 2) = '00' then
    delete from public.blink_rate_limit
    where updated_at < clock_timestamp() - interval '2 days';
  end if;

  return v_hits <= p_limit;
end;
$$;

revoke all on function public.allow_blink_request(text, integer, integer) from public, anon, authenticated;
grant execute on function public.allow_blink_request(text, integer, integer) to service_role;

-- Track the current address set so a newly indexed title refreshes the hook immediately.
alter table public.helius_hooks
  add column if not exists addresses_sha256 text not null default '';

-- Claim a pending seller sale notice atomically. A crashed worker may be reclaimed after five minutes.
alter table public.handoff_hold
  add column if not exists mail_claimed_at timestamptz;

alter table public.handoff_hold
  drop constraint if exists handoff_hold_mail_check;

alter table public.handoff_hold
  add constraint handoff_hold_mail_check
  check (mail in ('pending', 'sending', 'sent', 'skip', 'wait'));

create or replace function public.claim_handoff_sale_mail(
  p_cluster text,
  p_title text,
  p_owner text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  update public.handoff_hold
  set mail = 'sending', mail_claimed_at = clock_timestamp()
  where cluster = p_cluster
    and title = p_title
    and owner = p_owner
    and (
      mail = 'pending'
      or (mail = 'sending' and mail_claimed_at < clock_timestamp() - interval '5 minutes')
    );
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.claim_handoff_sale_mail(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_handoff_sale_mail(text, text, text) to service_role;
