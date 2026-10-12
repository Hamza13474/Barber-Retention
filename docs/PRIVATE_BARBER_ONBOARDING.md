# Private barber onboarding

This pilot uses one mobile deployment, one Supabase project, and exactly one barber/business. Public app registration is customer-only. Barber identities must be created by the app owner through a trusted Supabase administration path; never put a service-role key or an owner workflow in the mobile app.

## New barber deployment

1. Create a new Supabase project for the barber. Do not reuse another barber's project or copy its customer data.
2. Link a clean checkout to that project and apply the reviewed migrations in `supabase/migrations` in timestamp order. Check the migration list before and after applying it.
3. Configure the mobile build with that project's public URL and publishable/anon key (`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`). Never use a service-role key in an `EXPO_PUBLIC_` variable.
4. Deploy the existing `process-reminders` Edge Function. Set a unique high-entropy `REMINDER_WORKER_SECRET`; set `EXPO_ACCESS_TOKEN` when Expo push access security is enabled. Keep the service-role key in the hosted function environment.
5. Configure the existing Supabase Vault and Cron invocation documented in `supabase/functions/process-reminders/README.md`. Use the new project URL and the same worker secret. Do not create a second reminder cron.
6. Configure the deployment's Firebase/FCM credentials in the trusted EAS/Supabase locations already used by the project. Keep private Firebase credentials out of application source and source control.
7. Provision the barber identity using the procedure below.
8. Sign in as the barber and complete the existing Business Profile, Services, and Availability screens. Activate the services that customers may book.
9. Verify the customer app discovers exactly one bookable barber. Zero or more than one is a configuration error and must be corrected in the deployment; never choose the first row.
10. Build the `pilot` EAS profile for an internally distributed APK. Preserve the Android package and existing signing credentials. Use the `production` profile later for a store AAB.

## Provision the barber Auth user

The first migration installs `public.create_profile_for_new_user()` as an `AFTER INSERT` trigger on `auth.users`. At Auth-user creation it reads trusted user metadata, inserts `public.profiles`, and inserts either `public.barber_profiles` or `public.customer_profiles`. A barber therefore does **not** need a manual profile SQL insert when created correctly.

Create the user through a trusted owner-side Supabase Admin API call (or an equivalent Dashboard workflow that supplies user metadata at creation) with:

```json
{
  "email": "barber@example.invalid",
  "password": "OWNER-SUPPLIED-ONE-TIME-PASSWORD",
  "email_confirm": true,
  "user_metadata": {
    "role": "barber",
    "full_name": "BARBER FULL NAME",
    "phone": "OPTIONAL PHONE"
  }
}
```

Replace every placeholder at execution time and require the barber to receive/change credentials through the owner's approved secure process. Do not save the request, password, access token, or service-role key in this repository. Do not use the public mobile signup endpoint: it always sends `role: customer`.

`full_name` must be non-empty. The role must be present as `barber` **when the Auth row is created** so the trigger creates the correct application rows. Do not first create a default customer and later edit only Auth metadata; changing metadata does not rerun the profile trigger.

## Preflight and verification

Before provisioning, confirm the new project has no existing barber application profile. After the trusted Auth creation, use the SQL Editor to verify the exact new Auth ID (replace the placeholder locally):

```sql
select id, email, raw_user_meta_data ->> 'role' as requested_role
from auth.users
where id = '<NEW_AUTH_USER_UUID>'::uuid;

select id, role, full_name, email, phone
from public.profiles
where id = '<NEW_AUTH_USER_UUID>'::uuid;

select id, display_name, business_phone, address, city, postcode
from public.barber_profiles
where id = '<NEW_AUTH_USER_UUID>'::uuid;

select count(*) as barber_profile_count
from public.barber_profiles;
```

Expected result: one Auth user, one `profiles` row with `role = 'barber'`, one matching `barber_profiles` row, and exactly one barber profile in the isolated project. There must be no matching `customer_profiles` row. If any expectation fails, stop before distributing the build and investigate the provisioning attempt; do not patch around it in the mobile app.

## Build and hand-off checklist

- Public customer signup creates only customer profiles; no role selector or barber invite path is present.
- The signed-in barber reaches the existing Dashboard and can save Business Profile, Services, and Availability.
- A fresh customer can register, immediately see the sole configured business, and book without a referral.
- Appointment and retention reminder rows are processed by the one existing worker/cron path.
- Notification taps open Appointments or Booking as appropriate.
- The APK does not require Metro or Expo's development launcher.
- No secret values appear in the repository, build logs shared with the barber, or mobile environment.
- Android package/signing settings remain unchanged for the current app unless a separately approved distribution decision requires otherwise.

## Why there is no manual provisioning SQL

The applied schema already performs the application-profile provisioning atomically in the Auth-user creation trigger. A second SQL template would duplicate that mechanism and could create inconsistent customer/barber rows. The owner-only responsibility is to create the Auth user through a trusted admin mechanism with complete barber metadata at creation and then verify the trigger output.
