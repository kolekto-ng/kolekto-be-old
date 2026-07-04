import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Dedicated SMTP transport for the Ambassador Program, backed by its own
// ZeptoMail Mail Agent. This is intentionally isolated from
// services/emailService.js (the main Kolekto transactional mailer) — separate
// credentials, separate transporter, separate failure domain. A problem with
// one must never affect the other.
const createAmbassadorTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.AMBASSADOR_SMTP_HOST,
    port: parseInt(process.env.AMBASSADOR_SMTP_PORT || '587'),
    secure: process.env.AMBASSADOR_SMTP_PORT === '465',
    auth: {
      user: process.env.AMBASSADOR_SMTP_USER,
      pass: process.env.AMBASSADOR_SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    },
  });
};

/**
 * Health check for the Ambassador Mail Agent's SMTP connectivity/auth.
 * Mirrors verifyEmailConfig() in services/emailService.js but targets the
 * ambassador-only transporter.
 */
export const verifyAmbassadorEmailConfig = async () => {
  try {
    const transporter = createAmbassadorTransporter();
    await transporter.verify();
    console.log('✅ [ambassador-mailer] SMTP connection verified — ready to send');
    return true;
  } catch (error) {
    console.error('❌ [ambassador-mailer] SMTP configuration error:', error?.message || error);
    return false;
  }
};

/**
 * Sends a single email via the dedicated Ambassador Mail Agent. Same
 * contract as services/emailService.js's sendEmail — never throws, always
 * resolves to { success, messageId?, response?, error? } — so the retry
 * wrapper in utils/ambassadorEmailer.js can call it repeatedly.
 */
export const sendAmbassadorMail = async ({ to, subject, html, text, attachments, cc, bcc }) => {
  try {
    const transporter = createAmbassadorTransporter();

    const fromAddress = process.env.AMBASSADOR_SMTP_FROM || process.env.AMBASSADOR_SMTP_USER;
    const fromName = process.env.AMBASSADOR_SMTP_FROM_NAME || 'Kolekto Ambassador Program';

    const mailOptions = {
      from: `"${fromName}" <${fromAddress}>`,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      text,
      html,
      ...(cc && { cc: Array.isArray(cc) ? cc.join(', ') : cc }),
      ...(bcc && { bcc: Array.isArray(bcc) ? bcc.join(', ') : bcc }),
      ...(attachments && { attachments }),
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ [ambassador-mailer] Email sent successfully:', info.messageId);
    return {
      success: true,
      messageId: info.messageId,
      response: info.response,
    };
  } catch (error) {
    console.error('❌ [ambassador-mailer] Error sending email:', error?.message || error);
    return {
      success: false,
      error: error.message,
    };
  }
};

export default {
  sendAmbassadorMail,
  verifyAmbassadorEmailConfig,
};
