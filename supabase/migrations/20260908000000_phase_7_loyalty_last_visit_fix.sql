-- Phase 7 hotfix: "Last visit" is the most recent completed service visit.
create or replace function public.get_barber_loyalty_customers()
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
    pg_catalog.max(a.start_at) filter (
      where a.status = 'completed'::public.appointment_status
    )
  from public.appointments a
  join public.profiles p on p.id = a.customer_id
  where a.barber_id = v_barber
  group by a.customer_id, p.full_name
  order by pg_catalog.max(a.start_at) filter (
    where a.status = 'completed'::public.appointment_status
  ) desc nulls last, p.full_name;
end; $$;

revoke all on function public.get_barber_loyalty_customers() from public;
grant execute on function public.get_barber_loyalty_customers() to authenticated;
