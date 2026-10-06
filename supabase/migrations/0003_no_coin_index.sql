-- A title with no coin stores pool as 'none' and sale_delay_days as 0.
-- Several of those titles can name the same payment mint. A launched coin still has one row per mint and one row per pool.

alter table public.items drop constraint items_sale_delay_days_check;
alter table public.items add constraint items_sale_delay_days_check
  check (sale_delay_days between 0 and 365);

alter table public.items drop constraint items_cluster_mint_key;
alter table public.items drop constraint items_cluster_pool_key;

create unique index items_cluster_mint_coin on public.items (cluster, mint) where pool <> 'none';
create unique index items_cluster_pool_coin on public.items (cluster, pool) where pool <> 'none';
