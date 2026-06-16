import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Create reusable transporter object using Zoho SMTP
const createTransporter = () => {
    return nodemailer.createTransport({
        host: process.env.ZOHO_SMTP_HOST || 'smtp.zoho.com',
        port: parseInt(process.env.ZOHO_SMTP_PORT || '587'),
        secure: process.env.ZOHO_SMTP_SECURE === 'true', // true for 465, false for other ports
        auth: {
            user: process.env.ZOHO_EMAIL, // Your Zoho email address
            pass: process.env.ZOHO_APP_PASSWORD, // Zoho App Password (not your regular password)
        },
        tls: {
            rejectUnauthorized: false // For development, set to true in production
        }
    });
};

// const createTransporter = () => {
//     return nodemailer.createTransport({
//         host: 'smtp.zoho.com',
//         port: 587,
//         secure: false, // MUST be false for 587
//         auth: {
//             user: process.env.ZOHO_EMAIL,
//             pass: process.env.ZOHO_APP_PASSWORD,
//         },
//         tls: {
//             rejectUnauthorized: false
//         }
//     });
// };
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
            from: from || process.env.ZOHO_EMAIL || process.env.FROM_EMAIL || 'noreply@kolekto.com.ng',
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
        console.error('❌ Error sending email:', error);
        return {
            success: false,
            error: error.message
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

