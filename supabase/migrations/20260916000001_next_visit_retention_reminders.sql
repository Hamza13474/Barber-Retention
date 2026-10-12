-- Final demo Step C: prospective, completion-owned next-visit reminders.
-- Requires 20260916000000_add_retention_reminder_types.sql.
-- Existing appointment reminder delivery remains on the Phase 5 queue/worker.

-- Applying this migration does not invoke this trigger for historical rows.
create function public.schedule_retention_reminders_on_completion()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_timezone text;
  v_return_days integer;
  v_expected_date date;
  v_due_soon timestamptz;
  v_due timestamptz;
  v_due_soon_type text := 'retention_due_soon';
  v_due_type text := 'retention_due';
begin
  if old.status is distinct from 'booked'::public.appointment_status
     or new.status is distinct from 'completed'::public.appointment_status then
    return new;
  end if;

  select bp.timezone into v_timezone
  from public.barber_profiles bp where bp.id = new.barber_id;

  select pg_catalog.min(aps.recommended_return_days) into v_return_days
  from public.appointment_services aps
  where aps.appointment_id = new.id and aps.recommended_return_days is not null;

  if v_timezone is null or v_return_days is null then return new; end if;

  -- Match Phase 10 exactly: barber-local appointment date plus the minimum
  -- non-null historical service-snapshot return interval.
  v_expected_date := (new.start_at at time zone v_timezone)::date + v_return_days;
  v_due := (v_expected_date + time '10:00') at time zone v_timezone;
  v_due_soon := ((v_expected_date - 7) + time '10:00') at time zone v_timezone;

  update public.reminders r
  set status = 'suppressed'::public.reminder_status,
      suppressed_at = pg_catalog.now(),
      suppression_reason = 'Superseded by a newer completed appointment',
      processing_started_at = null,
      claim_token = null
  where r.customer_id = new.customer_id and r.barber_id = new.barber_id
    and r.appointment_id <> new.id
    and r.reminder_type::text in ('routine_return', 'retention_due_soon', 'retention_due')
    and r.status in ('pending'::public.reminder_status, 'processing'::public.reminder_status);

  if v_return_days > 7 and v_due_soon > pg_catalog.now() then
    insert into public.reminders
      (customer_id, barber_id, appointment_id, reminder_type, scheduled_for, expires_at, next_attempt_at)
    values (new.customer_id, new.barber_id, new.id, v_due_soon_type::public.reminder_type,
      v_due_soon, v_due_soon + interval '1 day', v_due_soon)
    on conflict (appointment_id, reminder_type) do nothing;
  end if;

  if v_due > pg_catalog.now() then
    insert into public.reminders
      (customer_id, barber_id, appointment_id, reminder_type, scheduled_for, expires_at, next_attempt_at)
    values (new.customer_id, new.barber_id, new.id, v_due_type::public.reminder_type,
      v_due, v_due + interval '1 day', v_due)
    on conflict (appointment_id, reminder_type) do nothing;
  end if;

  return new;
end; $$;

create trigger appointments_schedule_retention_reminders
after update of status on public.appointments
for each row execute procedure public.schedule_retention_reminders_on_completion();
revoke all on function public.schedule_retention_reminders_on_completion() from public;

-- Retire the old one-off routine rows; the new fixed cycle is prospective.
update public.reminders
set status = 'suppressed'::public.reminder_status,
    suppressed_at = pg_catalog.now(),
    suppression_reason = 'Replaced by fixed next-visit reminder schedule',
    processing_started_at = null,
    claim_token = null
where reminder_type = 'routine_return'::public.reminder_type
  and status in ('pending'::public.reminder_status, 'processing'::public.reminder_status);

-- Continue generating Phase 5 appointment reminders only. The legacy app-level
-- preference no longer gates standard product notifications, and retention is
-- not scanned here, so historical completions are never backfilled.
create or replace function public.generate_due_reminders()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0;
begin
  insert into public.reminders
    (customer_id, barber_id, appointment_id, reminder_type, scheduled_for, expires_at, next_attempt_at)
  select a.customer_id, a.barber_id, a.id, x.kind, x.due, a.start_at, x.due
  from public.appointments a
  cross join lateral (values
    ('appointment_24h'::public.reminder_type, a.start_at - interval '24 hours'),
    ('appointment_2h'::public.reminder_type, a.start_at - interval '2 hours')
  ) x(kind, due)
  join public.customer_profiles cp on cp.id = a.customer_id
  where a.status = 'booked'::public.appointment_status
    and x.due >= a.created_at and x.due > pg_catalog.now()
  on conflict (appointment_id, reminder_type) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end; $$;

create or replace function public.reminder_is_deliverable(p_reminder_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.reminders r
    join public.appointments a on a.id = r.appointment_id
    join public.customer_profiles cp on cp.id = r.customer_id
    where r.id = p_reminder_id and a.customer_id = r.customer_id and a.barber_id = r.barber_id
      and r.delivered_at is null and pg_catalog.now() <= r.expires_at
      and (
        (r.reminder_type in ('appointment_24h'::public.reminder_type, 'appointment_2h'::public.reminder_type)
          and a.status = 'booked'::public.appointment_status and a.start_at > pg_catalog.now())
        or
        (r.reminder_type::text in ('retention_due_soon', 'retention_due')
          and a.status = 'completed'::public.appointment_status and a.completed_at is not null
          and not exists (
            select 1 from public.appointments newer
            where newer.customer_id = r.customer_id and newer.barber_id = r.barber_id
              and newer.status = 'completed'::public.appointment_status and newer.completed_at > a.completed_at
          )
          and not exists (
            select 1 from public.appointments future
            where future.customer_id = r.customer_id and future.barber_id = r.barber_id
              and future.status = 'booked'::public.appointment_status and future.start_at > pg_catalog.now()
          ))
      )
  );
$$;

create or replace function public.prepare_reminder_delivery(p_reminder_id uuid, p_claim_token uuid)
returns table (id uuid, title text, body text, data jsonb, expo_push_tokens text[])
language plpgsql security definer set search_path = '' as $$
declare
  r public.reminders%rowtype;
  a public.appointments%rowtype;
  v_barber text;
  v_timezone text;
  v_service_ids jsonb;
begin
  select * into r from public.reminders x where x.id = p_reminder_id for update;
  if not found or r.status <> 'processing'::public.reminder_status
     or r.claim_token is distinct from p_claim_token then return; end if;

  if not public.reminder_is_deliverable(r.id) then
    update public.reminders set status = 'suppressed'::public.reminder_status,
      suppressed_at = pg_catalog.now(), suppression_reason = 'Failed delivery revalidation',
      processing_started_at = null, claim_token = null
    where reminders.id = r.id and reminders.status = 'processing'::public.reminder_status
      and reminders.claim_token = p_claim_token;
    return;
  end if;

  select * into a from public.appointments x where x.id = r.appointment_id;
  select coalesce(nullif(bp.display_name, ''), p.full_name), bp.timezone into v_barber, v_timezone
  from public.barber_profiles bp join public.profiles p on p.id = bp.id where bp.id = r.barber_id;
  select coalesce(pg_catalog.jsonb_agg(aps.service_id order by aps.created_at, aps.id), '[]'::jsonb)
  into v_service_ids from public.appointment_services aps where aps.appointment_id = r.appointment_id;

  return query select r.id,
    case when r.reminder_type::text = 'retention_due_soon' then 'Time for your next visit soon'
      when r.reminder_type::text = 'retention_due' then 'Ready for your next visit?'
      when r.reminder_type = 'appointment_24h'::public.reminder_type then 'Appointment tomorrow'
      else 'Appointment soon' end,
    case when r.reminder_type::text = 'retention_due_soon'
        then pg_catalog.format('You''re due back at %s in about a week. Book your next appointment.', v_barber)
      when r.reminder_type::text = 'retention_due'
        then pg_catalog.format('You''re due for your next visit at %s. Book when you''re ready.', v_barber)
      else pg_catalog.format('Your appointment with %s is %s at %s.', v_barber,
        case when r.reminder_type = 'appointment_24h'::public.reminder_type then 'tomorrow' else 'in about 2 hours' end,
        pg_catalog.to_char(a.start_at at time zone v_timezone, 'HH24:MI')) end,
    case when r.reminder_type::text in ('retention_due_soon', 'retention_due')
      then pg_catalog.jsonb_build_object('route', 'booking', 'barberId', r.barber_id,
        'serviceIds', v_service_ids, 'sourceAppointmentId', r.appointment_id, 'reminderId', r.id)
      else pg_catalog.jsonb_build_object('route', 'appointments', 'appointmentId', r.appointment_id,
        'reminderId', r.id) end,
    coalesce((select pg_catalog.array_agg(d.expo_push_token)
      from public.push_device_registrations d where d.user_id = r.customer_id and d.is_active), array[]::text[]);
end; $$;

revoke all on function public.generate_due_reminders() from public;
revoke all on function public.reminder_is_deliverable(uuid) from public;
revoke all on function public.prepare_reminder_delivery(uuid, uuid) from public;
grant execute on function public.generate_due_reminders() to service_role;
grant execute on function public.prepare_reminder_delivery(uuid, uuid) to service_role;
