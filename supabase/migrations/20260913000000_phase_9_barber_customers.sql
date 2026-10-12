-- Phase 9: read-only, barber-scoped customer database derived from completed visits.

create index appointments_barber_completed_customers_idx
  on public.appointments (barber_id, start_at desc, customer_id desc)
  where status = 'completed'::public.appointment_status;

create function public.get_barber_customers(
  p_limit integer default 20,
  p_before_last_completed_at timestamptz default null,
  p_before_customer_id uuid default null,
  p_search text default null
)
returns table (
  customer_id uuid,
  customer_name text,
  avatar_url text,
  first_completed_at timestamptz,
  last_completed_at timestamptz,
  completed_visit_count bigint,
  completed_value numeric,
  loyalty_points integer,
  last_services text,
  last_recommended_return_days integer
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_barber uuid := auth.uid();
  v_limit integer;
begin
  if v_barber is null or not exists (
    select 1 from public.profiles p
    where p.id = v_barber and p.role = 'barber'::public.user_role
  ) then raise exception 'Only authenticated barbers can view customers'; end if;

  if (p_before_last_completed_at is null) <> (p_before_customer_id is null) then
    raise exception 'Invalid customer cursor';
  end if;
  v_limit := pg_catalog.least(pg_catalog.greatest(coalesce(p_limit, 20), 1), 50);

  return query
  with relationships as (
    select a.customer_id,
      pg_catalog.min(a.start_at) as first_completed_at,
      pg_catalog.max(a.start_at) as last_completed_at,
      pg_catalog.count(*) as completed_visit_count,
      pg_catalog.sum(a.estimated_total) as completed_value
    from public.appointments a
    where a.barber_id = v_barber
      and a.status = 'completed'::public.appointment_status
    group by a.customer_id
  )
  select r.customer_id, p.full_name, p.avatar_url,
    r.first_completed_at, r.last_completed_at, r.completed_visit_count,
    r.completed_value,
    coalesce((select pg_catalog.sum(lt.amount)::integer
      from public.loyalty_transactions lt
      where lt.barber_id = v_barber and lt.customer_id = r.customer_id), 0),
    coalesce((select pg_catalog.string_agg(aps.service_name, ' + ' order by aps.created_at, aps.id)
      from public.appointment_services aps
      where aps.appointment_id = (
        select la.id from public.appointments la
        where la.barber_id = v_barber and la.customer_id = r.customer_id
          and la.status = 'completed'::public.appointment_status
        order by la.start_at desc, la.id desc limit 1
      )), 'Service details unavailable'),
    (select pg_catalog.min(aps.recommended_return_days)
      from public.appointment_services aps
      where aps.appointment_id = (
        select la.id from public.appointments la
        where la.barber_id = v_barber and la.customer_id = r.customer_id
          and la.status = 'completed'::public.appointment_status
        order by la.start_at desc, la.id desc limit 1
      ))
  from relationships r
  join public.profiles p on p.id = r.customer_id
  where p.role = 'customer'::public.user_role
    and (nullif(pg_catalog.btrim(p_search), '') is null
      or p.full_name ilike '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
        pg_catalog.btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\')
    and (p_before_last_completed_at is null
      or (r.last_completed_at, r.customer_id) < (p_before_last_completed_at, p_before_customer_id))
  order by r.last_completed_at desc, r.customer_id desc
  limit v_limit;
end; $$;

create function public.get_barber_customer_detail(p_customer_id uuid)
returns table (
  customer_id uuid,
  customer_name text,
  avatar_url text,
  first_completed_at timestamptz,
  last_completed_at timestamptz,
  completed_visit_count bigint,
  completed_value numeric,
  loyalty_points integer,
  last_services jsonb,
  last_recommended_return_days integer,
  recent_visits jsonb
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_barber uuid := auth.uid();
begin
  if v_barber is null or not exists (
    select 1 from public.profiles p
    where p.id = v_barber and p.role = 'barber'::public.user_role
  ) then raise exception 'Only authenticated barbers can view customers'; end if;
  if p_customer_id is null or not exists (
    select 1 from public.appointments a
    where a.barber_id = v_barber and a.customer_id = p_customer_id
      and a.status = 'completed'::public.appointment_status
  ) then raise exception 'Customer relationship not found'; end if;

  return query
  with completed as (
    select a.* from public.appointments a
    where a.barber_id = v_barber and a.customer_id = p_customer_id
      and a.status = 'completed'::public.appointment_status
  ), last_visit as (
    select c.id from completed c order by c.start_at desc, c.id desc limit 1
  )
  select p.id, p.full_name, p.avatar_url,
    pg_catalog.min(c.start_at), pg_catalog.max(c.start_at), pg_catalog.count(*),
    pg_catalog.sum(c.estimated_total),
    coalesce((select pg_catalog.sum(lt.amount)::integer
      from public.loyalty_transactions lt
      where lt.barber_id = v_barber and lt.customer_id = p_customer_id), 0),
    coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'service_id', aps.service_id, 'service_name', aps.service_name,
        'price', aps.price, 'duration_minutes', aps.duration_minutes,
        'recommended_return_days', aps.recommended_return_days
      ) order by aps.created_at, aps.id)
      from public.appointment_services aps where aps.appointment_id = (select lv.id from last_visit lv)), '[]'::jsonb),
    (select pg_catalog.min(aps.recommended_return_days)
      from public.appointment_services aps where aps.appointment_id = (select lv.id from last_visit lv)),
    coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', recent.id, 'start_at', recent.start_at, 'estimated_total', recent.estimated_total,
        'services', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'service_id', aps.service_id, 'service_name', aps.service_name,
          'price', aps.price, 'duration_minutes', aps.duration_minutes,
          'recommended_return_days', aps.recommended_return_days
        ) order by aps.created_at, aps.id) from public.appointment_services aps
          where aps.appointment_id = recent.id), '[]'::jsonb)
      ) order by recent.start_at desc, recent.id desc)
      from (select c2.* from completed c2 order by c2.start_at desc, c2.id desc limit 10) recent), '[]'::jsonb)
  from completed c
  join public.profiles p on p.id = p_customer_id
  group by p.id, p.full_name, p.avatar_url;
end; $$;

revoke all on function public.get_barber_customers(integer,timestamptz,uuid,text) from public;
revoke all on function public.get_barber_customer_detail(uuid) from public;
grant execute on function public.get_barber_customers(integer,timestamptz,uuid,text) to authenticated;
grant execute on function public.get_barber_customer_detail(uuid) to authenticated;
