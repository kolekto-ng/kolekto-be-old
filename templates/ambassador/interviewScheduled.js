import { renderAmbassadorEmail, AMBASSADOR_BRAND } from './baseTemplate.js';

// interview_timezone is a free-text admin field (e.g. "WAT", "Africa/Lagos",
// "Africa/Lagos (WAT)") — it is NOT guaranteed to be a valid IANA timezone
// identifier that Intl accepts. A bad value must never crash email
// generation (that would silently drop the whole notification), so we try
// the given value and gracefully fall back to UTC formatting if Intl
// rejects it.
function formatWithTimezone(d, options, timezone) {
  try {
    return d.toLocaleString('en-NG', { ...options, timeZone: timezone });
  } catch (_err) {
    return d.toLocaleString('en-NG', { ...options, timeZone: 'UTC' });
  }
}

function formatInterviewDateTime(isoDate, timezone) {
  if (!isoDate) return { date: 'To be confirmed', time: '' };
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return { date: isoDate, time: '' };

  const date = timezone
    ? formatWithTimezone(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, timezone)
    : d.toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = timezone
    ? formatWithTimezone(d, { hour: '2-digit', minute: '2-digit' }, timezone)
    : d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
  return { date, time };
}

export function interviewScheduledTemplate({ fullName, interviewDate, timezone, location, prepNotes }) {
  const name = fullName || 'there';
  const subject = 'Your Kolekto Ambassador Interview Has Been Scheduled 📅';
  const { date, time } = formatInterviewDateTime(interviewDate, timezone);
  const tzLabel = timezone || 'WAT (West Africa Time)';
  const locationLabel = location || 'Details will be shared before the interview';

  const detailsRows = `
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;width:40%;border-bottom:1px solid #f0f0f0;">Date</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};font-weight:700;border-bottom:1px solid #f0f0f0;">${date}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;border-bottom:1px solid #f0f0f0;">Time</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};font-weight:700;border-bottom:1px solid #f0f0f0;">${time || 'To be confirmed'}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;border-bottom:1px solid #f0f0f0;">Timezone</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};border-bottom:1px solid #f0f0f0;">${tzLabel}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textMuted};font-weight:600;">Meeting location / link</td>
      <td style="padding:10px 0;color:${AMBASSADOR_BRAND.textDark};">${locationLabel}</td>
    </tr>
  `;

  const prepSection = prepNotes
    ? `
      <p style="margin:20px 0 8px 0;font-weight:700;color:${AMBASSADOR_BRAND.primary};">How to prepare</p>
      <p style="margin:0 0 16px 0;white-space:pre-line;">${prepNotes}</p>
    `
    : '';

  const bodyHtml = `
    <h2 style="margin:0 0 16px 0;color:${AMBASSADOR_BRAND.primary};font-size:21px;">Great news, ${name}!</h2>
    <p style="margin:0 0 16px 0;">
      You've been shortlisted for the Kolekto Ambassador Program, and we'd love to speak with you. Your interview has
      been scheduled — details below.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 8px 0;font-size:14px;">
      <tbody>${detailsRows}</tbody>
    </table>
    ${prepSection}
    <p style="margin:16px 0 0 0;">
      Questions before your interview? Reach out to
      <a href="mailto:${AMBASSADOR_BRAND.supportEmail}" style="color:${AMBASSADOR_BRAND.primary};font-weight:600;text-decoration:none;">${AMBASSADOR_BRAND.supportEmail}</a>
      and we'll be glad to help.
    </p>
    <p style="margin:24px 0 0 0;">We're looking forward to meeting you!</p>
    <p style="margin:4px 0 0 0;">— The Kolekto Team</p>
  `;

  return {
    subject,
    html: renderAmbassadorEmail({
      title: subject,
      preheader: `Your interview is set for ${date}${time ? ` at ${time}` : ''}.`,
      bodyHtml,
      ctaLabel: location && /^https?:\/\//i.test(location) ? 'Join Interview' : undefined,
      ctaUrl: location && /^https?:\/\//i.test(location) ? location : undefined,
    }),
    text:
      `Hi ${name},\n\n` +
      `Your Kolekto Ambassador interview has been scheduled.\n\n` +
      `Date: ${date}\n` +
      `Time: ${time || 'To be confirmed'}\n` +
      `Timezone: ${tzLabel}\n` +
      `Location/Link: ${locationLabel}\n\n` +
      (prepNotes ? `How to prepare:\n${prepNotes}\n\n` : '') +
      `Questions? Contact ${AMBASSADOR_BRAND.supportEmail}.\n\n` +
      `— The Kolekto Team`,
  };
}
