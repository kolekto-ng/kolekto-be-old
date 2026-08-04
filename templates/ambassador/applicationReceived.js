import { renderAmbassadorEmail, AMBASSADOR_BRAND } from './baseTemplate.js';

export function applicationReceivedTemplate({ fullName }) {
  const name = fullName || 'there';
  const subject = "We've Received Your Kolekto Ambassador Application 🎉";

  const bodyHtml = `
    <h2 style="margin:0 0 16px 0;color:${AMBASSADOR_BRAND.primary};font-size:21px;">Thanks for applying, ${name}!</h2>
    <p style="margin:0 0 16px 0;">
      We're excited that you want to represent Kolekto on your campus and in your community. This email confirms
      that your Ambassador Program application has been <strong>received successfully</strong>.
    </p>
    <p style="margin:0 0 8px 0;font-weight:700;color:${AMBASSADOR_BRAND.primary};">What happens next?</p>
    <ul style="margin:0 0 16px 0;padding-left:20px;">
      <li style="margin-bottom:8px;">Our team will carefully review your application.</li>
      <li style="margin-bottom:8px;">If you're shortlisted, we'll reach out to schedule a short interview.</li>
      <li style="margin-bottom:8px;">You'll be notified by email either way — no need to keep checking in.</li>
    </ul>
    <p style="margin:0 0 16px 0;">
      While you wait, follow us for updates, ambassador spotlights, and program news — it's the best way to stay in
      the loop.
    </p>
    <p style="margin:24px 0 0 0;">Thank you for wanting to be part of the Kolekto movement.</p>
    <p style="margin:4px 0 0 0;">— The Kolekto Team</p>
  `;

  return {
    subject,
    html: renderAmbassadorEmail({
      title: subject,
      preheader: 'Your Kolekto Ambassador application is in — here is what happens next.',
      bodyHtml,
      ctaLabel: 'Follow Kolekto Updates',
      ctaUrl: `${AMBASSADOR_BRAND.siteUrl}`,
    }),
    text:
      `Hi ${name},\n\n` +
      `Thanks for applying to the Kolekto Ambassador Program. Your application has been received successfully.\n\n` +
      `What happens next:\n` +
      `- Our team will review your application.\n` +
      `- If shortlisted, we'll contact you to schedule an interview.\n` +
      `- You'll be notified by email either way.\n\n` +
      `Follow Kolekto for updates: ${AMBASSADOR_BRAND.siteUrl}\n\n` +
      `Thank you for wanting to be part of the Kolekto movement.\n` +
      `— The Kolekto Team`,
  };
}
