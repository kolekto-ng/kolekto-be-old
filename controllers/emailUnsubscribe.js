// Public (no admin auth) unsubscribe handler — this is the endpoint
// {{unsubscribe_link}} points at. Verified by a signed token
// (utils/unsubscribeTokens.js), not a session, since the person clicking
// it is a campaign recipient, not a logged-in admin.
import { supabase } from '../utils/client.js';
import { verifyUnsubscribeToken } from '../utils/unsubscribeTokens.js';
import { log } from '../utils/logger.js';

function renderUnsubscribePage({ ok, email, message }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${ok ? 'Unsubscribed' : 'Invalid link'} — Kolekto</title>
  <style>
    body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f2f4f3; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { background: #fff; border-radius: 12px; padding: 32px 28px; max-width: 420px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    h1 { font-size: 20px; color: #1B5E20; margin: 0 0 12px 0; }
    p { color: #52514e; font-size: 14px; line-height: 1.6; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    ${ok
      ? `<h1>You've been unsubscribed</h1><p><strong>${email}</strong> will no longer receive marketing emails from Kolekto. You'll still receive essential account and transaction emails.</p>`
      : `<h1>This link isn't valid</h1><p>${message}</p>`}
  </div>
</body>
</html>`;
}

export async function handleUnsubscribe(req, res) {
  const verified = verifyUnsubscribeToken(req.query?.token);
  if (!verified) {
    return res.status(400).send(renderUnsubscribePage({ ok: false, message: 'This unsubscribe link is invalid or malformed.' }));
  }

  const email = verified.email.toLowerCase();
  try {
    const { error } = await supabase
      .from('email_unsubscribes')
      .upsert([{ email, campaign_id: verified.campaignId || null }], { onConflict: 'email', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    log.info('unsubscribe.recorded', { email, campaignId: verified.campaignId });
  } catch (err) {
    log.error('unsubscribe.insert_failed', { err, email });
  }

  return res.status(200).send(renderUnsubscribePage({ ok: true, email }));
}
