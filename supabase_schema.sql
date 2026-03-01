-- ============================================================
-- TheWootz SaaS — Supabase Database Schema
-- Voer dit uit in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ── EXTENSIES ──────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ── PROFILES ───────────────────────────────────────────────
-- Automatisch aangemaakt bij registratie (via trigger)
create table public.profiles (
  id            uuid references auth.users on delete cascade primary key,
  email         text,
  full_name     text,
  company_name  text,
  plan          text default 'free' check (plan in ('free','starter','pro')),
  created_at    timestamptz default now()
);
alter table public.profiles enable row level security;
create policy "Users can read own profile"   on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

-- ── STORES ─────────────────────────────────────────────────
-- Elke gebruiker kan meerdere winkels koppelen (bol, etsy, amazon)
create table public.stores (
  id            uuid default uuid_generate_v4() primary key,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  platform      text not null check (platform in ('bol','etsy','amazon','pinterest')),
  name          text not null default 'Mijn winkel',
  -- Encrypted credentials (opgeslagen als encrypted strings via Supabase Vault of simpel Base64 voor MVP)
  client_id_enc text,
  client_secret_enc text,
  is_active     boolean default true,
  last_synced_at timestamptz,
  created_at    timestamptz default now()
);
alter table public.stores enable row level security;
create policy "Users can CRUD own stores" on public.stores for all using (auth.uid() = user_id);

-- ── ORDERS ─────────────────────────────────────────────────
-- Gecachte bestellingen per store (oplossing voor bol 48u probleem)
create table public.orders (
  id              uuid default uuid_generate_v4() primary key,
  store_id        uuid references public.stores(id) on delete cascade not null,
  user_id         uuid references public.profiles(id) on delete cascade not null,
  platform        text not null,
  external_id     text not null,          -- bol orderId, etsy receipt_id, etc.
  order_date      date not null,
  status          text,
  total_amount    numeric(10,2) default 0,
  created_at      timestamptz default now(),
  raw_data        jsonb,                  -- volledige API response opgeslagen
  unique(store_id, external_id)           -- geen duplicaten
);
alter table public.orders enable row level security;
create policy "Users can read own orders" on public.orders for all using (auth.uid() = user_id);
create index orders_store_date_idx on public.orders(store_id, order_date desc);

-- ── ORDER ITEMS ────────────────────────────────────────────
create table public.order_items (
  id            uuid default uuid_generate_v4() primary key,
  order_id      uuid references public.orders(id) on delete cascade not null,
  store_id      uuid references public.stores(id) on delete cascade not null,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  product_title text,
  product_ean   text,
  quantity      int default 1,
  unit_price    numeric(10,2) default 0,
  total_price   numeric(10,2) default 0,
  platform      text not null
);
alter table public.order_items enable row level security;
create policy "Users can read own order_items" on public.order_items for all using (auth.uid() = user_id);
create index order_items_store_idx on public.order_items(store_id);
create index order_items_user_idx  on public.order_items(user_id);

-- ── SYNC LOG ───────────────────────────────────────────────
-- Bijhouden wanneer laatste sync was per store
create table public.sync_log (
  id          uuid default uuid_generate_v4() primary key,
  store_id    uuid references public.stores(id) on delete cascade not null,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  synced_at   timestamptz default now(),
  orders_new  int default 0,
  orders_updated int default 0,
  status      text default 'ok',
  error       text
);
alter table public.sync_log enable row level security;
create policy "Users can read own sync_log" on public.sync_log for all using (auth.uid() = user_id);

-- ── TRIGGER: auto-create profile na signup ─────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── HANDY VIEWS ────────────────────────────────────────────
-- Dashboard samenvatting per store
create or replace view public.store_stats as
select
  s.id as store_id,
  s.user_id,
  s.platform,
  s.name as store_name,
  s.last_synced_at,
  count(distinct o.id)          as total_orders,
  coalesce(sum(oi.total_price), 0) as total_revenue,
  coalesce(avg(o.total_amount), 0) as avg_order_value,
  min(o.order_date)             as first_order_date,
  max(o.order_date)             as last_order_date
from public.stores s
left join public.orders o on o.store_id = s.id
left join public.order_items oi on oi.store_id = s.id
where s.is_active = true
group by s.id, s.user_id, s.platform, s.name, s.last_synced_at;

-- ============================================================
-- KLAAR! Kopieer nu je Supabase URL + anon key naar Vercel
-- ============================================================
