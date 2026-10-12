-- Phase 2: each independent barber owns a service catalog.
create table public.services (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references public.barber_profiles(id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  description text,
  price numeric(10, 2) not null check (price >= 0),
  duration_minutes integer not null check (duration_minutes > 0),
  recommended_return_days integer check (recommended_return_days > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index services_barber_id_idx on public.services (barber_id);
create index services_active_barber_idx on public.services (barber_id) where is_active;
alter table public.services enable row level security;

create policy "Authenticated users view active services or their own"
on public.services for select to authenticated
using (is_active or barber_id = auth.uid());

create policy "Barbers create their own services"
on public.services for insert to authenticated
with check (barber_id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and role = 'barber'));

create policy "Barbers update their own services"
on public.services for update to authenticated
using (barber_id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and role = 'barber'))
with check (barber_id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and role = 'barber'));

-- Normal clients intentionally receive no DELETE privilege or DELETE policy.
revoke all on table public.services from anon;
grant select, insert, update on table public.services to authenticated;

create trigger services_updated_at before update on public.services
for each row execute procedure public.set_updated_at();
