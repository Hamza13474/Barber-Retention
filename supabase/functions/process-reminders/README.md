# Reminder worker

`process-reminders` is a private Supabase Edge Function intended for a 15-minute Supabase Cron invocation. It generates future reminders, atomically claims due rows, revalidates each claim, and submits device messages to Expo.

## Authentication model

There are two separate layers:

1. `supabase/config.toml` contains `[functions.process-reminders]` with `verify_jwt = false`. This disables only the Edge Function gateway's Supabase JWT check, allowing a cron request that is not pretending a worker secret is a Supabase bearer JWT to reach the handler.
2. The function itself requires `POST` and an exact `x-reminder-worker-secret` header matching a strong `REMINDER_WORKER_SECRET` (at least 32 characters). Missing or wrong values return `401`. Browser/CORS requests have no exception and cannot bypass this check.

The service-role key remains in the Edge Function environment and is never sent by cron or included in the mobile app. Neither the worker secret nor the service-role key belongs in this repository.

Required function secrets:

- `REMINDER_WORKER_SECRET`: a newly generated high-entropy secret of at least 32 characters.
- `SUPABASE_SERVICE_ROLE_KEY`: provided in the hosted Edge Function environment; never expose it to cron or the app.
- `EXPO_ACCESS_TOKEN`: optional, and recommended when Expo push security is enabled.

After applying the reviewed Phase 5 migration, set secrets interactively or from an ignored local environment file, then deploy:

```sh
supabase secrets set REMINDER_WORKER_SECRET
supabase secrets set EXPO_ACCESS_TOKEN
supabase functions deploy process-reminders
```

Do not place literal values in source control. The supported project configuration is:

```toml
[functions.process-reminders]
verify_jwt = false
```

## Cron invocation

Store the project URL and the same worker secret in Supabase Vault under names such as `project_url` and `reminder_worker_secret`. Do not store or send the service-role key. Schedule this SQL separately (it is intentionally not part of the migration):

```sql
select cron.schedule(
  'process-reminders-every-15-minutes',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/process-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-reminder-worker-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'reminder_worker_secret')
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
```

Because gateway JWT verification is disabled for this function, the cron call needs no `Authorization` bearer value or Supabase API key. Its only credential is the dedicated worker-secret header, checked inside the function.

## Delivery and suppression semantics

- Appointment reminders expire at appointment start.
- A routine return reminder expires seven days after its calculated routine due time.
- Preference and eligibility are revalidated when a claim is prepared during that window.
- A routine reminder is suppressed if the same customer has a still-future `booked` appointment with the same barber that occurs after the source completed service visit. The booking may be before, on, or any time after the routine due time. A different barber's booking does not suppress it.
- Delivery-time suppression is permanent for that reminder row. If notifications were disabled then later re-enabled, that exact suppressed reminder is not resurrected; future eligible reminders can still be generated.

Each claim receives a fresh database-generated UUID and an approximately five-minute lease. Prepare, finish, and fail require that UUID. An expired worker cannot finalize after a reclaim, while a crashed worker's lease can be recovered until the five-attempt maximum.

Expo requests are chunked to at most 100 messages. HTTP/network/JSON/shape/count failures are retryable. `DeviceNotRegistered` deactivates only its corresponding token. The deliberate partial-success policy finishes a reminder if at least one structurally valid Expo ticket was accepted, because retrying would duplicate an already accepted device message.

Expo tickets confirm acceptance, not final handset delivery; receipt polling is a documented Phase 5 limitation. Expo and Postgres cannot participate in one distributed transaction. If Expo accepts a message and database finalization then fails, lease recovery can theoretically send a duplicate. Claim tokens prevent stale-worker finalization races, but cannot close this external API/database transaction boundary.
