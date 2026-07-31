import nodemailer from 'nodemailer';
import axios from 'axios';

const ZEPTOMAIL_API_URL = 'https://api.zeptomail.com/v1.1/email';

const createAmbassadorTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.AMBASSADOR_SMTP_HOST,
    port: parseInt(process.env.AMBASSADOR_SMTP_PORT || '587'),
    secure: process.env.AMBASSADOR_SMTP_PORT === '465',
    auth: {
      user: process.env.AMBASSADOR_SMTP_USER,
      pass: process.env.AMBASSADOR_SMTP_PASS,
    },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
  });
};

const toAddressList = (value) => {
  const list = Array.isArray(value) ? value : [value];
  return list.filter(Boolean).map(addr => ({ email_address: { address: addr.trim() } }));
};

const sendAmbassadorViaHttpApi = async ({ to, subject, html, text, cc, bcc }) => {
  const apiKey = process.env.AMBASSADOR_SMTP_PASS;
  if (!apiKey) throw new Error('AMBASSADOR_SMTP_PASS not configured');

  const fromAddress = process.env.AMBASSADOR_SMTP_FROM || '';
  const fromName = process.env.AMBASSADOR_SMTP_FROM_NAME || 'Kolekto Ambassador Program';

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

const sendAmbassadorViaSmtp = async ({ to, subject, html, text, attachments, cc, bcc }) => {
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
  return { success: true, messageId: info.messageId, response: info.response };
};

export const verifyAmbassadorEmailConfig = async () => {
  try {
    const apiKey = process.env.AMBASSADOR_SMTP_PASS;
    if (!apiKey) throw new Error('AMBASSADOR_SMTP_PASS not configured');
    console.log('✅ [ambassador-mailer] HTTP API key configured');
    return true;
  } catch (error) {
    console.error('❌ [ambassador-mailer] configuration error:', error?.message || error);
    return false;
  }
};

export const sendAmbassadorMail = async ({ to, subject, html, text, attachments, cc, bcc }) => {
  try {
    if (attachments) {
      const result = await sendAmbassadorViaSmtp({ to, subject, html, text, attachments, cc, bcc });
      return result;
    }

    const result = await sendAmbassadorViaHttpApi({ to, subject, html, text, cc, bcc });
    return result;
  } catch (httpError) {
    console.warn('⚠️ [ambassador-mailer] HTTP API failed, falling back to SMTP:', httpError?.message || httpError);
    try {
      const result = await sendAmbassadorViaSmtp({ to, subject, html, text, cc, bcc });
      return result;
    } catch (smtpError) {
      console.error('❌ [ambassador-mailer] Error sending email:', smtpError?.message || smtpError);
      return { success: false, error: smtpError.message };
    }
  }
};

export default {
  sendAmbassadorMail,
  verifyAmbassadorEmailConfig,
};
