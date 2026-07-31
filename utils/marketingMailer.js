import nodemailer from 'nodemailer';
import axios from 'axios';

const ZEPTOMAIL_API_URL = 'https://api.zeptomail.com/v1.1/email';

const createMarketingTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.MARKETING_SMTP_HOST,
    port: parseInt(process.env.MARKETING_SMTP_PORT || '587'),
    secure: process.env.MARKETING_SMTP_PORT === '465',
    auth: {
      user: process.env.MARKETING_SMTP_USER,
      pass: process.env.MARKETING_SMTP_PASS,
    },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
  });
};

const toAddressList = (value) => {
  const list = Array.isArray(value) ? value : [value];
  return list.filter(Boolean).map(addr => ({ email_address: { address: addr.trim() } }));
};

const sendMarketingViaHttpApi = async ({ to, subject, html, text, cc, bcc }) => {
  const apiKey = process.env.MARKETING_SMTP_PASS;
  if (!apiKey) throw new Error('MARKETING_SMTP_PASS not configured');

  const fromAddress = process.env.MARKETING_SMTP_FROM || '';
  const fromName = process.env.MARKETING_SMTP_FROM_NAME || 'Kolekto';

  const payload = {
    from: { address: fromAddress, name: fromName },
    to: toAddressList(to),
    subject,
    htmlbody: html,
    textbody: text || '',
  };

  if (cc) payload.cc = toAddressList(cc);
  if (bcc) payload.bcc = toAddressList(bcc);

  const response = await axios.post(ZEPTOMAIL_API_URL, payload, {
    headers: {
      'Authorization': `Zoho-enczapikey ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  return { success: true, messageId: response.data?.messageId, response: response.data };
};

const sendMarketingViaSmtp = async ({ to, subject, html, text, attachments, cc, bcc }) => {
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
  return { success: true, messageId: info.messageId, response: info.response };
};

export const verifyMarketingEmailConfig = async () => {
  try {
    const apiKey = process.env.MARKETING_SMTP_PASS;
    if (!apiKey) throw new Error('MARKETING_SMTP_PASS not configured');
    console.log('✅ [marketing-mailer] HTTP API key configured');
    return true;
  } catch (error) {
    console.error('❌ [marketing-mailer] configuration error:', error?.message || error);
    return false;
  }
};

export const sendMarketingMail = async ({ to, subject, html, text, attachments, cc, bcc }) => {
  try {
    if (attachments) {
      const result = await sendMarketingViaSmtp({ to, subject, html, text, attachments, cc, bcc });
      return result;
    }

    const result = await sendMarketingViaHttpApi({ to, subject, html, text, cc, bcc });
    return result;
  } catch (httpError) {
    console.warn('⚠️ [marketing-mailer] HTTP API failed, falling back to SMTP:', httpError?.message || httpError);
    try {
      const result = await sendMarketingViaSmtp({ to, subject, html, text, cc, bcc });
      return result;
    } catch (smtpError) {
      console.error('❌ [marketing-mailer] Error sending email:', smtpError?.message || smtpError);
      return { success: false, error: smtpError.message };
    }
  }
};

export default {
  sendMarketingMail,
  verifyMarketingEmailConfig,
};
