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

export function withdrawalRequestedTemplate({ fullName, amount, bankName, accountNumber, requestedAt, status = 'Pending', portalUrl }) {
  const name = fullName || 'there';
  const subject = 'Your Withdrawal Request Has Been Received 💳';

  const detailsRows = `
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;width:45%;border-bottom:1px solid #f0f0f0;">Amount</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};font-weight:700;border-bottom:1px solid #f0f0f0;">${formatNaira(amount)}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;border-bottom:1px solid #f0f0f0;">Bank</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};border-bottom:1px solid #f0f0f0;">${bankName || 'N/A'}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;border-bottom:1px solid #f0f0f0;">Account Number</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};border-bottom:1px solid #f0f0f0;">${accountNumber || 'N/A'}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;border-bottom:1px solid #f0f0f0;">Request Date</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};border-bottom:1px solid #f0f0f0;">${formatDate(requestedAt)}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;">Status</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};font-weight:700;">${status}</td>
    </tr>
  `;

  const bodyHtml = `
    <h2 style="margin:0 0 16px 0;color:${AMBASSADOR_BRAND.primary};font-size:21px;">Hi ${name},</h2>
    <p style="margin:0 0 16px 0;">
      We've received your withdrawal request. Here's a summary for your records:
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;font-size:14px;">
      <tbody>${detailsRows}</tbody>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
      <tr>
        <td style="padding:14px 16px;font-size:13px;color:#166534;">
          <strong>Please note:</strong> Payouts are processed on the last Friday of every month.
        </td>
      </tr>
    </table>
    <p style="margin:0 0 16px 0;">
      We'll email you again once your withdrawal is approved and once it's paid out, so you always know where things
      stand.
    </p>
    <p style="margin:16px 0 0 0;">
      Questions in the meantime? Reach out to
      <a href="mailto:${AMBASSADOR_BRAND.supportEmail}" style="color:${AMBASSADOR_BRAND.primary};font-weight:600;text-decoration:none;">${AMBASSADOR_BRAND.supportEmail}</a>.
    </p>
    <p style="margin:24px 0 0 0;">— The Kolekto Team</p>
  `;

  return {
    subject,
    html: renderAmbassadorEmail({
      title: subject,
      preheader: `We received your withdrawal request for ${formatNaira(amount)}.`,
      bodyHtml,
      ctaLabel: portalUrl ? 'View Withdrawal Status' : undefined,
      ctaUrl: portalUrl,
    }),
    text:
      `Hi ${name},\n\n` +
      `We've received your withdrawal request.\n\n` +
      `Amount: ${formatNaira(amount)}\n` +
      `Bank: ${bankName || 'N/A'}\n` +
      `Account Number: ${accountNumber || 'N/A'}\n` +
      `Request Date: ${formatDate(requestedAt)}\n` +
      `Status: ${status}\n\n` +
      `Please note: Payouts are processed on the last Friday of every month.\n\n` +
      `Questions? Contact ${AMBASSADOR_BRAND.supportEmail}.\n\n` +
      `— The Kolekto Team`,
  };
}
