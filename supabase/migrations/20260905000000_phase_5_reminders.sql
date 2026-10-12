-- Phase 5: server-owned appointment and routine reminders plus private Expo push registrations.
-- Apply only after 20260904000000_phase_4_calendar_appointment_management.sql.

create type public.reminder_type as enum ('appointment_24h', 'appointment_2h', 'routine_return');
create type public.reminder_status as enum ('pending', 'processing', 'delivered', 'suppressed', 'failed');

-- A completion is a business event, not the last arbitrary update.
alter table public.appointments add column completed_at timestamptz;
update public.appointments
set completed_at = updated_at
where status = 'completed'::public.appointment_status;
alter table public.appointments add constraint appointments_completed_at_matches_status
  check ((status = 'completed'::public.appointment_status) = (completed_at is not null));

create or replace function public.set_appointment_completed_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'booked'::public.appointment_status or new.completed_at is not null then
      raise exception 'New appointments must begin booked and incomplete';
    end if;
    return new;
  end if;
  if old.status is distinct from new.status then
    if old.status = 'booked'::public.appointment_status
       and new.status = 'completed'::public.appointment_status then
      new.completed_at := pg_catalog.now();
    elsif new.status <> 'completed'::public.appointment_status then
      new.completed_at := null;
    end if;
  elsif new.completed_at is distinct from old.completed_at then
    raise exception 'completed_at is managed by appointment status transitions';
  end if;
  return new;
end; $$;
create trigger appointments_manage_completed_at
before insert or update on public.appointments
for each row execute procedure public.set_appointment_completed_at();
revoke all on function public.set_appointment_completed_at() from public;

-- Phase 3 did not snapshot this value. Existing rows receive a one-time best-effort
-- snapshot of the catalog value as it exists when Phase 5 is applied. From this
-- migration onward, booking captures it atomically with name/price/duration.
alter table public.appointment_services
  add column recommended_return_days integer check (recommended_return_days > 0);
update public.appointment_services aps
set recommended_return_days = s.recommended_return_days
from public.services s
where s.id = aps.service_id;

create table public.push_device_registrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expo_push_token text not null unique
    check (expo_push_token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$'),
  device_id text not null check (char_length(device_id) between 16 and 200),
  platform text not null check (platform in ('android', 'ios')),
  is_active boolean not null default true,
  last_registered_at timestamptz not null default now(),
  deactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, device_id),
  check ((is_active and deactivated_at is null) or (not is_active))
);
create index push_device_registrations_active_user_idx
  on public.push_device_registrations (user_id) where is_active;
alter table public.push_device_registrations enable row level security;
-- Intentionally no table policies: even owners cannot SELECT token material.
revoke all on table public.push_device_registrations from anon, authenticated;
create trigger push_device_registrations_updated_at before update on public.push_device_registrations
for each row execute procedure public.set_updated_at();

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customer_profiles(id) on delete cascade,
  barber_id uuid not null references public.barber_profiles(id),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  reminder_type public.reminder_type not null,
  scheduled_for timestamptz not null,
  expires_at timestamptz not null,
  status public.reminder_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null,
  processing_started_at timestamptz,
  -- A fresh unpredictable token owns each five-minute processing lease. Workers
  -- must present it to prepare/finalize, so an expired worker cannot mutate a
  -- row after another worker has reclaimed it.
  claim_token uuid,
  delivered_at timestamptz,
  suppressed_at timestamptz,
  suppression_reason text,
  last_error text,
  expo_ticket_ids jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, reminder_type),
  check (scheduled_for < expires_at),
  check ((status = 'processing'::public.reminder_status) =
    (processing_started_at is not null and claim_token is not null)),
  check ((status = 'delivered'::public.reminder_status) = (delivered_at is not null)),
  check ((status = 'suppressed'::public.reminder_status) = (suppressed_at is not null))
);
create index reminders_due_idx on public.reminders (next_attempt_at, scheduled_for)
  where status in ('pending', 'processing');
alter table public.reminders enable row level security;
-- Server-owned queue: normal clients do not read or mutate delivery state.
revoke all on table public.reminders from anon, authenticated;
create trigger reminders_updated_at before update on public.reminders
for each row execute procedure public.set_updated_at();

create or replace function public.register_push_device(
  p_expo_push_token text, p_device_id text, p_platform text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_id uuid; v_owner uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.customer_profiles cp where cp.id = v_user) then
    raise exception 'Only customers can register for reminders';
  end if;
  if p_expo_push_token is null or p_expo_push_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$'
     or p_device_id is null or char_length(p_device_id) not between 16 and 200
     or p_platform not in ('android', 'ios') then
    raise exception 'Invalid push registration';
  end if;
  select r.user_id into v_owner from public.push_device_registrations r
  where r.expo_push_token = p_expo_push_token for update;
  if v_owner is not null and v_owner <> v_user then
    raise exception 'Push token is already registered';
  end if;
  insert into public.push_device_registrations
    (user_id, expo_push_token, device_id, platform)
  values (v_user, p_expo_push_token, p_device_id, p_platform)
  on conflict (user_id, device_id) do update set
    expo_push_token = excluded.expo_push_token, platform = excluded.platform,
    is_active = true, deactivated_at = null, last_registered_at = pg_catalog.now()
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.deactivate_push_device(p_device_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.push_device_registrations r
  set is_active = false, deactivated_at = pg_catalog.now()
  where r.user_id = auth.uid() and r.device_id = p_device_id;
end; $$;

-- Explicit logout releases ownership rather than merely deactivating it. The
-- authenticated identity is always derived from auth.uid(); callers can release
-- only their own installation and never supply user ownership.
create or replace function public.release_push_device(p_device_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_deleted integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_device_id is null or char_length(p_device_id) not between 16 and 200 then
    raise exception 'Invalid device identifier';
  end if;
  delete from public.push_device_registrations r
  where r.user_id = v_user and r.device_id = p_device_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end; $$;

-- Replace Phase 3 booking solely to include the new immutable return-day snapshot.
create or replace function public.book_appointment(p_barber_id uuid, p_service_ids uuid[], p_start_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_customer uuid := auth.uid(); v_count integer; v_duration integer; v_total numeric(10,2); v_id uuid; v_snapshot_count integer;
begin
  if v_customer is null or not exists (select 1 from public.profiles where id = v_customer and role = 'customer') then raise exception 'Only authenticated customers can book'; end if;
  if p_service_ids is null or pg_catalog.cardinality(p_service_ids) = 0 then raise exception 'Select at least one service'; end if;
  if pg_catalog.cardinality(p_service_ids) <> (select pg_catalog.count(distinct x) from pg_catalog.unnest(p_service_ids) x) then raise exception 'Duplicate services are not allowed'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_barber_id::text, 0));
  perform s.id from public.services s where s.id = any(p_service_ids) for share;
  select pg_catalog.count(*), pg_catalog.sum(s.duration_minutes), pg_catalog.sum(s.price) into v_count, v_duration, v_total
  from public.services s where s.id = any(p_service_ids) and s.barber_id = p_barber_id and s.is_active;
  if v_count <> pg_catalog.cardinality(p_service_ids) then raise exception 'All services must be active and belong to this barber'; end if;
  if not public.appointment_request_is_valid(p_barber_id, p_start_at, v_duration) then raise exception 'That time is no longer available'; end if;
  insert into public.appointments (barber_id, customer_id, start_at, end_at, total_duration_minutes, estimated_total)
  values (p_barber_id, v_customer, p_start_at, p_start_at + pg_catalog.make_interval(mins => v_duration), v_duration, v_total) returning id into v_id;
  insert into public.appointment_services (appointment_id, service_id, service_name, price, duration_minutes, recommended_return_days)
  select v_id, s.id, s.name, s.price, s.duration_minutes, s.recommended_return_days from public.services s
  where s.id = any(p_service_ids) and s.barber_id = p_barber_id and s.is_active;
  get diagnostics v_snapshot_count = row_count;
  if v_snapshot_count <> pg_catalog.cardinality(p_service_ids) then raise exception 'Service snapshot validation failed'; end if;
  return v_id;
end; $$;

-- Runs ahead of delivery (for example every 15 minutes). Past appointment slots
-- are never backfilled: scheduled_for must still be in the future and must not
-- precede the time the appointment was created.
create or replace function public.generate_due_reminders()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0; v_inserted integer := 0;
begin
  insert into public.reminders
    (customer_id, barber_id, appointment_id, reminder_type, scheduled_for, expires_at, next_attempt_at)
  select a.customer_id, a.barber_id, a.id, x.kind, x.due, a.start_at, x.due
  from public.appointments a
  cross join lateral (values
    ('appointment_24h'::public.reminder_type, a.start_at - interval '24 hours'),
    ('appointment_2h'::public.reminder_type, a.start_at - interval '2 hours')
  ) x(kind, due)
  join public.customer_profiles cp on cp.id = a.customer_id and cp.notifications_enabled
  where a.status = 'booked'::public.appointment_status
    and x.due >= a.created_at and x.due > pg_catalog.now()
  on conflict (appointment_id, reminder_type) do nothing;
  get diagnostics v_count = row_count;

  insert into public.reminders
    (customer_id, barber_id, appointment_id, reminder_type, scheduled_for, expires_at, next_attempt_at)
  select a.customer_id, a.barber_id, a.id, 'routine_return'::public.reminder_type,
         a.end_at + pg_catalog.make_interval(days => min(aps.recommended_return_days)),
         -- Appointment reminders expire at appointment start; routine return
         -- reminders remain useful for seven days after their calculated due time.
         a.end_at + pg_catalog.make_interval(days => min(aps.recommended_return_days)) + interval '7 days',
         a.end_at + pg_catalog.make_interval(days => min(aps.recommended_return_days))
  from public.appointments a
  join public.appointment_services aps on aps.appointment_id = a.id and aps.recommended_return_days is not null
  join public.customer_profiles cp on cp.id = a.customer_id and cp.notifications_enabled
  where a.status = 'completed'::public.appointment_status and a.completed_at is not null
  group by a.id
  having a.end_at + pg_catalog.make_interval(days => min(aps.recommended_return_days)) > pg_catalog.now()
  on conflict (appointment_id, reminder_type) do nothing;
  get diagnostics v_inserted = row_count;
  return v_count + v_inserted;
end; $$;

create or replace function public.reminder_is_deliverable(p_reminder_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.reminders r
    join public.appointments a on a.id = r.appointment_id
    join public.customer_profiles cp on cp.id = r.customer_id
    where r.id = p_reminder_id and a.customer_id = r.customer_id and a.barber_id = r.barber_id
      and cp.notifications_enabled and r.delivered_at is null and pg_catalog.now() <= r.expires_at
      and (
        (r.reminder_type in ('appointment_24h','appointment_2h') and a.status = 'booked'::public.appointment_status and a.start_at > pg_catalog.now())
        or
        (r.reminder_type = 'routine_return' and a.status = 'completed'::public.appointment_status and a.completed_at is not null
          -- The CTA exists to obtain a booking. Any still-future booked visit
          -- with this same barber, made after the source service visit, suppresses
          -- it regardless of whether that booking is before or after the due date.
          and not exists (
            select 1 from public.appointments future
            where future.customer_id = r.customer_id and future.barber_id = r.barber_id
              and future.status = 'booked'::public.appointment_status
              and future.start_at > a.end_at and future.start_at > pg_catalog.now()
          ))
      )
  );
$$;

create or replace function public.claim_due_reminders(p_limit integer default 50)
returns table (id uuid, claim_token uuid) language plpgsql security definer set search_path = '' as $$
begin
  if p_limit not between 1 and 100 then raise exception 'Invalid batch size'; end if;
  -- Recover an abandoned five-minute lease only while attempts remain. A crash
  -- cannot permanently strand work, but attempt_count >= 5 is never reclaimed.
  update public.reminders set status = 'pending'::public.reminder_status,
    processing_started_at = null, claim_token = null
  where status = 'processing'::public.reminder_status
    and processing_started_at < pg_catalog.now() - interval '5 minutes'
    and attempt_count < 5;
  update public.reminders set status = 'failed'::public.reminder_status,
    processing_started_at = null, claim_token = null,
    last_error = coalesce(last_error, 'Maximum delivery attempts reached')
  where status = 'processing'::public.reminder_status
    and processing_started_at < pg_catalog.now() - interval '5 minutes'
    and attempt_count >= 5;
  update public.reminders r set status = 'suppressed'::public.reminder_status,
    suppressed_at = pg_catalog.now(), suppression_reason = 'No longer eligible',
    processing_started_at = null, claim_token = null
  where r.status = 'pending'::public.reminder_status and r.scheduled_for <= pg_catalog.now()
    and not public.reminder_is_deliverable(r.id);
  return query
  with picked as (
    select r.id from public.reminders r
    where r.status = 'pending'::public.reminder_status and r.scheduled_for <= pg_catalog.now()
      and r.next_attempt_at <= pg_catalog.now() and r.attempt_count < 5
      and public.reminder_is_deliverable(r.id)
    order by r.scheduled_for for update skip locked limit p_limit
  )
  update public.reminders r set status = 'processing'::public.reminder_status,
    processing_started_at = pg_catalog.now(), attempt_count = attempt_count + 1,
    claim_token = pg_catalog.gen_random_uuid()
  from picked where r.id = picked.id returning r.id, r.claim_token;
end; $$;

create or replace function public.prepare_reminder_delivery(p_reminder_id uuid, p_claim_token uuid)
returns table (id uuid, title text, body text, data jsonb, expo_push_tokens text[])
language plpgsql security definer set search_path = '' as $$
declare r public.reminders%rowtype; a public.appointments%rowtype; v_barber text; v_service text; v_tz text;
begin
  select * into r from public.reminders x where x.id = p_reminder_id for update;
  if not found or r.status <> 'processing'::public.reminder_status
     or r.claim_token is distinct from p_claim_token then return; end if;
  if not public.reminder_is_deliverable(r.id) then
    -- Suppression is terminal anti-spam behavior. Re-enabling preferences later
    -- does not resurrect this exact row; future eligible reminders are unaffected.
    update public.reminders set status='suppressed', suppressed_at=pg_catalog.now(),
      suppression_reason='Failed delivery revalidation', processing_started_at=null, claim_token=null
    where reminders.id=r.id and reminders.status='processing' and reminders.claim_token=p_claim_token;
    return;
  end if;
  select * into a from public.appointments x where x.id=r.appointment_id;
  select coalesce(nullif(bp.display_name,''),p.full_name), bp.timezone into v_barber,v_tz
  from public.barber_profiles bp join public.profiles p on p.id=bp.id where bp.id=r.barber_id;
  select min(aps.service_name) into v_service from public.appointment_services aps where aps.appointment_id=r.appointment_id;
  return query select r.id,
    case when r.reminder_type='routine_return' then 'Time for your next cut?' else case when r.reminder_type='appointment_24h' then 'Appointment tomorrow' else 'Appointment soon' end end,
    case when r.reminder_type='routine_return' then pg_catalog.format('It may be time to book your next %s with %s.',coalesce(v_service,'service'),v_barber)
         else pg_catalog.format('Your appointment with %s is %s at %s.',v_barber,case when r.reminder_type='appointment_24h' then 'tomorrow' else 'in about 2 hours' end,to_char(a.start_at at time zone v_tz,'HH24:MI')) end,
    case when r.reminder_type='routine_return' then pg_catalog.jsonb_build_object('route','booking','barberId',r.barber_id,'reminderId',r.id)
         else pg_catalog.jsonb_build_object('route','appointments','appointmentId',r.appointment_id,'reminderId',r.id) end,
    coalesce((select array_agg(d.expo_push_token) from public.push_device_registrations d where d.user_id=r.customer_id and d.is_active),array[]::text[]);
end; $$;

create or replace function public.finish_reminder_delivery(p_reminder_id uuid, p_claim_token uuid, p_ticket_ids jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_updated integer;
begin
  update public.reminders set status='delivered', delivered_at=pg_catalog.now(),
    processing_started_at=null, claim_token=null, expo_ticket_ids=p_ticket_ids, last_error=null
  where id=p_reminder_id and status='processing' and claim_token=p_claim_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end; $$;

create or replace function public.fail_reminder_delivery(p_reminder_id uuid, p_claim_token uuid, p_error text, p_retry boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_updated integer;
begin
  update public.reminders set status=case when p_retry and attempt_count < 5 then 'pending'::public.reminder_status else 'failed'::public.reminder_status end,
    processing_started_at=null, claim_token=null, last_error=left(coalesce(p_error,'Delivery failed'),500),
    next_attempt_at=pg_catalog.now()+pg_catalog.make_interval(secs => least(3600, 60*(2^greatest(attempt_count-1,0))::integer))
  where id=p_reminder_id and status='processing' and claim_token=p_claim_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end; $$;

create or replace function public.deactivate_push_token(p_expo_push_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_updated integer;
begin
  update public.push_device_registrations set is_active=false,deactivated_at=pg_catalog.now()
  where expo_push_token=p_expo_push_token and is_active;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.register_push_device(text,text,text) from public;
revoke all on function public.deactivate_push_device(text) from public;
revoke all on function public.release_push_device(text) from public;
grant execute on function public.register_push_device(text,text,text) to authenticated;
grant execute on function public.deactivate_push_device(text) to authenticated;
grant execute on function public.release_push_device(text) to authenticated;

revoke all on function public.generate_due_reminders() from public;
revoke all on function public.reminder_is_deliverable(uuid) from public;
revoke all on function public.claim_due_reminders(integer) from public;
revoke all on function public.prepare_reminder_delivery(uuid,uuid) from public;
revoke all on function public.finish_reminder_delivery(uuid,uuid,jsonb) from public;
revoke all on function public.fail_reminder_delivery(uuid,uuid,text,boolean) from public;
revoke all on function public.deactivate_push_token(text) from public;
grant execute on function public.generate_due_reminders() to service_role;
grant execute on function public.claim_due_reminders(integer) to service_role;
grant execute on function public.prepare_reminder_delivery(uuid,uuid) to service_role;
grant execute on function public.finish_reminder_delivery(uuid,uuid,jsonb) to service_role;
grant execute on function public.fail_reminder_delivery(uuid,uuid,text,boolean) to service_role;
grant execute on function public.deactivate_push_token(text) to service_role;

-- Restore the existing authenticated booking permission after CREATE OR REPLACE.
revoke all on function public.book_appointment(uuid,uuid[],timestamptz) from public;
grant execute on function public.book_appointment(uuid,uuid[],timestamptz) to authenticated;

-- Include the added fields in the Phase 4 calendar payload without changing its authorization.
drop function public.get_barber_calendar(timestamptz,timestamptz);
create function public.get_barber_calendar(p_from timestamptz,p_to timestamptz)
returns table (id uuid,customer_name text,start_at timestamptz,end_at timestamptz,status public.appointment_status,total_duration_minutes integer,estimated_total numeric(10,2),created_at timestamptz,updated_at timestamptz,completed_at timestamptz,services jsonb)
language plpgsql stable security definer set search_path='' as $$
declare v_barber uuid:=auth.uid();
begin
  if v_barber is null or not exists(select 1 from public.profiles p join public.barber_profiles bp on bp.id=p.id where p.id=v_barber and p.role='barber') then raise exception 'Only authenticated barbers can view a barber calendar'; end if;
  if p_from is null or p_to is null or p_from>=p_to or p_to-p_from>interval '40 days' then raise exception 'Calendar range must be between 1 second and 40 days'; end if;
  return query select a.id,p.full_name,a.start_at,a.end_at,a.status,a.total_duration_minutes,a.estimated_total,a.created_at,a.updated_at,a.completed_at,
    coalesce((select jsonb_agg(jsonb_build_object('id',aps.id,'appointment_id',aps.appointment_id,'service_id',aps.service_id,'service_name',aps.service_name,'price',aps.price,'duration_minutes',aps.duration_minutes,'recommended_return_days',aps.recommended_return_days,'created_at',aps.created_at) order by aps.created_at,aps.id) from public.appointment_services aps where aps.appointment_id=a.id),'[]'::jsonb)
  from public.appointments a join public.profiles p on p.id=a.customer_id where a.barber_id=v_barber and a.start_at<p_to and a.end_at>p_from order by a.start_at,a.id;
end; $$;
revoke all on function public.get_barber_calendar(timestamptz,timestamptz) from public;
grant execute on function public.get_barber_calendar(timestamptz,timestamptz) to authenticated;
