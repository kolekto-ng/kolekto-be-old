import { renderAmbassadorEmail, AMBASSADOR_BRAND } from './baseTemplate.js';

export function suspendedTemplate({ fullName, reason }) {
  const name = fullName || 'there';
  const subject = 'Important Update Regarding Your Ambassador Account';

  const bodyHtml = `
    <h2 style="margin:0 0 16px 0;color:${AMBASSADOR_BRAND.primary};font-size:21px;">Hi ${name},</h2>
    <p style="margin:0 0 16px 0;">
      We're writing to let you know that your Kolekto Ambassador account has been <strong>temporarily suspended</strong>.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;">
      <tr>
        <td style="padding:16px 18px;">
          <p style="margin:0 0 4px 0;font-size:12px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:0.5px;">Reason</p>
          <p style="margin:0;color:#92400e;">${reason || 'Our team is reviewing an issue with your ambassador account.'}</p>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px 0;font-weight:700;color:${AMBASSADOR_BRAND.primary};">What happens next</p>
    <ul style="margin:0 0 16px 0;padding-left:20px;">
      <li style="margin-bottom:8px;">Your ambassador dashboard access is paused during this review.</li>
      <li style="margin-bottom:8px;">Any pending withdrawals will remain on hold until this is resolved.</li>
      <li style="margin-bottom:8px;">You'll be notified by email as soon as a decision is made.</li>
    </ul>
    <p style="margin:16px 0 0 0;">
      If you believe this was a mistake or would like to discuss it, please reach out to our support team at
      <a href="mailto:${AMBASSADOR_BRAND.supportEmail}" style="color:${AMBASSADOR_BRAND.primary};font-weight:600;text-decoration:none;">${AMBASSADOR_BRAND.supportEmail}</a>
      — we're happy to help.
    </p>
    <p style="margin:24px 0 0 0;">— The Kolekto Team</p>
  `;

  return {
    subject,
    html: renderAmbassadorEmail({
      title: subject,
      preheader: 'Your Kolekto Ambassador account has been temporarily suspended.',
      bodyHtml,
    }),
    text:
      `Hi ${name},\n\n` +
      `Your Kolekto Ambassador account has been temporarily suspended.\n\n` +
      `Reason: ${reason || 'Our team is reviewing an issue with your ambassador account.'}\n\n` +
      `Your dashboard access is paused during this review, and any pending withdrawals will remain on hold. ` +
      `You'll be notified by email once a decision is made.\n\n` +
      `Questions? Contact ${AMBASSADOR_BRAND.supportEmail}.\n\n` +
      `— The Kolekto Team`,
  };
}
