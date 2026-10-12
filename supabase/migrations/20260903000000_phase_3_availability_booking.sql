-- Phase 3: normalized availability and concurrency-safe multi-service booking.
create extension if not exists btree_gist;

alter table public.barber_profiles
  add column timezone text not null default 'Europe/London';

create or replace function public.validate_barber_timezone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown IANA timezone: %', new.timezone;
  end if;
  return new;
end; $$;
create trigger barber_profiles_validate_timezone before insert or update of timezone on public.barber_profiles
for each row execute procedure public.validate_barber_timezone();
revoke all on function public.validate_barber_timezone() from public;

-- Phase 1 allowed owner profile updates but did not make role immutable. Preserve normal
-- profile edits while rejecting role changes made through authenticated user sessions.
create or replace function public.prevent_authenticated_role_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.role is distinct from new.role
     and (auth.uid() is not null or current_user in ('authenticated', 'anon')) then
    raise exception 'Profile role cannot be changed by an authenticated user';
  end if;
  return new;
end; $$;
create trigger profiles_prevent_authenticated_role_change before update of role on public.profiles
for each row execute procedure public.prevent_authenticated_role_change();
revoke all on function public.prevent_authenticated_role_change() from public;

create table public.weekly_availability (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references public.barber_profiles(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6), -- PostgreSQL: Sunday = 0
  start_time time not null,
  end_time time not null,
  start_minute integer generated always as ((extract(epoch from start_time) / 60)::integer) stored,
  end_minute integer generated always as ((extract(epoch from end_time) / 60)::integer) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_time < end_time and start_time < time '24:00' and end_time < time '24:00'),
  exclude using gist (
    barber_id with =,
    weekday with =,
    int4range(start_minute, end_minute, '[)') with &&
  )
);

create table public.blocked_periods (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references public.barber_profiles(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_at < end_at)
);
create index blocked_periods_barber_time_idx on public.blocked_periods using gist (barber_id, tstzrange(start_at, end_at, '[)'));

create type public.appointment_status as enum (
  'booked', 'cancelled_by_customer', 'cancelled_by_barber', 'completed', 'no_show'
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references public.barber_profiles(id),
  customer_id uuid not null references public.customer_profiles(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status public.appointment_status not null default 'booked',
  total_duration_minutes integer not null check (total_duration_minutes > 0),
  estimated_total numeric(10,2) not null check (estimated_total >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_at < end_at)
);

-- PostgreSQL enforces this even for concurrent transactions. Only booked appointments block.
alter table public.appointments add constraint appointments_no_barber_overlap
  exclude using gist (barber_id with =, tstzrange(start_at, end_at, '[)') with &&)
  where (status = 'booked');
create index appointments_customer_start_idx on public.appointments (customer_id, start_at);
create index appointments_barber_start_idx on public.appointments (barber_id, start_at);

create table public.appointment_services (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  service_id uuid not null references public.services(id),
  service_name text not null,
  price numeric(10,2) not null check (price >= 0),
  duration_minutes integer not null check (duration_minutes > 0),
  created_at timestamptz not null default now(),
  unique (appointment_id, service_id)
);

create trigger weekly_availability_updated_at before update on public.weekly_availability for each row execute procedure public.set_updated_at();
create trigger blocked_periods_updated_at before update on public.blocked_periods for each row execute procedure public.set_updated_at();
create trigger appointments_updated_at before update on public.appointments for each row execute procedure public.set_updated_at();
revoke all on function public.set_updated_at() from public;

alter table public.weekly_availability enable row level security;
alter table public.blocked_periods enable row level security;
alter table public.appointments enable row level security;
alter table public.appointment_services enable row level security;

create policy "Barbers view own availability" on public.weekly_availability for select to authenticated using (barber_id = auth.uid());
create policy "Barbers insert own availability" on public.weekly_availability for insert to authenticated with check (barber_id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and role = 'barber'));
create policy "Barbers update own availability" on public.weekly_availability for update to authenticated using (barber_id = auth.uid()) with check (barber_id = auth.uid());
create policy "Barbers delete own availability" on public.weekly_availability for delete to authenticated using (barber_id = auth.uid());

create policy "Barbers view own blocked periods" on public.blocked_periods for select to authenticated using (barber_id = auth.uid());
create policy "Barbers insert own blocked periods" on public.blocked_periods for insert to authenticated with check (barber_id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and role = 'barber'));
create policy "Barbers update own blocked periods" on public.blocked_periods for update to authenticated using (barber_id = auth.uid()) with check (barber_id = auth.uid());
create policy "Barbers delete own blocked periods" on public.blocked_periods for delete to authenticated using (barber_id = auth.uid());

create policy "Participants view appointments" on public.appointments for select to authenticated using (customer_id = auth.uid() or barber_id = auth.uid());
create policy "Participants view appointment services" on public.appointment_services for select to authenticated using (exists (select 1 from public.appointments a where a.id = appointment_id and (a.customer_id = auth.uid() or a.barber_id = auth.uid())));

-- Tables are readable where policies allow, but sensitive appointment mutations are RPC-only.
revoke all on public.weekly_availability, public.blocked_periods, public.appointments, public.appointment_services from anon;
grant select, insert, update, delete on public.weekly_availability, public.blocked_periods to authenticated;
grant select on public.appointments, public.appointment_services to authenticated;

-- Temporary barber picker: returns only safe discovery fields and avoids weakening Phase 1 profile RLS.
create or replace function public.list_bookable_barbers()
returns table (id uuid, display_name text, city text, avatar_url text, timezone text)
language sql stable security definer set search_path = ''
as $$
  select bp.id, coalesce(nullif(bp.display_name, ''), p.full_name), bp.city, p.avatar_url, bp.timezone
  from public.barber_profiles bp join public.profiles p on p.id = bp.id
  where exists (select 1 from public.services s where s.barber_id = bp.id and s.is_active)
  order by 2;
$$;

create or replace function public.appointment_request_is_valid(p_barber_id uuid, p_start_at timestamptz, p_duration integer)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare tz text; local_start timestamp; local_end timestamp;
begin
  select timezone into tz from public.barber_profiles where id = p_barber_id;
  if tz is null or p_start_at <= pg_catalog.now() or p_duration <= 0 then return false; end if;
  local_start := p_start_at at time zone tz;
  local_end := (p_start_at + pg_catalog.make_interval(mins => p_duration)) at time zone tz;
  -- Canonical DST policy: PostgreSQL's deterministic AT TIME ZONE occurrence is the
  -- only accepted occurrence. Round trips reject non-canonical ambiguous instants.
  if (local_start at time zone tz) <> p_start_at
     or (local_end at time zone tz) <> p_start_at + pg_catalog.make_interval(mins => p_duration)
  then return false; end if;
  if local_start::date <> local_end::date then return false; end if;
  if not exists (
    select 1 from public.weekly_availability w
    where w.barber_id = p_barber_id and w.weekday = extract(dow from local_start)::integer
      and local_start::time >= w.start_time and local_end::time <= w.end_time
  ) then return false; end if;
  if exists (
    select 1 from public.blocked_periods b where b.barber_id = p_barber_id
      and pg_catalog.tstzrange(b.start_at, b.end_at, '[)') && pg_catalog.tstzrange(p_start_at, p_start_at + pg_catalog.make_interval(mins => p_duration), '[)')
  ) then return false; end if;
  if exists (
    select 1 from public.appointments a where a.barber_id = p_barber_id and a.status = 'booked'
      and pg_catalog.tstzrange(a.start_at, a.end_at, '[)') && pg_catalog.tstzrange(p_start_at, p_start_at + pg_catalog.make_interval(mins => p_duration), '[)')
  ) then return false; end if;
  return true;
end; $$;

create or replace function public.get_available_slots(p_barber_id uuid, p_date date, p_service_ids uuid[])
returns table (start_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare v_count integer; v_duration integer; v_timezone text;
begin
  if p_service_ids is null or pg_catalog.cardinality(p_service_ids) = 0 then
    raise exception 'Select at least one service';
  end if;
  if pg_catalog.cardinality(p_service_ids) <> (select pg_catalog.count(distinct x) from pg_catalog.unnest(p_service_ids) x) then
    raise exception 'Duplicate services are not allowed';
  end if;
  select pg_catalog.count(*), pg_catalog.sum(s.duration_minutes), bp.timezone
    into v_count, v_duration, v_timezone
  from public.services s join public.barber_profiles bp on bp.id = p_barber_id
  where s.id = any(p_service_ids) and s.barber_id = p_barber_id and s.is_active
  group by bp.timezone;
  if v_count is distinct from pg_catalog.cardinality(p_service_ids) then
    raise exception 'All services must be active and belong to this barber';
  end if;

  return query
  with local_candidates as (
    select gs as local_candidate
    from public.weekly_availability w
    cross join lateral pg_catalog.generate_series(
      p_date + w.start_time,
      p_date + w.end_time - pg_catalog.make_interval(mins => v_duration),
      interval '15 minutes'
    ) gs
    where w.barber_id = p_barber_id and w.weekday = extract(dow from p_date)::integer
  ), converted as (
    select local_candidate, local_candidate at time zone v_timezone as proposed
    from local_candidates
  )
  select distinct proposed
  from converted
  -- Reject spring-forward wall times and retain only PostgreSQL's deterministic
  -- standard-time occurrence during a fall-back ambiguity.
  where (proposed at time zone v_timezone) = local_candidate
    and public.appointment_request_is_valid(p_barber_id, proposed, v_duration)
  order by proposed;
end;
$$;

create or replace function public.book_appointment(p_barber_id uuid, p_service_ids uuid[], p_start_at timestamptz)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_customer uuid := auth.uid(); v_count integer; v_duration integer; v_total numeric(10,2); v_id uuid; v_snapshot_count integer;
begin
  if v_customer is null or not exists (select 1 from public.profiles where id = v_customer and role = 'customer') then raise exception 'Only authenticated customers can book'; end if;
  if p_service_ids is null or pg_catalog.cardinality(p_service_ids) = 0 then raise exception 'Select at least one service'; end if;
  if pg_catalog.cardinality(p_service_ids) <> (select pg_catalog.count(distinct x) from pg_catalog.unnest(p_service_ids) x) then raise exception 'Duplicate services are not allowed'; end if;
  -- Serialize booking validation per barber, then lock every existing selected service
  -- so its owner, active state, price and duration cannot change before snapshots exist.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_barber_id::text, 0));
  perform s.id from public.services s where s.id = any(p_service_ids) for share;
  select pg_catalog.count(*), pg_catalog.sum(s.duration_minutes), pg_catalog.sum(s.price) into v_count, v_duration, v_total
  from public.services s where s.id = any(p_service_ids) and s.barber_id = p_barber_id and s.is_active;
  if v_count <> pg_catalog.cardinality(p_service_ids) then raise exception 'All services must be active and belong to this barber'; end if;
  if not public.appointment_request_is_valid(p_barber_id, p_start_at, v_duration) then raise exception 'That time is no longer available'; end if;
  insert into public.appointments (barber_id, customer_id, start_at, end_at, total_duration_minutes, estimated_total)
  values (p_barber_id, v_customer, p_start_at, p_start_at + pg_catalog.make_interval(mins => v_duration), v_duration, v_total) returning id into v_id;
  insert into public.appointment_services (appointment_id, service_id, service_name, price, duration_minutes)
  select v_id, s.id, s.name, s.price, s.duration_minutes from public.services s
  where s.id = any(p_service_ids) and s.barber_id = p_barber_id and s.is_active;
  get diagnostics v_snapshot_count = row_count;
  if v_snapshot_count <> pg_catalog.cardinality(p_service_ids) then raise exception 'Service snapshot validation failed'; end if;
  return v_id;
end; $$;

create or replace function public.cancel_appointment(p_appointment_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  update public.appointments set status = case when customer_id = auth.uid() then 'cancelled_by_customer'::public.appointment_status else 'cancelled_by_barber'::public.appointment_status end
  where id = p_appointment_id and status = 'booked' and start_at > pg_catalog.now() and (customer_id = auth.uid() or barber_id = auth.uid());
  if not found then raise exception 'Appointment cannot be cancelled'; end if;
end; $$;

revoke all on function public.list_bookable_barbers() from public;
revoke all on function public.appointment_request_is_valid(uuid,timestamptz,integer) from public;
revoke all on function public.get_available_slots(uuid,date,uuid[]) from public;
revoke all on function public.book_appointment(uuid,uuid[],timestamptz) from public;
revoke all on function public.cancel_appointment(uuid) from public;
grant execute on function public.list_bookable_barbers() to authenticated;
grant execute on function public.get_available_slots(uuid,date,uuid[]) to authenticated;
grant execute on function public.book_appointment(uuid,uuid[],timestamptz) to authenticated;
grant execute on function public.cancel_appointment(uuid) to authenticated;
