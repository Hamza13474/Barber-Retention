-- Phase 6: least-privilege customer appointment lists for history and rebooking.
-- Booking remains exclusively handled by the Phase 3 RPCs.

create or replace function public.get_customer_appointments(
  p_list text,
  p_limit integer default 20,
  p_before_start_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  id uuid,
  barber_id uuid,
  barber_name text,
  barber_timezone text,
  start_at timestamptz,
  end_at timestamptz,
  status public.appointment_status,
  total_duration_minutes integer,
  estimated_total numeric(10,2),
  services jsonb
)
language plpgsql stable security definer set search_path = '' as $$
declare v_customer uuid := auth.uid();
begin
  if v_customer is null or not exists (
    select 1 from public.profiles p
    where p.id = v_customer and p.role = 'customer'
  ) then
    raise exception 'Only authenticated customers can view customer appointments';
  end if;
  if p_list is null or p_list not in ('upcoming', 'history') then
    raise exception 'Unknown appointment list';
  end if;
  if p_limit not between 1 and 25 then
    raise exception 'Page size must be between 1 and 25';
  end if;
  if (p_before_start_at is null) <> (p_before_id is null) then
    raise exception 'Both cursor values are required';
  end if;

  return query
  select a.id, a.barber_id,
    coalesce(nullif(bp.display_name, ''), p.full_name), bp.timezone,
    a.start_at, a.end_at, a.status, a.total_duration_minutes, a.estimated_total,
    coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', aps.id,
        'service_id', aps.service_id,
        'service_name', aps.service_name,
        'price', aps.price,
        'duration_minutes', aps.duration_minutes
      ) order by aps.created_at, aps.id)
      from public.appointment_services aps where aps.appointment_id = a.id
    ), '[]'::jsonb)
  from public.appointments a
  join public.barber_profiles bp on bp.id = a.barber_id
  join public.profiles p on p.id = a.barber_id
  where a.customer_id = v_customer
    and case when p_list = 'upcoming'
      then a.status = 'booked'::public.appointment_status and a.end_at > pg_catalog.now()
      else (
        (a.status = 'booked'::public.appointment_status and a.end_at <= pg_catalog.now())
        or a.status in (
          'completed'::public.appointment_status,
          'no_show'::public.appointment_status,
          'cancelled_by_customer'::public.appointment_status,
          'cancelled_by_barber'::public.appointment_status
        )
      )
    end
    and (p_before_start_at is null or (a.start_at, a.id) < (p_before_start_at, p_before_id))
  order by a.start_at desc, a.id desc
  limit p_limit;
end; $$;

revoke all on function public.get_customer_appointments(text,integer,timestamptz,uuid) from public;
grant execute on function public.get_customer_appointments(text,integer,timestamptz,uuid) to authenticated;
