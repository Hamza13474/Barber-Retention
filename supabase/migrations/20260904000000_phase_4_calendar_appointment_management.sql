-- Phase 4: barber calendar reads, trusted appointment lifecycle changes, and
-- race-safe blocked time. Apply only after the Phase 3 migration.

-- Calendar-created blocks infer the authenticated owner. Phase 3's WITH CHECK
-- policy still verifies that the caller owns the row and has the barber role.
alter table public.blocked_periods alter column barber_id set default auth.uid();

-- Phase 3 allowed deletion of any owned block. Calendar history should remain an
-- audit trail, so normal clients may remove only blocks that have not started.
drop policy "Barbers delete own blocked periods" on public.blocked_periods;
create policy "Barbers delete own future blocked periods"
on public.blocked_periods for delete to authenticated
using (barber_id = auth.uid() and start_at > pg_catalog.now());

create or replace function public.get_barber_calendar(
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  id uuid,
  customer_name text,
  start_at timestamptz,
  end_at timestamptz,
  status public.appointment_status,
  total_duration_minutes integer,
  estimated_total numeric(10,2),
  created_at timestamptz,
  updated_at timestamptz,
  services jsonb
)
language plpgsql stable security definer set search_path = ''
as $$
declare v_barber uuid := auth.uid();
begin
  if v_barber is null or not exists (
    select 1 from public.profiles p
    join public.barber_profiles bp on bp.id = p.id
    where p.id = v_barber and p.role = 'barber'
  ) then
    raise exception 'Only authenticated barbers can view a barber calendar';
  end if;
  if p_from is null or p_to is null or p_from >= p_to
     or p_to - p_from > interval '40 days' then
    raise exception 'Calendar range must be between 1 second and 40 days';
  end if;

  return query
  select a.id, p.full_name, a.start_at, a.end_at, a.status,
         a.total_duration_minutes, a.estimated_total, a.created_at, a.updated_at,
         coalesce((
           select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', aps.id,
               'appointment_id', aps.appointment_id,
               'service_id', aps.service_id,
               'service_name', aps.service_name,
               'price', aps.price,
               'duration_minutes', aps.duration_minutes,
               'created_at', aps.created_at
             ) order by aps.created_at, aps.id
           )
           from public.appointment_services aps where aps.appointment_id = a.id
         ), '[]'::jsonb)
  from public.appointments a
  join public.profiles p on p.id = a.customer_id
  where a.barber_id = v_barber and a.start_at < p_to and a.end_at > p_from
  order by a.start_at, a.id;
end;
$$;

create or replace function public.update_barber_appointment_status(
  p_appointment_id uuid,
  p_status public.appointment_status
)
returns table (id uuid, status public.appointment_status, updated_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare v_barber uuid := auth.uid(); v_appointment public.appointments%rowtype;
begin
  if v_barber is null or not exists (
    select 1 from public.profiles p
    join public.barber_profiles bp on bp.id = p.id
    where p.id = v_barber and p.role = 'barber'
  ) then
    raise exception 'Only authenticated barbers can manage appointments';
  end if;
  if p_status is null or p_status not in ('completed'::public.appointment_status,
                      'no_show'::public.appointment_status,
                      'cancelled_by_barber'::public.appointment_status) then
    raise exception 'Unsupported appointment status';
  end if;

  select * into v_appointment from public.appointments a
  where a.id = p_appointment_id for update;
  if not found or v_appointment.barber_id <> v_barber then
    raise exception 'Appointment not found';
  end if;
  if v_appointment.status <> 'booked'::public.appointment_status then
    raise exception 'Only booked appointments can be updated';
  end if;
  if p_status in ('completed'::public.appointment_status, 'no_show'::public.appointment_status)
     and v_appointment.start_at > pg_catalog.now() then
    raise exception 'The appointment start time has not arrived';
  end if;
  if p_status = 'cancelled_by_barber'::public.appointment_status
     and v_appointment.start_at <= pg_catalog.now() then
    raise exception 'Only future appointments can be cancelled';
  end if;

  return query
  update public.appointments a set status = p_status
  where a.id = p_appointment_id
  returning a.id, a.status, a.updated_at;
end;
$$;

create or replace function public.prevent_blocked_period_appointment_overlap()
returns trigger language plpgsql set search_path = ''
as $$
begin
  -- Uses the same transaction lock key as Phase 3 booking, closing the race
  -- between availability validation and inserting/updating a blocked period.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.barber_id::text, 0));
  if exists (
    select 1 from public.appointments a
    where a.barber_id = new.barber_id
      and a.status = 'booked'::public.appointment_status
      and pg_catalog.tstzrange(a.start_at, a.end_at, '[)')
          && pg_catalog.tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception 'Blocked time overlaps a booked appointment';
  end if;
  return new;
end;
$$;

create trigger blocked_periods_prevent_booked_overlap
before insert or update of barber_id, start_at, end_at on public.blocked_periods
for each row execute procedure public.prevent_blocked_period_appointment_overlap();

revoke all on function public.get_barber_calendar(timestamptz,timestamptz) from public;
revoke all on function public.update_barber_appointment_status(uuid,public.appointment_status) from public;
revoke all on function public.prevent_blocked_period_appointment_overlap() from public;
grant execute on function public.get_barber_calendar(timestamptz,timestamptz) to authenticated;
grant execute on function public.update_barber_appointment_status(uuid,public.appointment_status) to authenticated;

-- Appointment tables remain SELECT-only for authenticated clients. No direct
-- UPDATE grant or policy is introduced by Phase 4.
