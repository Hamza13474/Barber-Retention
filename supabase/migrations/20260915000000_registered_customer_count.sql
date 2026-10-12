-- Final single-deployment pilot: expose only the aggregate number of valid
-- registered customer application profiles to an authenticated barber.

create function public.get_barber_registered_customer_count()
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_barber uuid := auth.uid();
  v_count bigint;
begin
  if v_barber is null or not exists (
    select 1
    from public.profiles p
    join public.barber_profiles bp on bp.id = p.id
    where p.id = v_barber
      and p.role = 'barber'::public.user_role
  ) then
    raise exception 'Only authenticated barbers can view the registered customer count';
  end if;

  select pg_catalog.count(*)
  into v_count
  from public.customer_profiles cp
  join public.profiles p on p.id = cp.id
  where p.role = 'customer'::public.user_role;

  return v_count;
end;
$$;

revoke all on function public.get_barber_registered_customer_count() from public;
grant execute on function public.get_barber_registered_customer_count() to authenticated;
