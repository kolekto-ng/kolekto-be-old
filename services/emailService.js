import nodemailer from 'nodemailer';
import axios from 'axios';

const ZEPTOMAIL_API_URL = 'https://api.zeptomail.com/v1.1/email';

// Create nodemailer transporter using ZeptoMail SMTP as fallback with 5s timeout.
// Var names are kept as ZOHO_* (legacy) to avoid touching deployment config —
// they now hold ZeptoMail SMTP host/credentials instead of Zoho's.
const createTransporter = () => {
    return nodemailer.createTransport({
        host: process.env.ZOHO_SMTP_HOST || 'smtp.zeptomail.com',
        port: parseInt(process.env.ZOHO_SMTP_PORT || '587'),
        secure: process.env.ZOHO_SMTP_SECURE === 'true',
        auth: {
            user: process.env.ZOHO_EMAIL,
            pass: process.env.ZOHO_APP_PASSWORD,
        },
        connectionTimeout: 5000,
        greetingTimeout: 5000,
    });
};

const toAddressList = (value) => {
    const list = Array.isArray(value) ? value : [value];
    return list.filter(Boolean).map(addr => ({ email_address: { address: addr.trim() } }));
};

// Send via ZeptoMail HTTP API (primary — avoids SMTP port blockers on cloud providers).
const sendViaHttpApi = async ({ to, subject, html, text, from, cc, bcc }) => {
    const apiKey = process.env.ZOHO_APP_PASSWORD;
    if (!apiKey) throw new Error('ZOHO_APP_PASSWORD not configured');

    const payload = {
        from: { address: from || process.env.FROM_EMAIL || 'no-reply@kolekto.com.ng' },
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

// Send via ZeptoMail SMTP (fallback — with 5s timeout so cloud failures fail fast).
const sendViaSmtp = async ({ to, subject, html, text, from, attachments, cc, bcc }) => {
    const transporter = createTransporter();
    const mailOptions = {
        from: from || process.env.FROM_EMAIL || 'no-reply@kolekto.com.ng',
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

// Verify email configuration — checks ZeptoMail API key is present.
export const verifyEmailConfig = async () => {
    try {
        const apiKey = process.env.ZOHO_APP_PASSWORD;
        if (!apiKey) throw new Error('ZOHO_APP_PASSWORD not configured');
        console.log('✅ ZeptoMail HTTP API key configured');
        return true;
    } catch (error) {
        console.error('❌ Email service configuration error:', error);
        return false;
    }
};

// Send email — tries ZeptoMail HTTP API first; falls back to SMTP with 5s timeout.
export const sendEmail = async ({ to, subject, html, text, from, attachments, cc, bcc }) => {
    try {
        if (attachments) {
            const result = await sendViaSmtp({ to, subject, html, text, from, attachments, cc, bcc });
            return result;
        }

        const result = await sendViaHttpApi({ to, subject, html, text, from, cc, bcc });
        return result;
    } catch (httpError) {
        console.warn('⚠️ ZeptoMail HTTP API failed, falling back to SMTP:', httpError?.message || httpError);
        try {
            const result = await sendViaSmtp({ to, subject, html, text, from, cc, bcc });
            return result;
        } catch (smtpError) {
            const isSmtpError = Boolean(smtpError.code || smtpError.responseCode || smtpError.command);
            console.error(`❌ ${isSmtpError ? '[EMAIL_SMTP_ERROR]' : '[EMAIL_APP_ERROR]'} Error sending email to ${Array.isArray(to) ? to.join(', ') : to}:`, {
                message: smtpError.message,
                code: smtpError.code,
                command: smtpError.command,
                responseCode: smtpError.responseCode,
                response: smtpError.response,
            });
            return { success: false, error: smtpError.message, isSmtpError };
        }
    }
};

// Send bulk emails
export const sendBulkEmail = async (emailList) => {
    const results = [];

    for (const emailData of emailList) {
        const result = await sendEmail(emailData);
        results.push(result);
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
};

export default {
    sendEmail,
    sendBulkEmail,
    verifyEmailConfig
};

