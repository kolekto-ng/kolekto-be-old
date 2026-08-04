-- Seed rows for the 8 built-in Email Campaign templates (Phase 2).
-- Apply once, after database/email_campaigns.sql. email_templates has no
-- unique constraint on name (admins can create custom templates with any
-- name), so "on conflict do nothing" below has no real conflict target —
-- re-running this file will insert duplicates. If you need to re-seed,
-- first run: delete from public.email_templates where is_system = true;

insert into public.email_templates (name, category, subject, preview_text, html_body, is_system)
values
  (
    'Product Update',
    'product_update',
    'New on Kolekto: {{feature name}}',
    'Here''s what''s new this week.',
    '<h2>We just shipped something new</h2><p>Tell your users what changed and why it matters to them.</p>',
    true
  ),
  (
    'Newsletter',
    'newsletter',
    'The Kolekto Newsletter — {{month}}',
    'This month''s highlights from Kolekto.',
    '<h2>This month at Kolekto</h2><p>A roundup of updates, stories, and highlights from the community.</p>',
    true
  ),
  (
    'New Feature',
    'new_feature',
    'Introducing {{feature name}}',
    'A new way to do more on Kolekto.',
    '<h2>Introducing {{feature name}}</h2><p>Describe the feature and how to start using it.</p>',
    true
  ),
  (
    'Maintenance Notice',
    'maintenance_notice',
    'Scheduled maintenance on Kolekto',
    'A brief service interruption is planned.',
    '<h2>Scheduled Maintenance</h2><p>We''ll be performing maintenance on {{date}} between {{start time}} and {{end time}}. Some features may be temporarily unavailable.</p>',
    true
  ),
  (
    'Ambassador Update',
    'ambassador_update',
    'Ambassador Program Update',
    'News for Kolekto Ambassadors.',
    '<h2>Ambassador Program Update</h2><p>Share news, milestones, or reminders with the Ambassador community.</p>',
    true
  ),
  (
    'Organizer Update',
    'organizer_update',
    'An update for Kolekto Organizers',
    'Important news for collection organizers.',
    '<h2>Hi Organizer,</h2><p>Share news or updates relevant to people running collections on Kolekto.</p>',
    true
  ),
  (
    'Payment Notification',
    'payment_notification',
    'A note about payments on Kolekto',
    'Payment-related update.',
    '<h2>Payment Notification</h2><p>Share information about payment processing, fees, or payout timelines.</p>',
    true
  ),
  (
    'Holiday Greeting',
    'holiday_greeting',
    'Happy Holidays from Kolekto',
    'Season''s greetings from the Kolekto team.',
    '<h2>Happy Holidays!</h2><p>Wishing you and yours a wonderful holiday season from all of us at Kolekto.</p>',
    true
  )
on conflict do nothing;
