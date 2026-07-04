import { renderAmbassadorEmail, AMBASSADOR_BRAND } from './baseTemplate.js';

function formatNaira(amount) {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(Number(amount || 0));
}

function formatDate(d) {
  return new Date(d || Date.now()).toLocaleString('en-NG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function withdrawalPaidTemplate({ fullName, amount, bankName, accountNumber, paidAt }) {
  const name = fullName || 'there';
  const subject = 'Your Kolekto Payout Has Been Sent 🎉';

  const detailsRows = `
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;width:45%;border-bottom:1px solid #f0f0f0;">Amount Paid</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};font-weight:700;border-bottom:1px solid #f0f0f0;">${formatNaira(amount)}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;border-bottom:1px solid #f0f0f0;">Date Processed</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};border-bottom:1px solid #f0f0f0;">${formatDate(paidAt)}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;">Destination Account</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};">${bankName || 'N/A'} — ${accountNumber || 'N/A'}</td>
    </tr>
  `;

  const bodyHtml = `
    <h2 style="margin:0 0 16px 0;color:${AMBASSADOR_BRAND.primary};font-size:22px;">You've been paid, ${name}! 🎉</h2>
    <p style="margin:0 0 16px 0;">
      Your Kolekto Ambassador payout is on its way to your bank account. Thank you for everything you've done to grow
      the Kolekto community — your impact truly matters.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;font-size:14px;">
      <tbody>${detailsRows}</tbody>
    </table>
    <p style="margin:0 0 16px 0;">
      Keep referring organizers and growing your community — the more impact you drive, the more you earn. We're
      cheering you on!
    </p>
    <p style="margin:16px 0 0 0;">
      Questions about this payment? Reach out to
      <a href="mailto:${AMBASSADOR_BRAND.supportEmail}" style="color:${AMBASSADOR_BRAND.primary};font-weight:600;text-decoration:none;">${AMBASSADOR_BRAND.supportEmail}</a>.
    </p>
    <p style="margin:24px 0 0 0;">With gratitude,</p>
    <p style="margin:4px 0 0 0;">— The Kolekto Team</p>
  `;

  return {
    subject,
    html: renderAmbassadorEmail({
      title: subject,
      preheader: `${formatNaira(amount)} has been sent to your bank account.`,
      bodyHtml,
    }),
    text:
      `You've been paid, ${name}!\n\n` +
      `Your Kolekto Ambassador payout is on its way.\n\n` +
      `Amount Paid: ${formatNaira(amount)}\n` +
      `Date Processed: ${formatDate(paidAt)}\n` +
      `Destination Account: ${bankName || 'N/A'} — ${accountNumber || 'N/A'}\n\n` +
      `Thank you for everything you do for the Kolekto community.\n\n` +
      `Questions? Contact ${AMBASSADOR_BRAND.supportEmail}.\n\n` +
      `— The Kolekto Team`,
  };
}
