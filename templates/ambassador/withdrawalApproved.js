import { renderAmbassadorEmail, AMBASSADOR_BRAND } from './baseTemplate.js';

function formatNaira(amount) {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(Number(amount || 0));
}

export function withdrawalApprovedTemplate({ fullName, amount, bankName, accountNumber, referenceId }) {
  const name = fullName || 'there';
  const subject = 'Your Kolekto Withdrawal Has Been Approved ✅';

  const detailsRows = `
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;width:45%;border-bottom:1px solid #f0f0f0;">Approved Amount</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};font-weight:700;border-bottom:1px solid #f0f0f0;">${formatNaira(amount)}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;border-bottom:1px solid #f0f0f0;">Bank</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};border-bottom:1px solid #f0f0f0;">${bankName || 'N/A'}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;${referenceId ? 'border-bottom:1px solid #f0f0f0;' : ''}">Account Number</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};${referenceId ? 'border-bottom:1px solid #f0f0f0;' : ''}">${accountNumber || 'N/A'}</td>
    </tr>
    ${referenceId ? `
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;">Reference</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};">${referenceId}</td>
    </tr>` : ''}
  `;

  const bodyHtml = `
    <h2 style="margin:0 0 16px 0;color:${AMBASSADOR_BRAND.primary};font-size:21px;">Good news, ${name}!</h2>
    <p style="margin:0 0 16px 0;">
      Your withdrawal request has been <strong>approved</strong>. It's now queued for payment.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;font-size:14px;">
      <tbody>${detailsRows}</tbody>
    </table>
    <p style="margin:0 0 16px 0;">
      Expected payment timeline: payouts go out on the <strong>last Friday of every month</strong>. We'll send you a
      final confirmation as soon as the funds are on their way.
    </p>
    <p style="margin:16px 0 0 0;">
      Questions about your payout? Contact
      <a href="mailto:${AMBASSADOR_BRAND.supportEmail}" style="color:${AMBASSADOR_BRAND.primary};font-weight:600;text-decoration:none;">${AMBASSADOR_BRAND.supportEmail}</a>.
    </p>
    <p style="margin:24px 0 0 0;">— The Kolekto Team</p>
  `;

  return {
    subject,
    html: renderAmbassadorEmail({
      title: subject,
      preheader: `Your withdrawal of ${formatNaira(amount)} has been approved.`,
      bodyHtml,
    }),
    text:
      `Hi ${name},\n\n` +
      `Your withdrawal request has been approved and is now queued for payment.\n\n` +
      `Approved Amount: ${formatNaira(amount)}\n` +
      `Bank: ${bankName || 'N/A'}\n` +
      `Account Number: ${accountNumber || 'N/A'}\n` +
      (referenceId ? `Reference: ${referenceId}\n` : '') +
      `\nExpected payment timeline: payouts go out on the last Friday of every month.\n\n` +
      `Questions? Contact ${AMBASSADOR_BRAND.supportEmail}.\n\n` +
      `— The Kolekto Team`,
  };
}
