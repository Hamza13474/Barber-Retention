-- Run this script in Supabase Dashboard > SQL Editor before using the app.
create type public.user_role as enum ('barber', 'customer');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.user_role not null,
  full_name text not null check (char_length(trim(full_name)) > 0),
  email text not null, phone text, avatar_url text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.barber_profiles (
  id uuid primary key references public.profiles(id) on delete cascade,
  display_name text, bio text, address text, city text, postcode text, business_phone text,
  working_days text, opening_time time, closing_time time,
  check (opening_time is null or closing_time is null or opening_time < closing_time)
);
create table public.customer_profiles (
  id uuid primary key references public.profiles(id) on delete cascade,
  notifications_enabled boolean not null default true
);

alter table public.profiles enable row level security;
alter table public.barber_profiles enable row level security;
alter table public.customer_profiles enable row level security;
create policy "Users view only their profile" on public.profiles for select using (auth.uid() = id);
create policy "Users update only their profile" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "Barbers manage their own detail" on public.barber_profiles for all using (auth.uid() = id and exists (select 1 from public.profiles where id = auth.uid() and role = 'barber')) with check (auth.uid() = id and exists (select 1 from public.profiles where id = auth.uid() and role = 'barber'));
create policy "Customers manage their own detail" on public.customer_profiles for all using (auth.uid() = id and exists (select 1 from public.profiles where id = auth.uid() and role = 'customer')) with check (auth.uid() = id and exists (select 1 from public.profiles where id = auth.uid() and role = 'customer'));

create or replace function public.create_profile_for_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare selected_role public.user_role;
begin
  selected_role := coalesce((new.raw_user_meta_data ->> 'role')::public.user_role, 'customer');
  insert into public.profiles (id, role, full_name, email, phone) values (new.id, selected_role, coalesce(new.raw_user_meta_data ->> 'full_name', ''), new.email, nullif(new.raw_user_meta_data ->> 'phone', ''));
  if selected_role = 'barber' then insert into public.barber_profiles (id) values (new.id); else insert into public.customer_profiles (id) values (new.id); end if;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.create_profile_for_new_user();

create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
create trigger profiles_updated_at before update on public.profiles for each row execute procedure public.set_updated_at();

-- Profile photos are public to support future barber discovery. Users may only write inside their own folder.
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
create policy "Public avatar viewing" on storage.objects for select using (bucket_id = 'avatars');
create policy "Users upload their own avatar" on storage.objects for insert to authenticated with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users update their own avatar" on storage.objects for update to authenticated using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users delete their own avatar" on storage.objects for delete to authenticated using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Future tables (services, appointments, loyalty, referrals) must include barber_id UUID and restrictive RLS policies.
