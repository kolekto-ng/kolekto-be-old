import { renderAmbassadorEmail, AMBASSADOR_BRAND } from './baseTemplate.js';

export function reactivatedTemplate({ fullName, portalUrl }) {
  const name = fullName || 'there';
  const subject = 'Welcome Back to the Kolekto Ambassador Program 🎉';

  const bodyHtml = `
    <h2 style="margin:0 0 16px 0;color:${AMBASSADOR_BRAND.primary};font-size:21px;">Welcome back, ${name}!</h2>
    <p style="margin:0 0 16px 0;">
      Good news — your Kolekto Ambassador account has been <strong>restored</strong> and is fully active again.
    </p>
    <p style="margin:0 0 16px 0;">
      You can continue using the Ambassador Portal exactly as before: track your referrals, manage your earnings, and
      access ambassador resources.
    </p>
    <p style="margin:16px 0 0 0;">
      If you have any questions, our team is here for you at
      <a href="mailto:${AMBASSADOR_BRAND.supportEmail}" style="color:${AMBASSADOR_BRAND.primary};font-weight:600;text-decoration:none;">${AMBASSADOR_BRAND.supportEmail}</a>.
    </p>
    <p style="margin:24px 0 0 0;">We're glad to have you back!</p>
    <p style="margin:4px 0 0 0;">— The Kolekto Team</p>
  `;

  return {
    subject,
    html: renderAmbassadorEmail({
      title: subject,
      preheader: 'Your Kolekto Ambassador account has been restored.',
      bodyHtml,
      ctaLabel: 'Open Ambassador Portal',
      ctaUrl: portalUrl,
    }),
    text:
      `Welcome back, ${name}!\n\n` +
      `Your Kolekto Ambassador account has been restored and is fully active again. You can continue using the ` +
      `Ambassador Portal as before: ${portalUrl}\n\n` +
      `Questions? Contact ${AMBASSADOR_BRAND.supportEmail}.\n\n` +
      `— The Kolekto Team`,
  };
}
