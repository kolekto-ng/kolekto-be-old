import { renderAmbassadorEmail, AMBASSADOR_BRAND } from './baseTemplate.js';

export function acceptedTemplate({ fullName, ambassadorCode, rank, portalUrl, referralUrl }) {
  const name = fullName || 'Kolekto Ambassador';
  const subject = 'Welcome to the Kolekto Ambassador Program! 🚀';

  const bodyHtml = `
    <h2 style="margin:0 0 16px 0;color:${AMBASSADOR_BRAND.primary};font-size:22px;">Congratulations, ${name}! 🎉</h2>
    <p style="margin:0 0 16px 0;">
      Your Kolekto Ambassador application has been <strong>accepted</strong>. Welcome to a community of student
      leaders changing how their campuses and communities raise and manage money together.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
      <tr>
        <td style="padding:18px 20px;">
          <p style="margin:0 0 4px 0;font-size:12px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:0.5px;">Your Ambassador Code</p>
          <p style="margin:0 0 12px 0;font-size:26px;font-weight:800;color:#166534;letter-spacing:1px;">${ambassadorCode || '——'}</p>
          ${rank ? `<p style="margin:0;font-size:13px;color:#166534;"><strong>Leadership Level:</strong> ${rank}</p>` : ''}
        </td>
      </tr>
    </table>

    <p style="margin:0 0 8px 0;font-weight:700;color:${AMBASSADOR_BRAND.primary};">Getting started is easy:</p>
    <ol style="margin:0 0 16px 0;padding-left:20px;">
      <li style="margin-bottom:8px;">Visit the Ambassador Portal using the button below.</li>
      <li style="margin-bottom:8px;">Sign in with your registered email address.</li>
      <li style="margin-bottom:8px;">Set up your secure PIN — this is what you'll use to log in going forward.</li>
      <li style="margin-bottom:8px;">Complete your profile so organizers and Kolekto can recognize you.</li>
      <li style="margin-bottom:8px;">Access your dashboard to track referrals, earnings, and resources.</li>
    </ol>

    ${referralUrl ? `
    <p style="margin:0 0 16px 0;">
      Your shareable referral link:
      <br /><a href="${referralUrl}" style="color:${AMBASSADOR_BRAND.primary};word-break:break-all;">${referralUrl}</a>
    </p>` : ''}

    <p style="margin:16px 0 0 0;">
      Need a hand getting set up? Our team is here for you at
      <a href="mailto:${AMBASSADOR_BRAND.supportEmail}" style="color:${AMBASSADOR_BRAND.primary};font-weight:600;text-decoration:none;">${AMBASSADOR_BRAND.supportEmail}</a>.
    </p>
    <p style="margin:24px 0 0 0;">Welcome aboard — we can't wait to see your impact!</p>
    <p style="margin:4px 0 0 0;">— The Kolekto Team</p>
  `;

  return {
    subject,
    html: renderAmbassadorEmail({
      title: subject,
      preheader: `You're in, ${name}! Your ambassador code is ${ambassadorCode}.`,
      bodyHtml,
      ctaLabel: 'Open Ambassador Portal',
      ctaUrl: portalUrl,
    }),
    text:
      `Congratulations, ${name}!\n\n` +
      `Your Kolekto Ambassador application has been accepted.\n\n` +
      `Your ambassador code: ${ambassadorCode}\n` +
      (rank ? `Leadership level: ${rank}\n` : '') +
      `\nGetting started:\n` +
      `1. Visit the Ambassador Portal: ${portalUrl}\n` +
      `2. Sign in with your registered email.\n` +
      `3. Set up your PIN.\n` +
      `4. Complete your profile.\n` +
      `5. Access your dashboard.\n\n` +
      (referralUrl ? `Your referral link: ${referralUrl}\n\n` : '') +
      `Need help? Contact ${AMBASSADOR_BRAND.supportEmail}.\n\n` +
      `— The Kolekto Team`,
  };
}
