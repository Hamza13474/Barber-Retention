-- Phase 7: demo loyalty points and barber-owned rewards.
-- Apply only after 20260906000000_phase_6_customer_history_rebooking.sql.

create type public.loyalty_transaction_type as enum (
  'appointment_earned',
  'reward_redeemed'
);

create table public.loyalty_rewards (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null default auth.uid() references public.barber_profiles(id),
  title text not null check (char_length(trim(title)) between 1 and 80),
  description text check (description is null or char_length(description) <= 240),
  points_required integer not null check (points_required > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (barber_id, id)
);

create index loyalty_rewards_barber_active_points_idx
  on public.loyalty_rewards (barber_id, is_active, points_required, created_at);

-- Composite identity enables the ledger foreign key to prove that an earning
-- appointment belongs to this exact barber/customer account.
alter table public.appointments add constraint appointments_loyalty_identity_unique
  unique (barber_id, customer_id, id);

create table public.loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references public.barber_profiles(id),
  customer_id uuid not null references public.customer_profiles(id),
  amount integer not null check (amount <> 0),
  transaction_type public.loyalty_transaction_type not null,
  appointment_id uuid,
  reward_id uuid,
  description text not null check (char_length(trim(description)) between 1 and 240),
  created_at timestamptz not null default now(),
  foreign key (barber_id, customer_id, appointment_id)
    references public.appointments (barber_id, customer_id, id),
  foreign key (barber_id, reward_id)
    references public.loyalty_rewards (barber_id, id),
  check (
    (transaction_type = 'appointment_earned'::public.loyalty_transaction_type
      and amount > 0 and appointment_id is not null and reward_id is null)
    or
    (transaction_type = 'reward_redeemed'::public.loyalty_transaction_type
      and amount < 0 and appointment_id is null and reward_id is not null)
  )
);

-- The partial unique index is the database-level idempotency boundary: a
-- completed appointment can create no more than one earning transaction.
create unique index loyalty_transactions_one_earning_per_appointment_idx
  on public.loyalty_transactions (appointment_id)
  where transaction_type = 'appointment_earned'::public.loyalty_transaction_type;
create index loyalty_transactions_account_created_idx
  on public.loyalty_transactions (barber_id, customer_id, created_at desc, id desc);

create trigger loyalty_rewards_updated_at before update on public.loyalty_rewards
for each row execute procedure public.set_updated_at();

alter table public.loyalty_rewards enable row level security;
alter table public.loyalty_transactions enable row level security;

create policy "Barbers view own loyalty rewards"
on public.loyalty_rewards for select to authenticated
using (barber_id = auth.uid());
create policy "Customers view active rewards for their barbers"
on public.loyalty_rewards for select to authenticated
using (
  is_active
  and exists (
    select 1 from public.appointments a
    where a.barber_id = loyalty_rewards.barber_id
      and a.customer_id = auth.uid()
  )
);
create policy "Barbers create own loyalty rewards"
on public.loyalty_rewards for insert to authenticated
with check (
  barber_id = auth.uid()
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'barber'::public.user_role
  )
);
create policy "Barbers update own loyalty rewards"
on public.loyalty_rewards for update to authenticated
using (barber_id = auth.uid())
with check (barber_id = auth.uid());

create policy "Participants view their loyalty transactions"
on public.loyalty_transactions for select to authenticated
using (barber_id = auth.uid() or customer_id = auth.uid());

revoke all on public.loyalty_rewards, public.loyalty_transactions from anon;
revoke all on public.loyalty_rewards, public.loyalty_transactions from authenticated;
grant select, insert, update on public.loyalty_rewards to authenticated;
grant select on public.loyalty_transactions to authenticated;

-- Returns one isolated account per barber with whom the signed-in customer has
-- at least one appointment. Rewards and history are snapshots safe for the UI.
create function public.get_customer_loyalty_accounts()
returns table (
  barber_id uuid,
  barber_name text,
  balance integer,
  rewards jsonb,
  history jsonb
)
language plpgsql stable security definer set search_path = '' as $$
declare v_customer uuid := auth.uid();
begin
  if v_customer is null or not exists (
    select 1 from public.profiles p
    where p.id = v_customer and p.role = 'customer'::public.user_role
  ) then
    raise exception 'Only authenticated customers can view customer loyalty';
  end if;

  return query
  select b.id,
    coalesce(nullif(bp.display_name, ''), p.full_name),
    coalesce((select pg_catalog.sum(t.amount)::integer
      from public.loyalty_transactions t
      where t.barber_id = b.id and t.customer_id = v_customer), 0),
    coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'title', r.title, 'description', r.description,
      'points_required', r.points_required, 'is_active', r.is_active,
      'created_at', r.created_at, 'updated_at', r.updated_at
    ) order by r.points_required, r.created_at)
      from public.loyalty_rewards r where r.barber_id = b.id and r.is_active), '[]'::jsonb),
    coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', h.id, 'amount', h.amount, 'transaction_type', h.transaction_type,
      'description', h.description, 'created_at', h.created_at
    ) order by h.created_at desc, h.id desc)
      from (select t.id, t.amount, t.transaction_type, t.description, t.created_at
        from public.loyalty_transactions t
        where t.barber_id = b.id and t.customer_id = v_customer
        order by t.created_at desc, t.id desc limit 10) h), '[]'::jsonb)
  from (
    select distinct a.barber_id as id from public.appointments a
    where a.customer_id = v_customer
  ) b
  join public.barber_profiles bp on bp.id = b.id
  join public.profiles p on p.id = b.id
  order by 2;
end; $$;

-- Minimal relationship list for the barber demo; it is not a general CRM.
create function public.get_barber_loyalty_customers()
returns table (customer_id uuid, customer_name text, balance integer, last_appointment_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_barber uuid := auth.uid();
begin
  if v_barber is null or not exists (
    select 1 from public.profiles p
    where p.id = v_barber and p.role = 'barber'::public.user_role
  ) then
    raise exception 'Only authenticated barbers can view barber loyalty';
  end if;

  return query
  select a.customer_id, p.full_name,
    coalesce((select pg_catalog.sum(t.amount)::integer
      from public.loyalty_transactions t
      where t.barber_id = v_barber and t.customer_id = a.customer_id), 0),
    pg_catalog.max(a.start_at)
  from public.appointments a
  join public.profiles p on p.id = a.customer_id
  where a.barber_id = v_barber
  group by a.customer_id, p.full_name
  order by pg_catalog.max(a.start_at) desc, p.full_name;
end; $$;

create function public.get_barber_customer_loyalty(p_customer_id uuid)
returns table (customer_id uuid, customer_name text, balance integer, history jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare v_barber uuid := auth.uid();
begin
  if v_barber is null or not exists (
    select 1 from public.profiles p
    where p.id = v_barber and p.role = 'barber'::public.user_role
  ) then
    raise exception 'Only authenticated barbers can view barber loyalty';
  end if;
  if p_customer_id is null or not exists (
    select 1 from public.appointments a
    where a.barber_id = v_barber and a.customer_id = p_customer_id
  ) then
    raise exception 'Customer relationship not found';
  end if;

  return query
  select p.id, p.full_name,
    coalesce((select pg_catalog.sum(t.amount)::integer
      from public.loyalty_transactions t
      where t.barber_id = v_barber and t.customer_id = p_customer_id), 0),
    coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', h.id, 'amount', h.amount, 'transaction_type', h.transaction_type,
      'description', h.description, 'created_at', h.created_at
    ) order by h.created_at desc, h.id desc)
      from (select t.id, t.amount, t.transaction_type, t.description, t.created_at
        from public.loyalty_transactions t
        where t.barber_id = v_barber and t.customer_id = p_customer_id
        order by t.created_at desc, t.id desc limit 20) h), '[]'::jsonb)
  from public.profiles p where p.id = p_customer_id;
end; $$;

create function public.redeem_loyalty_reward(p_customer_id uuid, p_reward_id uuid)
returns table (transaction_id uuid, new_balance integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_barber uuid := auth.uid();
  v_reward public.loyalty_rewards%rowtype;
  v_balance integer;
  v_transaction_id uuid;
begin
  if v_barber is null or not exists (
    select 1 from public.profiles p
    where p.id = v_barber and p.role = 'barber'::public.user_role
  ) then
    raise exception 'Only authenticated barbers can redeem rewards';
  end if;
  if p_customer_id is null or not exists (
    select 1 from public.appointments a
    where a.barber_id = v_barber and a.customer_id = p_customer_id
  ) then
    raise exception 'Customer relationship not found';
  end if;

  -- The barber/customer lock serializes redemptions with each other and with
  -- appointment earning, so the balance check and deduction are atomic.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_barber::text || ':' || p_customer_id::text, 0)
  );
  select * into v_reward from public.loyalty_rewards r
  where r.id = p_reward_id and r.barber_id = v_barber for update;
  if not found then raise exception 'Reward not found'; end if;
  if not v_reward.is_active then raise exception 'Reward is not active'; end if;

  select coalesce(pg_catalog.sum(t.amount), 0)::integer into v_balance
  from public.loyalty_transactions t
  where t.barber_id = v_barber and t.customer_id = p_customer_id;
  if v_balance < v_reward.points_required then raise exception 'Insufficient points'; end if;

  insert into public.loyalty_transactions
    (barber_id, customer_id, amount, transaction_type, reward_id, description)
  values (v_barber, p_customer_id, -v_reward.points_required,
    'reward_redeemed'::public.loyalty_transaction_type, v_reward.id,
    'Redeemed: ' || v_reward.title)
  returning id into v_transaction_id;
  return query select v_transaction_id, v_balance - v_reward.points_required;
end; $$;

-- Preserve the Phase 4 RPC signature and lifecycle rules. The appointment
-- update and earning insert commit or roll back together.
create or replace function public.update_barber_appointment_status(
  p_appointment_id uuid,
  p_status public.appointment_status
)
returns table (id uuid, status public.appointment_status, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_barber uuid := auth.uid();
  v_appointment public.appointments%rowtype;
  v_points integer;
begin
  if v_barber is null or not exists (
    select 1 from public.profiles p
    join public.barber_profiles bp on bp.id = p.id
    where p.id = v_barber and p.role = 'barber'::public.user_role
  ) then raise exception 'Only authenticated barbers can manage appointments'; end if;
  if p_status is null or p_status not in ('completed'::public.appointment_status,
      'no_show'::public.appointment_status, 'cancelled_by_barber'::public.appointment_status)
  then raise exception 'Unsupported appointment status'; end if;

  select * into v_appointment from public.appointments a
  where a.id = p_appointment_id for update;
  if not found or v_appointment.barber_id <> v_barber then raise exception 'Appointment not found'; end if;
  if v_appointment.status <> 'booked'::public.appointment_status then raise exception 'Only booked appointments can be updated'; end if;
  if p_status in ('completed'::public.appointment_status, 'no_show'::public.appointment_status)
     and v_appointment.start_at > pg_catalog.now() then raise exception 'The appointment start time has not arrived'; end if;
  if p_status = 'cancelled_by_barber'::public.appointment_status
     and v_appointment.start_at <= pg_catalog.now() then raise exception 'Only future appointments can be cancelled'; end if;

  update public.appointments a set status = p_status where a.id = p_appointment_id;
  if p_status = 'completed'::public.appointment_status then
    v_points := pg_catalog.floor(v_appointment.estimated_total)::integer;
    if v_points > 0 then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        v_barber::text || ':' || v_appointment.customer_id::text, 0));
      insert into public.loyalty_transactions
        (barber_id, customer_id, amount, transaction_type, appointment_id, description)
      values (v_barber, v_appointment.customer_id, v_points,
        'appointment_earned'::public.loyalty_transaction_type, v_appointment.id,
        'Completed appointment')
      on conflict (appointment_id) where transaction_type = 'appointment_earned'::public.loyalty_transaction_type
      do nothing;
    end if;
  end if;

  return query select a.id, a.status, a.updated_at
  from public.appointments a where a.id = p_appointment_id;
end; $$;

revoke all on function public.get_customer_loyalty_accounts() from public;
revoke all on function public.get_barber_loyalty_customers() from public;
revoke all on function public.get_barber_customer_loyalty(uuid) from public;
revoke all on function public.redeem_loyalty_reward(uuid,uuid) from public;
revoke all on function public.update_barber_appointment_status(uuid,public.appointment_status) from public;
grant execute on function public.get_customer_loyalty_accounts() to authenticated;
grant execute on function public.get_barber_loyalty_customers() to authenticated;
grant execute on function public.get_barber_customer_loyalty(uuid) to authenticated;
grant execute on function public.redeem_loyalty_reward(uuid,uuid) to authenticated;
grant execute on function public.update_barber_appointment_status(uuid,public.appointment_status) to authenticated;
