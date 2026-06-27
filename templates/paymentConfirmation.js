// ─── PREMIUM RECEIPT EMAIL TEMPLATE (backend / Node) ────────────────────────────
//
// This is the Node counterpart of the Supabase edge function's renderReceiptEmail
// (verify-paystack-payment/index.ts). BOTH paths must produce the same premium
// design so contributors get an identical receipt whether the email is sent by
// the backend (primary) or the edge function (fallback). Keep the two in sync.
//
// Brand system (from the frontend tailwind.config.ts `kolekto` palette):
//   primary  #1B5E20   light #E8F5E9   accents #FFCA28 / #FFA726
// Layout is 100% table-based + inline styles for Gmail/Outlook/Apple Mail. "NGN"
// is used instead of the NGN glyph, and all icons are HTML entities, for maximum
// cross-client + ZeptoMail safety. Every user-supplied value is HTML-escaped.

const KOLEKTO_LOGO_URL =
  'https://www.kolekto.com.ng/lovable-uploads/1da42b31-fdee-4d4b-a844-19fa3100d598.png';

/** Friendly, human-facing label for each internal collection_type. */
function collectionTypeLabel(t) {
  const map = {
    fixed: 'Contribution',
    tiered: 'Contribution',
    open_pool: 'Open Contribution',
    ticket: 'Event Ticket',
    fundraising: 'Donation',
  };
  return map[t] || 'Payment';
}

/** HTML-escape any value that originates from user / organizer input. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pure receipt-HTML builder shared in spirit with the edge function. Accepts a
 * normalized data object; every premium field is optional and degrades cleanly.
 */
function renderReceiptEmail(d) {
  const currency = d.currency || 'NGN';
  const money = (n) =>
    `${currency} ${(Number(n) || 0).toLocaleString('en-NG', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const typeLabel = collectionTypeLabel(d.collectionType);
  const isTicket = d.collectionType === 'ticket';

  // "View Receipt" link back to the verify page. Reference is passed twice
  // (trxref + reference) to match Paystack's own callback URL shape, which the
  // frontend's /payment/verify page already parses & re-verifies.
  const base = (d.baseUrl || 'https://www.kolekto.com.ng').replace(/\/+$/, '');
  const receiptUrl = `${base}/payment/verify?trxref=${encodeURIComponent(d.transactionRef)}&reference=${encodeURIComponent(d.transactionRef)}`;

  let paidDate = d.paidAt;
  try {
    paidDate = new Date(d.paidAt).toLocaleString('en-NG', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Africa/Lagos',
    });
  } catch (_e) { /* keep raw string */ }

  // ── amount rows (each fee shown only when actually charged) ──
  const amountRow = (label, val, opts) => `
              <tr>
                <td style="padding:7px 0;color:${opts && opts.muted ? '#5b6b60' : '#1f2d23'};font-size:14px;line-height:1.4;">${label}</td>
                <td align="right" style="padding:7px 0;color:#1f2d23;font-size:14px;line-height:1.4;white-space:nowrap;">${money(val)}</td>
              </tr>`;
  const feeRows =
    (d.platformFee > 0 ? amountRow('Platform fee', d.platformFee, { muted: true }) : '') +
    (d.gatewayFee > 0 ? amountRow('Gateway fee', d.gatewayFee, { muted: true }) : '');

  // ── receipt meta rows ──
  const metaRow = (label, valueHtml) => `
                <tr>
                  <td style="padding:9px 0;color:#5b6b60;font-size:13px;width:42%;vertical-align:top;">${label}</td>
                  <td align="right" style="padding:9px 0;color:#1f2d23;font-size:13px;font-weight:600;vertical-align:top;word-break:break-word;">${valueHtml}</td>
                </tr>`;
  const meta =
    metaRow(
      'Status',
      `<span style="display:inline-block;background:#E8F5E9;color:#1B5E20;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 10px;border-radius:999px;">Successful</span>`,
    ) +
    metaRow('Reference', `<span style="font-family:'Courier New',Courier,monospace;">${esc(d.transactionRef)}</span>`) +
    (d.transactionId
      ? metaRow('Transaction ID', `<span style="font-family:'Courier New',Courier,monospace;">${esc(d.transactionId)}</span>`)
      : '') +
    metaRow('Date &amp; time', esc(paidDate)) +
    (d.channel ? metaRow('Payment method', esc(d.channel.charAt(0).toUpperCase() + d.channel.slice(1))) : '');

  // ── collection card extras ──
  const organizerLine = d.organizerName
    ? `<tr><td style="padding:6px 0 0;color:#5b6b60;font-size:13px;">Organized by <strong style="color:#1f2d23;">${esc(d.organizerName)}</strong></td></tr>`
    : '';
  const desc = d.collectionDescription || '';
  const descLine = desc
    ? `<tr><td style="padding:8px 0 0;color:#5b6b60;font-size:13px;line-height:1.6;">${esc(desc.length > 180 ? desc.slice(0, 177) + '...' : desc)}</td></tr>`
    : '';

  // ── unique codes (omitted entirely when there are none). Tickets get a
  // distinct "admit one" stub treatment; everything else gets monospace chips. ──
  const uniqueCodes = Array.isArray(d.uniqueCodes) ? d.uniqueCodes.filter(Boolean) : [];
  const codeCount = uniqueCodes.length;
  const codesHeading = isTicket
    ? `Your ticket${codeCount > 1 ? 's' : ''}`
    : `Your unique code${codeCount > 1 ? 's' : ''}`;
  const ticketStub = (c) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;border:1px solid #FFE082;border-radius:10px;overflow:hidden;">
            <tr>
              <td width="6" style="background:#FFCA28;font-size:0;line-height:0;width:6px;">&nbsp;</td>
              <td style="padding:12px 16px;background:#FFFDF5;">
                <p style="margin:0 0 3px;color:#9a7b1e;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;">Admit one &middot; Entry code</p>
                <p style="margin:0;color:#1B5E20;font-family:'Courier New',Courier,monospace;font-size:18px;font-weight:700;letter-spacing:.1em;">${esc(c)}</p>
              </td>
            </tr>
          </table>`;
  const codeChip = (c) =>
    `<span style="display:inline-block;background:#FFFDF5;border:1px solid #FFE082;color:#1B5E20;font-family:'Courier New',Courier,monospace;font-size:15px;font-weight:700;letter-spacing:.08em;padding:9px 14px;border-radius:8px;margin:0 8px 8px 0;">${esc(c)}</span>`;
  const codeChips =
    codeCount > 0
      ? `
        <tr><td class="px" style="padding:6px 32px 0;">
          <p style="margin:0 0 9px;color:#7a8a7f;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;">${codesHeading}</p>
          ${uniqueCodes.map((c) => (isTicket ? ticketStub(c) : codeChip(c))).join('')}
          ${isTicket ? `<p style="margin:2px 0 0;color:#9aa69d;font-size:12px;line-height:1.5;">Present ${codeCount > 1 ? 'these codes' : 'this code'} at the entrance for check-in.</p>` : ''}
        </td></tr>`
      : '';

  // ── trust timeline ──
  const steps = ['Payment received', 'Payment verified', 'Contribution recorded', 'Receipt generated'];
  const timeline = steps
    .map(
      (s) => `
            <tr>
              <td width="22" valign="middle" style="padding:5px 0;">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="20" height="20" align="center" valign="middle" bgcolor="#1B5E20" style="background:#1B5E20;border-radius:999px;color:#ffffff;font-size:11px;line-height:20px;">&#10003;</td></tr></table>
              </td>
              <td valign="middle" style="padding:5px 0 5px 12px;color:#1f2d23;font-size:14px;">${s}</td>
            </tr>`,
    )
    .join('');

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <meta name="color-scheme" content="light"/>
  <meta name="supported-color-schemes" content="light"/>
  <title>Payment Successful - Kolekto</title>
  <style>
    body{margin:0;padding:0;width:100%!important;background:#eef1ee;}
    img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
    table{border-collapse:collapse!important;}
    a{color:#1B5E20;}
    @media only screen and (max-width:600px){
      .container{width:100%!important;border-radius:0!important;}
      .px{padding-left:20px!important;padding-right:20px!important;}
      .hero-h1{font-size:23px!important;}
      .total-amt{font-size:20px!important;}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#eef1ee;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <!-- Preheader (hidden inbox preview line) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#eef1ee;">Payment successful - your ${esc(typeLabel.toLowerCase())} of ${money(d.totalPaid)} to ${esc(d.collectionTitle)} is confirmed and recorded on Kolekto.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1ee;">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e3e8e4;">

        <!-- Brand accent bar -->
        <tr><td style="height:4px;background:#1B5E20;line-height:4px;font-size:4px;">&nbsp;</td></tr>

        <!-- Logo header (on white, so any logo colour reads well) -->
        <tr><td align="center" style="padding:26px 32px 6px;">
          <img src="${KOLEKTO_LOGO_URL}" alt="Kolekto" height="34" style="height:34px;width:auto;display:block;"/>
        </td></tr>

        <!-- Success hero -->
        <tr><td align="center" class="px" style="padding:16px 32px 30px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="62" height="62" align="center" valign="middle" bgcolor="#1B5E20" style="background:#1B5E20;border-radius:999px;color:#ffffff;font-size:30px;line-height:62px;">&#10003;</td></tr></table>
          <h1 class="hero-h1" style="margin:18px 0 5px;color:#14210f;font-size:26px;font-weight:800;letter-spacing:-.02em;">Payment Successful</h1>
          <p style="margin:0;color:#5b6b60;font-size:15px;line-height:1.5;">Your ${esc(typeLabel.toLowerCase())} has been received and recorded.</p>
        </td></tr>

        <!-- Greeting -->
        <tr><td class="px" style="padding:0 32px;">
          <p style="margin:0 0 6px;color:#14210f;font-size:16px;font-weight:600;">Hi ${esc(d.payerName)},</p>
          <p style="margin:0 0 22px;color:#5b6b60;font-size:14px;line-height:1.7;">Thank you. Your payment has been successfully received and recorded on Kolekto. Keep this email as your official receipt and proof of payment.</p>
        </td></tr>

        <!-- Collection information card -->
        <tr><td class="px" style="padding:0 32px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f8f5;border:1px solid #e2eae3;border-radius:12px;">
            <tr><td style="padding:18px;">
              <span style="display:inline-block;background:#E8F5E9;color:#1B5E20;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:4px 11px;border-radius:999px;">${esc(typeLabel)}</span>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:11px;">
                <tr><td style="color:#14210f;font-size:17px;font-weight:700;line-height:1.35;">${esc(d.collectionTitle)}</td></tr>
                ${organizerLine}
                ${descLine}
              </table>
            </td></tr>
          </table>
        </td></tr>

        <!-- Receipt document card -->
        <tr><td class="px" style="padding:16px 32px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5eae6;border-radius:12px;overflow:hidden;">
            <tr><td style="background:#fbfcfb;border-bottom:1px solid #eef2ef;padding:12px 18px;">
              <span style="color:#7a8a7f;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;">Receipt</span>
            </td></tr>
            <tr><td style="padding:12px 18px 2px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${amountRow(typeLabel + ' amount', d.contributionAmount)}
                ${feeRows}
              </table>
            </td></tr>
            <tr><td style="padding:6px 18px;"><div style="border-top:1px dashed #d7ded9;font-size:0;line-height:0;height:1px;">&nbsp;</div></td></tr>
            <tr><td style="padding:4px 18px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="color:#14210f;font-size:15px;font-weight:700;vertical-align:middle;">Total paid</td>
                  <td align="right" class="total-amt" style="color:#1B5E20;font-size:22px;font-weight:800;letter-spacing:-.01em;white-space:nowrap;vertical-align:middle;">${money(d.totalPaid)}</td>
                </tr>
              </table>
            </td></tr>
            <tr><td style="background:#fbfcfb;border-top:1px solid #eef2ef;padding:8px 18px 12px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${meta}
              </table>
            </td></tr>
          </table>
        </td></tr>
        ${codeChips}

        <!-- Trust timeline -->
        <tr><td class="px" style="padding:22px 32px 4px;">
          <p style="margin:0 0 10px;color:#7a8a7f;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;">Status</p>
          <table role="presentation" cellpadding="0" cellspacing="0">${timeline}
          </table>
        </td></tr>

        <!-- View receipt button (bulletproof: VML for Outlook, anchor elsewhere) -->
        <tr><td class="px" align="center" style="padding:22px 32px 2px;">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${receiptUrl}" style="height:46px;v-text-anchor:middle;width:210px;" arcsize="22%" stroke="f" fillcolor="#1B5E20">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;">View Receipt</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-- -->
          <a href="${receiptUrl}" target="_blank" style="display:inline-block;background:#1B5E20;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:13px 34px;border-radius:10px;mso-padding-alt:0;">View Receipt</a>
          <!--<![endif]-->
          <p style="margin:13px 0 0;color:#7a8a7f;font-size:12px;line-height:1.6;">Page didn't open? Your payment is recorded - quote reference <span style="font-family:'Courier New',Courier,monospace;color:#1f2d23;">${esc(d.transactionRef)}</span> to support.</p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:26px 32px 30px;border-top:1px solid #eef2ef;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
            <div style="font-size:18px;font-weight:800;color:#1B5E20;letter-spacing:-.02em;">Kolekto</div>
            <p style="margin:6px 0 12px;color:#7a8a7f;font-size:12px;line-height:1.6;">Building trust in community payments across Africa.</p>
            <p style="margin:0 0 6px;">
              <a href="https://www.kolekto.com.ng" style="color:#1B5E20;font-size:12px;text-decoration:none;font-weight:600;">kolekto.com.ng</a>
              <span style="color:#c4cdc6;">&nbsp;&nbsp;|&nbsp;&nbsp;</span>
              <a href="mailto:team@kolekto.com.ng" style="color:#1B5E20;font-size:12px;text-decoration:none;font-weight:600;">team@kolekto.com.ng</a>
            </p>
            <p style="margin:8px 0 0;color:#aab4ac;font-size:11px;">&copy; ${new Date().getFullYear()} Kolekto. All rights reserved.</p>
          </td></tr></table>
        </td></tr>

      </table>
      <p style="margin:14px 0 0;color:#9aa69d;font-size:11px;">This is an automated receipt from Kolekto. Please do not reply.</p>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Public template used by sendPaymentConfirmation(). Maps the (historically
 * `amount`-centric) options onto the premium renderer. New premium fields are
 * optional so older call sites keep working — they simply render without the
 * fee breakdown / organizer / codes sections.
 */
export const paymentConfirmationTemplate = (opts = {}) => {
  const {
    payerName,
    collectionTitle,
    collectionType,
    collectionDescription,
    organizerName,
    amount,
    contributionAmount,
    platformFee,
    gatewayFee,
    totalPaid,
    currency = 'NGN',
    transactionRef,
    transactionId,
    paidAt,
    channel,
    participants = [],
    uniqueCodes,
  } = opts;

  // Derive unique codes from participants when not provided explicitly.
  const codes = Array.isArray(uniqueCodes) && uniqueCodes.length
    ? uniqueCodes
    : (participants || []).map((p) => p && p.uniqueCode).filter(Boolean);

  return renderReceiptEmail({
    payerName: payerName || 'there',
    collectionTitle: collectionTitle || 'Collection',
    collectionType: collectionType || 'fixed',
    collectionDescription,
    organizerName,
    // `amount` historically carried the total charged; treat it as the fallback
    // for both the contribution amount and the grand total.
    contributionAmount: contributionAmount != null ? contributionAmount : amount,
    platformFee: Number(platformFee) || 0,
    gatewayFee: Number(gatewayFee) || 0,
    totalPaid: totalPaid != null ? totalPaid : amount,
    currency,
    transactionRef,
    transactionId,
    paidAt: paidAt || new Date().toISOString(),
    channel,
    uniqueCodes: codes,
    // Frontend base URL for the "View Receipt" link (per-env via FRONTEND_URL).
    baseUrl: process.env.FRONTEND_URL || undefined,
  });
};
