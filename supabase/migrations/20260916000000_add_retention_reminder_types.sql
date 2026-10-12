-- Final demo Step C: enum additions commit before the following migration
-- creates functions that use these values.

alter type public.reminder_type
add value if not exists 'retention_due_soon';

alter type public.reminder_type
add value if not exists 'retention_due';
