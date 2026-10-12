# Barber Retention

Mobile app with secure profiles, barber-owned services, normalized availability, customer booking, a timezone-aware barber calendar, and server-driven appointment/return push reminders.

## First-time setup

1. Create a free Supabase project at https://supabase.com/dashboard.
2. In its **SQL Editor**, run reviewed files in `supabase/migrations` in filename order. Phase 5 must be reviewed before it is applied.
3. In Supabase **Authentication > Providers > Email**, keep email enabled. For easiest initial testing, turn off **Confirm email**; turn it back on before launch.
4. Copy `.env.example` to a new file called `.env` and fill in the URL and **Publishable key** from Supabase **Settings > API**. Never use a `service_role` key in the app.
5. Use an EAS development build for native push testing; remote push notifications are not supported in Expo Go on Android.

## Phase 5 reminder operations

The repository includes `supabase/functions/process-reminders`, but neither the migration nor function is automatically applied or deployed. After review: apply the Phase 5 migration, deploy the function, set `REMINDER_WORKER_SECRET` (and optionally `EXPO_ACCESS_TOKEN`), then configure Supabase Cron to POST to the function every 15 minutes with the worker secret. `SUPABASE_SERVICE_ROLE_KEY` stays server-side.

Routine due time is the completed appointment's service end (`end_at`) plus the smallest non-null snapshotted `recommended_return_days` among its booked services. It is generated only for `completed` appointments. A same-customer, same-barber booked appointment after the source visit and on/before that due time suppresses delivery. One routine event is stored per completed appointment.

## Commands

```powershell
cd "D:\Barber App\barber-retention"
npm start
npm run android
npm run web
npx tsc --noEmit
```

## Security architecture

Supabase Auth stores passwords securely. Row Level Security scopes profile, service, availability and appointment data. Bookings, cancellations, and barber status transitions use guarded database functions; a PostgreSQL exclusion constraint prevents concurrent overlapping booked appointments. Calendar reads expose only operational appointment snapshots and the customer's display name.
