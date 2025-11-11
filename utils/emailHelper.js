import { sendEmail } from '../services/emailService.js';
import {
    welcomeEmailTemplate,
    emailVerificationTemplate,
    passwordResetTemplate,
    collectionCreatedTemplate,
    contributionReceivedTemplate,
    contributionConfirmationTemplate,
    paymentSuccessfulTemplate,
    kycApprovedTemplate,
    kycRejectedTemplate,
    withdrawalRequestTemplate,
    notificationTemplate
} from '../templates/emailTemplates.js';

// Send welcome email
export const sendWelcomeEmail = async (userEmail, userName) => {
    const html = welcomeEmailTemplate(userName);
    const text = `Welcome to Kolekto, ${userName}! Thank you for joining us.`;

    return await sendEmail({
        to: userEmail,
        subject: 'Welcome to Kolekto! 🎉',
        html,
        text
    });
};

// Send email verification
export const sendVerificationEmail = async (userEmail, userName, verificationLink) => {
    const html = emailVerificationTemplate(userName, verificationLink);
    const text = `Please verify your email by clicking this link: ${verificationLink}`;

    return await sendEmail({
        to: userEmail,
        subject: 'Verify Your Email Address - Kolekto',
        html,
        text
    });
};

// Send password reset email
export const sendPasswordResetEmail = async (userEmail, userName, resetLink) => {
    const html = passwordResetTemplate(userName, resetLink);
    const text = `Reset your password by clicking this link: ${resetLink}`;

    return await sendEmail({
        to: userEmail,
        subject: 'Reset Your Password - Kolekto',
        html,
        text
    });
};

// Send collection created email
export const sendCollectionCreatedEmail = async (userEmail, userName, collectionTitle, collectionLink) => {
    const html = collectionCreatedTemplate(userName, collectionTitle, collectionLink);
    const text = `Your collection "${collectionTitle}" has been created successfully! View it here: ${collectionLink}`;

    return await sendEmail({
        to: userEmail,
        subject: `Collection Created: ${collectionTitle}`,
        html,
        text
    });
};

// Send contribution received email to organizer
export const sendContributionReceivedEmail = async (organizerEmail, organizerName, contributorName, amount, collectionTitle) => {
    const html = contributionReceivedTemplate(organizerName, contributorName, amount, collectionTitle);
    const text = `You've received a new contribution of ${amount} from ${contributorName} for "${collectionTitle}"`;

    return await sendEmail({
        to: organizerEmail,
        subject: `New Contribution Received - ${collectionTitle}`,
        html,
        text
    });
};

// Send contribution confirmation email to contributor
export const sendContributionConfirmationEmail = async (contributorEmail, contributorName, amount, collectionTitle, paymentLink = null) => {
    const html = contributionConfirmationTemplate(contributorName, amount, collectionTitle, paymentLink);
    const text = `Thank you for contributing ${amount} to "${collectionTitle}"`;

    return await sendEmail({
        to: contributorEmail,
        subject: `Contribution Confirmed - ${collectionTitle}`,
        html,
        text
    });
};

// Send payment successful email
export const sendPaymentSuccessfulEmail = async (userEmail, userName, amount, collectionTitle, transactionId) => {
    const html = paymentSuccessfulTemplate(userName, amount, collectionTitle, transactionId);
    const text = `Your payment of ${amount} for "${collectionTitle}" has been processed successfully. Transaction ID: ${transactionId}`;

    return await sendEmail({
        to: userEmail,
        subject: 'Payment Successful - Kolekto',
        html,
        text
    });
};

// Send KYC approved email
export const sendKYCApprovedEmail = async (userEmail, userName) => {
    const html = kycApprovedTemplate(userName);
    const text = `Your KYC verification has been approved! You can now access all platform features.`;

    return await sendEmail({
        to: userEmail,
        subject: 'KYC Verification Approved - Kolekto',
        html,
        text
    });
};

// Send KYC rejected email
export const sendKYCRejectedEmail = async (userEmail, userName, reason) => {
    const html = kycRejectedTemplate(userName, reason);
    const text = `Your KYC verification has been rejected. Reason: ${reason || 'Please contact support for details'}`;

    return await sendEmail({
        to: userEmail,
        subject: 'KYC Verification Update - Kolekto',
        html,
        text
    });
};

// Send withdrawal request email
export const sendWithdrawalRequestEmail = async (userEmail, userName, amount, status) => {
    const html = withdrawalRequestTemplate(userName, amount, status);
    const text = `Your withdrawal request of ${amount} has been ${status === 'approved' ? 'approved' : 'received'}`;

    return await sendEmail({
        to: userEmail,
        subject: `Withdrawal Request ${status === 'approved' ? 'Approved' : 'Received'} - Kolekto`,
        html,
        text
    });
};

// Send generic notification
export const sendNotificationEmail = async (userEmail, userName, title, message, actionLink = null, actionText = null) => {
    const html = notificationTemplate(userName, title, message, actionLink, actionText);
    const text = `${title}\n\n${message}${actionLink ? `\n\n${actionLink}` : ''}`;

    return await sendEmail({
        to: userEmail,
        subject: title,
        html,
        text
    });
};

export default {
    sendWelcomeEmail,
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendCollectionCreatedEmail,
    sendContributionReceivedEmail,
    sendContributionConfirmationEmail,
    sendPaymentSuccessfulEmail,
    sendKYCApprovedEmail,
    sendKYCRejectedEmail,
    sendWithdrawalRequestEmail,
    sendNotificationEmail
};

