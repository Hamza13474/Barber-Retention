-- Phase 8: barber-specific demo referral rewards.
-- Apply only after 20260908000000_phase_7_loyalty_last_visit_fix.sql.
-- The fixed demo reward is controlled exclusively here and is never accepted
-- from a client. Referral codes require an existing completed relationship.

-- Rebuild the Phase 7 enum instead of adding a value. PostgreSQL does not allow
-- a value added with ALTER TYPE ... ADD VALUE to be used until that transaction
-- commits, while a newly-created enum can be used immediately. Drop only the
-- two objects that depend structurally on the old enum, preserve every ledger
-- row by casting through text, and recreate them against the final enum below.
drop index public.loyalty_transactions_one_earning_per_appointment_idx;
alter table public.loyalty_transactions
  drop constraint loyalty_transactions_check;
alter type public.loyalty_transaction_type rename to loyalty_transaction_type_phase7;
create type public.loyalty_transaction_type as enum (
  'appointment_earned',
  'reward_redeemed',
  'referral_earned'
);
alter table public.loyalty_transactions
  alter column transaction_type type public.loyalty_transaction_type
  using transaction_type::text::public.loyalty_transaction_type;
drop type public.loyalty_transaction_type_phase7;

create unique index loyalty_transactions_one_earning_per_appointment_idx
  on public.loyalty_transactions (appointment_id)
  where transaction_type = 'appointment_earned'::public.loyalty_transaction_type;

create type public.customer_referral_status as enum ('pending', 'rewarded');

create table public.referral_codes (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references public.barber_profiles(id),
  referrer_customer_id uuid not null references public.customer_profiles(id),
  code text not null check (code ~ '^[A-Z0-9]{10}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (code),
  unique (barber_id, referrer_customer_id),
  unique (id, barber_id, referrer_customer_id)
);

create table public.customer_referrals (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references public.barber_profiles(id),
  referrer_customer_id uuid not null references public.customer_profiles(id),
  referred_customer_id uuid not null references public.customer_profiles(id),
  referral_code_id uuid not null,
  status public.customer_referral_status not null default 'pending',
  claimed_at timestamptz not null default now(),
  qualified_at timestamptz,
  qualifying_appointment_id uuid,
  reward_points integer not null default 50 check (reward_points = 50),
  created_at timestamptz not null default now(),
  foreign key (referral_code_id, barber_id, referrer_customer_id)
    references public.referral_codes (id, barber_id, referrer_customer_id),
  foreign key (barber_id, referred_customer_id, qualifying_appointment_id)
    references public.appointments (barber_id, customer_id, id),
  unique (barber_id, referred_customer_id),
  unique (qualifying_appointment_id),
  unique (barber_id, referrer_customer_id, id),
  check (referrer_customer_id <> referred_customer_id),
  check (
    (status = 'pending'::public.customer_referral_status
      and qualified_at is null and qualifying_appointment_id is null)
    or
    (status = 'rewarded'::public.customer_referral_status
      and qualified_at is not null and qualifying_appointment_id is not null
      and qualified_at >= claimed_at)
  )
);

create index customer_referrals_referrer_created_idx
  on public.customer_referrals (referrer_customer_id, created_at desc);
create index customer_referrals_pending_qualification_idx
  on public.customer_referrals (barber_id, referred_customer_id)
  where status = 'pending'::public.customer_referral_status;

alter table public.loyalty_transactions
  add column referral_id uuid;
alter table public.loyalty_transactions
  add constraint loyalty_transactions_referral_identity_fkey
  foreign key (barber_id, customer_id, referral_id)
  references public.customer_referrals (barber_id, referrer_customer_id, id);
alter table public.loyalty_transactions
  add constraint loyalty_transactions_source_check check (
    (transaction_type = 'appointment_earned'::public.loyalty_transaction_type
      and amount > 0 and appointment_id is not null and reward_id is null and referral_id is null)
    or
    (transaction_type = 'reward_redeemed'::public.loyalty_transaction_type
      and amount < 0 and appointment_id is null and reward_id is not null and referral_id is null)
    or
    (transaction_type = 'referral_earned'::public.loyalty_transaction_type
      and amount = 50 and appointment_id is null and reward_id is null and referral_id is not null)
  );
create unique index loyalty_transactions_one_reward_per_referral_idx
  on public.loyalty_transactions (referral_id)
  where transaction_type = 'referral_earned'::public.loyalty_transaction_type;

alter table public.referral_codes enable row level security;
alter table public.customer_referrals enable row level security;

create policy "Customers view own referral codes"
on public.referral_codes for select to authenticated
using (referrer_customer_id = auth.uid());
create policy "Referral participants view own referrals"
on public.customer_referrals for select to authenticated
using (
  referrer_customer_id = auth.uid()
  or referred_customer_id = auth.uid()
  or barber_id = auth.uid()
);

revoke all on public.referral_codes, public.customer_referrals from anon;
revoke all on public.referral_codes, public.customer_referrals from authenticated;
grant select on public.referral_codes, public.customer_referrals to authenticated;

-- Generates one stable, globally unambiguous code per completed
-- barber/customer relationship. 40 bits of server-generated randomness makes
-- collisions extremely unlikely; the unique constraint and retry make them safe.
create function public.get_customer_referral_overview()
returns table (
  barber_id uuid,
  barber_name text,
  referral_code text,
  reward_points integer,
  activity jsonb
)
language plpgsql security definer set search_path = '' as $$
declare
  v_customer uuid := auth.uid();
  v_relationship record;
  v_code text;
begin
  if v_customer is null or not exists (
    select 1 from public.profiles p
    where p.id = v_customer and p.role = 'customer'::public.user_role
  ) then
    raise exception 'Only authenticated customers can view referrals';
  end if;

  for v_relationship in
    select distinct a.barber_id
    from public.appointments a
    where a.customer_id = v_customer
      and a.status = 'completed'::public.appointment_status
    order by a.barber_id
  loop
    if not exists (
      select 1 from public.referral_codes rc
      where rc.barber_id = v_relationship.barber_id
        and rc.referrer_customer_id = v_customer
    ) then
      loop
        v_code := upper(substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 10));
        begin
          insert into public.referral_codes (barber_id, referrer_customer_id, code)
          values (v_relationship.barber_id, v_customer, v_code);
          exit;
        exception when unique_violation then
          if exists (
            select 1 from public.referral_codes rc
            where rc.barber_id = v_relationship.barber_id
              and rc.referrer_customer_id = v_customer
          ) then exit; end if;
        end;
      end loop;
    end if;
  end loop;

  return query
  select rc.barber_id,
    coalesce(nullif(bp.display_name, ''), p.full_name),
    rc.code,
    50,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', cr.id,
        'status', cr.status,
        'claimed_at', cr.claimed_at,
        'qualified_at', cr.qualified_at,
        'reward_points', cr.reward_points
      ) order by cr.created_at desc, cr.id desc)
      from public.customer_referrals cr
      where cr.referrer_customer_id = v_customer
        and cr.barber_id = rc.barber_id
    ), '[]'::jsonb)
  from public.referral_codes rc
  join public.barber_profiles bp on bp.id = rc.barber_id
  join public.profiles p on p.id = rc.barber_id
  where rc.referrer_customer_id = v_customer and rc.is_active
  order by 2;
end; $$;

-- Identity, barber and reward are all resolved server-side from the code and
-- auth.uid(). The account advisory lock serializes claiming with completion.
create function public.claim_referral_code(p_code text)
returns table (barber_id uuid, barber_name text, status public.customer_referral_status)
language plpgsql security definer set search_path = '' as $$
declare
  v_customer uuid := auth.uid();
  v_code public.referral_codes%rowtype;
  v_existing public.customer_referrals%rowtype;
begin
  if v_customer is null or not exists (
    select 1 from public.profiles p
    where p.id = v_customer and p.role = 'customer'::public.user_role
  ) then raise exception 'Only authenticated customers can claim referrals'; end if;
  if p_code is null or btrim(p_code) = '' then raise exception 'Enter a referral code'; end if;

  select * into v_code from public.referral_codes rc
  where rc.code = upper(btrim(p_code)) and rc.is_active
  for update;
  if not found then raise exception 'Referral code not found'; end if;
  if v_code.referrer_customer_id = v_customer then raise exception 'You cannot use your own referral code'; end if;

  -- A barber referral lock gives every claim/completion the same lock order;
  -- this also avoids cycles when two customers referred one another.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'referrals:' || v_code.barber_id::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_code.barber_id::text || ':' || v_customer::text, 0));

  select * into v_existing from public.customer_referrals cr
  where cr.barber_id = v_code.barber_id and cr.referred_customer_id = v_customer;
  if found then
    if v_existing.referrer_customer_id = v_code.referrer_customer_id then
      raise exception 'You have already claimed a referral for this barber';
    end if;
    raise exception 'A different referral is already connected to this barber';
  end if;
  if exists (
    select 1 from public.appointments a
    where a.barber_id = v_code.barber_id and a.customer_id = v_customer
      and a.status = 'completed'::public.appointment_status
  ) then raise exception 'Existing customers cannot claim a referral for this barber'; end if;

  insert into public.customer_referrals
    (barber_id, referrer_customer_id, referred_customer_id, referral_code_id)
  values (v_code.barber_id, v_code.referrer_customer_id, v_customer, v_code.id);

  return query
  select v_code.barber_id, coalesce(nullif(bp.display_name, ''), p.full_name),
    'pending'::public.customer_referral_status
  from public.barber_profiles bp join public.profiles p on p.id = bp.id
  where bp.id = v_code.barber_id;
end; $$;

-- Preserve the Phase 4 RPC signature/lifecycle, Phase 5 completed_at trigger,
-- and Phase 7 appointment earning. Both ledger credits and referral transition
-- are in the same transaction as the appointment status update.
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
  v_referral public.customer_referrals%rowtype;
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

  if p_status = 'completed'::public.appointment_status then
    -- Lock before the status update/completed_at trigger, so a simultaneous
    -- claim deterministically happens wholly before or wholly after completion.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'referrals:' || v_barber::text, 0));
    -- This is the same account lock key used by Phase 7 redemption/earning.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      v_barber::text || ':' || v_appointment.customer_id::text, 0));
  end if;

  update public.appointments a set status = p_status where a.id = p_appointment_id;
  if p_status = 'completed'::public.appointment_status then

    v_points := pg_catalog.floor(v_appointment.estimated_total)::integer;
    if v_points > 0 then
      insert into public.loyalty_transactions
        (barber_id, customer_id, amount, transaction_type, appointment_id, description)
      values (v_barber, v_appointment.customer_id, v_points,
        'appointment_earned'::public.loyalty_transaction_type, v_appointment.id,
        'Completed appointment')
      on conflict (appointment_id) where transaction_type = 'appointment_earned'::public.loyalty_transaction_type
      do nothing;
    end if;

    select * into v_referral from public.customer_referrals cr
    where cr.barber_id = v_barber
      and cr.referred_customer_id = v_appointment.customer_id
      and cr.status = 'pending'::public.customer_referral_status
      and cr.claimed_at <= (select a.completed_at from public.appointments a where a.id = v_appointment.id)
    for update;

    if found then
      -- Serialize the referrer's balance with reward redemption as well.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        v_barber::text || ':' || v_referral.referrer_customer_id::text, 0));
      update public.customer_referrals cr
      set status = 'rewarded'::public.customer_referral_status,
          qualified_at = (select a.completed_at from public.appointments a where a.id = v_appointment.id),
          qualifying_appointment_id = v_appointment.id
      where cr.id = v_referral.id;
      insert into public.loyalty_transactions
        (barber_id, customer_id, amount, transaction_type, referral_id, description)
      values (v_barber, v_referral.referrer_customer_id, 50,
        'referral_earned'::public.loyalty_transaction_type, v_referral.id,
        'Referral reward')
      on conflict (referral_id) where transaction_type = 'referral_earned'::public.loyalty_transaction_type
      do nothing;
    end if;
  end if;

  return query select a.id, a.status, a.updated_at
  from public.appointments a where a.id = p_appointment_id;
end; $$;

revoke all on function public.get_customer_referral_overview() from public;
revoke all on function public.claim_referral_code(text) from public;
revoke all on function public.update_barber_appointment_status(uuid,public.appointment_status) from public;
grant execute on function public.get_customer_referral_overview() to authenticated;
grant execute on function public.claim_referral_code(text) to authenticated;
grant execute on function public.update_barber_appointment_status(uuid,public.appointment_status) to authenticated;
