-- Phase 10: barber-local, derived retention dashboard.
-- "Today" and the last visit date are calendar dates in the authenticated
-- barber's validated IANA timezone; no device or UTC date is authoritative.

create function public.get_barber_retention_dashboard()
returns table (
  customer_id uuid,
  customer_name text,
  avatar_url text,
  last_completed_at timestamptz,
  last_services text,
  recommended_return_days integer,
  expected_return_date date,
  retention_status text,
  actionable_status text,
  days_relative_to_expected integer,
  next_booked_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_barber uuid := auth.uid();
  v_timezone text;
  v_today date;
begin
  select bp.timezone into v_timezone
  from public.profiles p
  join public.barber_profiles bp on bp.id = p.id
  where p.id = v_barber and p.role = 'barber'::public.user_role;

  if v_barber is null or v_timezone is null then
    raise exception 'Only authenticated barbers can view retention insights';
  end if;

  v_today := (pg_catalog.statement_timestamp() at time zone v_timezone)::date;

  return query
  with last_completed as (
    select distinct on (a.customer_id)
      a.customer_id, a.id as appointment_id, a.start_at
    from public.appointments a
    join public.profiles p
      on p.id = a.customer_id and p.role = 'customer'::public.user_role
    where a.barber_id = v_barber
      and a.status = 'completed'::public.appointment_status
    order by a.customer_id, a.start_at desc, a.id desc
  ), retention_base as (
    select lc.customer_id, p.full_name as customer_name, p.avatar_url,
      lc.start_at as last_completed_at,
      coalesce(snap.services, 'Service details unavailable') as last_services,
      snap.return_days as recommended_return_days,
      case when snap.return_days is not null then
        (lc.start_at at time zone v_timezone)::date + snap.return_days
      end as expected_return_date,
      future.next_booked_at
    from last_completed lc
    join public.profiles p on p.id = lc.customer_id
    left join lateral (
      select
        pg_catalog.string_agg(aps.service_name, ' + ' order by aps.created_at, aps.id) as services,
        pg_catalog.min(aps.recommended_return_days) as return_days
      from public.appointment_services aps
      where aps.appointment_id = lc.appointment_id
    ) snap on true
    left join lateral (
      select pg_catalog.min(a.start_at) as next_booked_at
      from public.appointments a
      where a.barber_id = v_barber
        and a.customer_id = lc.customer_id
        and a.status = 'booked'::public.appointment_status
        and a.start_at > pg_catalog.statement_timestamp()
    ) future on true
  ), calculated as (
    select rb.*,
      case when rb.expected_return_date is not null
        then (v_today - rb.expected_return_date)::integer
      end as days_relative
    from retention_base rb
  ), classified as (
    select c.*,
      case
        when c.days_relative is null then null
        when c.days_relative < -7 then 'ACTIVE'
        when c.days_relative <= 0 then 'DUE_SOON'
        when c.days_relative <= 14 then 'OVERDUE'
        else 'AT_RISK'
      end as underlying_status
    from calculated c
  )
  select c.customer_id, c.customer_name, c.avatar_url,
    c.last_completed_at, c.last_services, c.recommended_return_days,
    c.expected_return_date, c.underlying_status,
    case when c.next_booked_at is not null then 'BOOKED' else c.underlying_status end,
    c.days_relative, c.next_booked_at
  from classified c
  order by
    case
      when c.next_booked_at is null and c.underlying_status = 'AT_RISK' then 1
      when c.next_booked_at is null and c.underlying_status = 'OVERDUE' then 2
      when c.next_booked_at is null and c.underlying_status = 'DUE_SOON' then 3
      when c.next_booked_at is null and c.underlying_status = 'ACTIVE' then 4
      when c.next_booked_at is not null then 5
      else 6
    end,
    c.days_relative desc nulls last, c.last_completed_at desc, c.customer_id;
end; $$;

revoke all on function public.get_barber_retention_dashboard() from public;
grant execute on function public.get_barber_retention_dashboard() to authenticated;
