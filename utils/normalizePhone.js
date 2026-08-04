/**
 * Normalize a contributor phone for storage in `contributions.phone` (varchar(20)).
 *
 * Root cause it fixes: Paystack contact phones can arrive with formatting
 * (spaces/dashes/parens) or as international numbers that, left un-normalized,
 * exceed varchar(20). The contribution insert then fails with
 * `value too long for type character varying(20)` (a 400 from PostgREST),
 * which in production left paid contributions unrecorded and stuck the
 * scheduled orphan-recovery job in a permanent retry loop.
 *
 * Strategy: keep at most one leading '+', strip every other non-digit, then cap
 * at `maxLen`. A legitimately normalized number is at most E.164's 15 digits +
 * '+' = 16 chars, so a valid number never hits the cap — the cap only guards
 * against garbage input and guarantees the insert can never overflow. Empty /
 * no-digit input returns null (the column is nullable).
 *
 * Because valid normalized values are <= 16 chars, the varchar(20) column does
 * NOT need to be widened.
 *
 * NOTE: the identical algorithm is inlined (by necessity — they are
 * self-contained Deno files) in the edge functions
 * `verify-paystack-payment/_shared1.ts` and `initiate-paystack-payment/index.ts`.
 * Keep them in sync; this file carries the authoritative unit tests.
 *
 * @param {unknown} raw
 * @param {number} [maxLen=20] must match the DB column width.
 * @returns {string|null}
 */
export function normalizePhone(raw, maxLen = 20) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;
  let out = (hasPlus ? "+" : "") + digits;
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}

export default normalizePhone;
