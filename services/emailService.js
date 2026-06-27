import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Create reusable transporter object using ZeptoMail SMTP.
// Var names are kept as ZOHO_* (legacy) to avoid touching deployment config —
// they now hold ZeptoMail SMTP host/credentials instead of Zoho's.
const createTransporter = () => {
    return nodemailer.createTransport({
        host: process.env.ZOHO_SMTP_HOST || 'smtp.zeptomail.com',
        port: parseInt(process.env.ZOHO_SMTP_PORT || '587'),
        secure: process.env.ZOHO_SMTP_SECURE === 'true', // true for 465, false for other ports
        auth: {
            user: process.env.ZOHO_EMAIL, // ZeptoMail SMTP username (NOT a mailbox address)
            pass: process.env.ZOHO_APP_PASSWORD, // ZeptoMail SMTP password / token
        },
        tls: {
            rejectUnauthorized: false // For development, set to true in production
        }
    });
};

// Verify transporter configuration
export const verifyEmailConfig = async () => {
    try {
        const transporter = createTransporter();
        await transporter.verify();
        console.log('✅ Email service is ready to send messages');
        return true;
    } catch (error) {
        console.error('❌ Email service configuration error:', error);
        return false;
    }
};

// Send email function
export const sendEmail = async ({ to, subject, html, text, from, attachments, cc, bcc }) => {
    try {
        const transporter = createTransporter();

        const mailOptions = {
            // ZOHO_EMAIL is now a ZeptoMail SMTP username, not a verified sender — never use it as `from`.
            from: from || process.env.FROM_EMAIL || 'no-reply@kolekto.com.ng',
            to: Array.isArray(to) ? to.join(', ') : to,
            subject: subject,
            text: text, // Plain text version
            html: html, // HTML version
            ...(cc && { cc: Array.isArray(cc) ? cc.join(', ') : cc }),
            ...(bcc && { bcc: Array.isArray(bcc) ? bcc.join(', ') : bcc }),
            ...(attachments && { attachments })
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Email sent successfully:', info.messageId);
        return {
            success: true,
            messageId: info.messageId,
            response: info.response
        };
    } catch (error) {
        // SMTP/transport-level failures carry a `code` (e.g. EAUTH, ECONNECTION,
        // ETIMEDOUT) and/or `responseCode` from nodemailer; anything else (bad
        // template data, missing recipient, etc.) is an application-logic error.
        const isSmtpError = Boolean(error.code || error.responseCode || error.command);
        console.error(`❌ ${isSmtpError ? '[EMAIL_SMTP_ERROR]' : '[EMAIL_APP_ERROR]'} Error sending email to ${Array.isArray(to) ? to.join(', ') : to}:`, {
            message: error.message,
            code: error.code,
            command: error.command,
            responseCode: error.responseCode,
            response: error.response,
        });
        return {
            success: false,
            error: error.message,
            isSmtpError
        };
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

