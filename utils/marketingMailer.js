import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Dedicated SMTP transport for the Email Campaign / Communications system,
// backed by its own ZeptoMail Mail Agent ("Kolekto Marketing"). This is
// intentionally isolated from both services/emailService.js (main
// transactional mailer) and utils/ambassadorMailer.js (Ambassador Program
// mailer) — separate credentials, separate transporter, separate failure
// domain. Bulk campaign sends must never affect transactional deliverability
// (password resets, receipts) or Ambassador lifecycle emails, and vice versa.
const createMarketingTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.MARKETING_SMTP_HOST,
    port: parseInt(process.env.MARKETING_SMTP_PORT || '587'),
    secure: process.env.MARKETING_SMTP_PORT === '465',
    auth: {
      user: process.env.MARKETING_SMTP_USER,
      pass: process.env.MARKETING_SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    },
  });
};

/**
 * Health check for the Marketing Mail Agent's SMTP connectivity/auth.
 * Mirrors verifyAmbassadorEmailConfig() in utils/ambassadorMailer.js.
 */
export const verifyMarketingEmailConfig = async () => {
  try {
    const transporter = createMarketingTransporter();
    await transporter.verify();
    console.log('✅ [marketing-mailer] SMTP connection verified — ready to send');
    return true;
  } catch (error) {
    console.error('❌ [marketing-mailer] SMTP configuration error:', error?.message || error);
    return false;
  }
};

/**
 * Sends a single email via the dedicated Marketing Mail Agent. Same
 * never-throw contract as the other mailers — always resolves to
 * { success, messageId?, response?, error? } — so the queue worker and
 * retry wrapper can call it repeatedly without new error-handling scaffolding.
 */
export const sendMarketingMail = async ({ to, subject, html, text, attachments, cc, bcc }) => {
  try {
    const transporter = createMarketingTransporter();

    const fromAddress = process.env.MARKETING_SMTP_FROM || process.env.MARKETING_SMTP_USER;
    const fromName = process.env.MARKETING_SMTP_FROM_NAME || 'Kolekto';

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
    console.log('✅ [marketing-mailer] Email sent successfully:', info.messageId);
    return {
      success: true,
      messageId: info.messageId,
      response: info.response,
    };
  } catch (error) {
    console.error('❌ [marketing-mailer] Error sending email:', error?.message || error);
    return {
      success: false,
      error: error.message,
    };
  }
};

export default {
  sendMarketingMail,
  verifyMarketingEmailConfig,
};
