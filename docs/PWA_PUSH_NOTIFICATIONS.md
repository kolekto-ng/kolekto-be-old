# Kolekto PWA Updates and Push Notifications

This note covers the moving parts behind the installed PWA update flow and the backend push notification pipeline.

## Backend environment

Required environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `FRONTEND_URL`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

Notes:

- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` must be generated as a pair.
- `VAPID_SUBJECT` should be a valid `mailto:` value such as `mailto:support@kolekto.com.ng`.
- Any change to VAPID keys requires a backend restart or redeploy before `/api/push/vapid-public-key` will report the new configuration.

## Database requirements

Push subscriptions and send dedupe rely on these tables:

- `public.push_subscriptions`
- `public.push_notification_events`

Recommended checks:

- RLS enabled on both tables.
- `service_role` can read and write both tables.
- Authenticated users can create and remove only their own subscription rows.

## Realtime requirements

The frontend now refreshes wallet and activity surfaces from Supabase Realtime plus short background refreshes. Make sure these tables are included in the `supabase_realtime` publication:

- `public.contributions`
- `public.withdrawals`
- `public.wallets`

Example SQL:

```sql
alter publication supabase_realtime add table public.contributions;
alter publication supabase_realtime add table public.withdrawals;
alter publication supabase_realtime add table public.wallets;
```

## Event coverage

The current backend notification pipeline sends push notifications for:

- successful contribution receipts to the organizer
- collection funding milestones, including 80% funded and almost full contribution limits
- withdrawal request submitted
- withdrawal processed
- withdrawal failed or rejected
- KYC approved
- KYC rejected
- KYC reminder batch
- collection deadline reached
- collection paused, resumed, approved, or closed when status changes trigger those states
- payment failure or incomplete verification states where the backend can resolve the collection owner

## Frontend update behavior

The frontend service worker now:

- checks for updates on focus, visibility return, and a short interval
- uses a floating in-app update prompt instead of a blocking browser confirm
- prefers fresh navigation HTML with `NetworkFirst`
- clears older cache families during activation

## Testing checklist

PWA update flow:

1. Deploy a frontend build.
2. Open an already-installed PWA build on a device.
3. Deploy a second build with a visible UI change.
4. Bring the app back into focus and confirm the update prompt appears.
5. Tap `Refresh` and confirm the latest UI loads.

Push notification flow:

1. Enable push notifications from the profile settings.
2. Confirm a row is created in `push_subscriptions`.
3. Trigger a successful contribution and confirm the organizer receives a push.
4. Trigger a withdrawal request and confirm the requester receives a push.
5. Mark a withdrawal processed or failed and confirm the requester receives the matching push.
6. Approve or reject KYC and confirm the owner receives a push.
7. Click the notification and confirm the app opens the intended route.
