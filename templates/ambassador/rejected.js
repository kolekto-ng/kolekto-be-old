import { renderAmbassadorEmail, AMBASSADOR_BRAND } from './baseTemplate.js';

export function rejectedTemplate({ fullName }) {
  const name = fullName || 'there';
  const subject = 'Update on Your Kolekto Ambassador Application';

  const bodyHtml = `
    <h2 style="margin:0 0 16px 0;color:${AMBASSADOR_BRAND.primary};font-size:21px;">Hi ${name},</h2>
    <p style="margin:0 0 16px 0;">
      Thank you for taking the time to apply to the Kolekto Ambassador Program and for your interest in representing
      Kolekto. We genuinely appreciate the energy and enthusiasm you brought to your application.
    </p>
    <p style="margin:0 0 16px 0;">
      After careful review, we won't be moving forward with your application at this time. This was a difficult
      decision — we received many strong applications and could only accept a limited number of ambassadors for this
      cohort.
    </p>
    <p style="margin:0 0 16px 0;">
      This isn't the end of the road. We'd love for you to stay connected with Kolekto, keep an eye out for future
      ambassador openings, and continue engaging with our community in other ways.
    </p>
    <p style="margin:16px 0 0 0;">
      If you have any questions, feel free to reach out to
      <a href="mailto:${AMBASSADOR_BRAND.supportEmail}" style="color:${AMBASSADOR_BRAND.primary};font-weight:600;text-decoration:none;">${AMBASSADOR_BRAND.supportEmail}</a>.
    </p>
    <p style="margin:24px 0 0 0;">Thank you again, and we hope to cross paths again soon.</p>
    <p style="margin:4px 0 0 0;">— The Kolekto Team</p>
  `;

  return {
    subject,
    html: renderAmbassadorEmail({
      title: subject,
      preheader: 'An update on your Kolekto Ambassador Program application.',
      bodyHtml,
    }),
    text:
      `Hi ${name},\n\n` +
      `Thank you for applying to the Kolekto Ambassador Program. After careful review, we won't be moving forward ` +
      `with your application at this time. We received many strong applications and could only accept a limited ` +
      `number of ambassadors for this cohort.\n\n` +
      `We'd love for you to stay connected with Kolekto and watch for future opportunities.\n\n` +
      `Questions? Contact ${AMBASSADOR_BRAND.supportEmail}.\n\n` +
      `— The Kolekto Team`,
  };
}
