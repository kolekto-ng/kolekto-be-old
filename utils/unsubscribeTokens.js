// Signs/verifies the token used in {{unsubscribe_link}}. Stateless HMAC,
// not a DB lookup — so the link works even for a recipient who was
// materialized into a campaign moments ago (no round trip needed to check
// validity, only to record the unsubscribe itself).
import crypto from 'crypto';

const SECRET = process.env.UNSUBSCRIBE_SECRET || process.env.INTERNAL_NOTIFY_SECRET;

if (!SECRET) {
  console.warn(
    '[unsubscribe-tokens] Neither UNSUBSCRIBE_SECRET nor INTERNAL_NOTIFY_SECRET is set — ' +
    'unsubscribe links will use an insecure fallback secret. Set UNSUBSCRIBE_SECRET before serving real campaign traffic.'
  );
}
const EFFECTIVE_SECRET = SECRET || 'insecure-dev-only-unsubscribe-secret';

function sign(payload) {
  return crypto.createHmac('sha256', EFFECTIVE_SECRET).update(payload).digest('hex').slice(0, 32);
}

export function signUnsubscribeToken(email, campaignId) {
  const payload = `${String(email).toLowerCase()}:${campaignId || ''}`;
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  return `${encoded}.${sign(payload)}`;
}

export function verifyUnsubscribeToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;

  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expectedSig = sign(payload);
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  const [email, campaignId] = payload.split(':');
  if (!email) return null;
  return { email, campaignId: campaignId || null };
}
