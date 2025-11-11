// Email Templates for Kolekto

// Base template wrapper
const baseTemplate = (content, title = 'Kolekto') => {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f4f4f4;
        }
        .container {
            background-color: #ffffff;
            border-radius: 8px;
            padding: 30px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #4CAF50;
        }
        .logo {
            font-size: 28px;
            font-weight: bold;
            color: #4CAF50;
            margin-bottom: 10px;
        }
        .content {
            margin-bottom: 30px;
        }
        .button {
            display: inline-block;
            padding: 12px 30px;
            background-color: #4CAF50;
            color: #ffffff;
            text-decoration: none;
            border-radius: 5px;
            margin: 20px 0;
            font-weight: bold;
        }
        .button:hover {
            background-color: #45a049;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            text-align: center;
            font-size: 12px;
            color: #666;
        }
        .highlight {
            background-color: #f0f8ff;
            padding: 15px;
            border-left: 4px solid #4CAF50;
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">Kolekto</div>
            <p style="color: #666; margin: 0;">Crowdfunding Made Easy</p>
        </div>
        <div class="content">
            ${content}
        </div>
        <div class="footer">
            <p>© ${new Date().getFullYear()} Kolekto. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
        </div>
    </div>
</body>
</html>
    `;
};

// Welcome Email Template
export const welcomeEmailTemplate = (userName) => {
    const content = `
        <h2>Welcome to Kolekto! 🎉</h2>
        <p>Hi ${userName},</p>
        <p>Thank you for joining Kolekto! We're excited to have you on board.</p>
        <p>You can now start creating collections, contributing to campaigns, and managing your fundraising activities.</p>
        <div class="highlight">
            <strong>Get Started:</strong>
            <ul>
                <li>Create your first collection</li>
                <li>Share it with your network</li>
                <li>Start receiving contributions</li>
            </ul>
        </div>
        <p>If you have any questions, feel free to reach out to our support team.</p>
        <p>Best regards,<br>The Kolekto Team</p>
    `;
    return baseTemplate(content, 'Welcome to Kolekto');
};

// Email Verification Template
export const emailVerificationTemplate = (userName, verificationLink) => {
    const content = `
        <h2>Verify Your Email Address</h2>
        <p>Hi ${userName},</p>
        <p>Thank you for signing up! Please verify your email address to complete your registration.</p>
        <div style="text-align: center;">
            <a href="${verificationLink}" class="button">Verify Email Address</a>
        </div>
        <p>Or copy and paste this link into your browser:</p>
        <p style="word-break: break-all; color: #4CAF50;">${verificationLink}</p>
        <p><strong>This link will expire in 24 hours.</strong></p>
        <p>If you didn't create an account, please ignore this email.</p>
    `;
    return baseTemplate(content, 'Verify Your Email');
};

// Password Reset Template
export const passwordResetTemplate = (userName, resetLink) => {
    const content = `
        <h2>Reset Your Password</h2>
        <p>Hi ${userName},</p>
        <p>We received a request to reset your password. Click the button below to create a new password:</p>
        <div style="text-align: center;">
            <a href="${resetLink}" class="button">Reset Password</a>
        </div>
        <p>Or copy and paste this link into your browser:</p>
        <p style="word-break: break-all; color: #4CAF50;">${resetLink}</p>
        <p><strong>This link will expire in 1 hour.</strong></p>
        <p>If you didn't request a password reset, please ignore this email or contact support if you have concerns.</p>
    `;
    return baseTemplate(content, 'Reset Your Password');
};

// Collection Created Template
export const collectionCreatedTemplate = (userName, collectionTitle, collectionLink) => {
    const content = `
        <h2>Collection Created Successfully! 🎊</h2>
        <p>Hi ${userName},</p>
        <p>Your collection "<strong>${collectionTitle}</strong>" has been created successfully!</p>
        <div class="highlight">
            <p><strong>Next Steps:</strong></p>
            <ul>
                <li>Share your collection link with potential contributors</li>
                <li>Monitor contributions in your dashboard</li>
                <li>Withdraw funds when ready</li>
            </ul>
        </div>
        <div style="text-align: center;">
            <a href="${collectionLink}" class="button">View Collection</a>
        </div>
        <p>Good luck with your fundraising!</p>
        <p>Best regards,<br>The Kolekto Team</p>
    `;
    return baseTemplate(content, 'Collection Created');
};

// Contribution Received Template
export const contributionReceivedTemplate = (organizerName, contributorName, amount, collectionTitle) => {
    const content = `
        <h2>New Contribution Received! 💰</h2>
        <p>Hi ${organizerName},</p>
        <p>Great news! You've received a new contribution to your collection "<strong>${collectionTitle}</strong>".</p>
        <div class="highlight">
            <p><strong>Contribution Details:</strong></p>
            <ul>
                <li><strong>Contributor:</strong> ${contributorName}</li>
                <li><strong>Amount:</strong> ${amount}</li>
                <li><strong>Collection:</strong> ${collectionTitle}</li>
            </ul>
        </div>
        <p>You can view all contributions in your dashboard.</p>
        <p>Thank you for using Kolekto!</p>
    `;
    return baseTemplate(content, 'New Contribution Received');
};

// Contribution Confirmation Template
export const contributionConfirmationTemplate = (contributorName, amount, collectionTitle, paymentLink) => {
    const content = `
        <h2>Contribution Confirmed! ✅</h2>
        <p>Hi ${contributorName},</p>
        <p>Thank you for your contribution to "<strong>${collectionTitle}</strong>"!</p>
        <div class="highlight">
            <p><strong>Contribution Details:</strong></p>
            <ul>
                <li><strong>Amount:</strong> ${amount}</li>
                <li><strong>Collection:</strong> ${collectionTitle}</li>
                <li><strong>Status:</strong> Pending Payment</li>
            </ul>
        </div>
        ${paymentLink ? `
            <div style="text-align: center;">
                <a href="${paymentLink}" class="button">Complete Payment</a>
            </div>
        ` : ''}
        <p>Your contribution will be processed once payment is confirmed.</p>
        <p>Best regards,<br>The Kolekto Team</p>
    `;
    return baseTemplate(content, 'Contribution Confirmed');
};

// Payment Successful Template
export const paymentSuccessfulTemplate = (userName, amount, collectionTitle, transactionId) => {
    const content = `
        <h2>Payment Successful! ✅</h2>
        <p>Hi ${userName},</p>
        <p>Your payment has been processed successfully!</p>
        <div class="highlight">
            <p><strong>Transaction Details:</strong></p>
            <ul>
                <li><strong>Amount:</strong> ${amount}</li>
                <li><strong>Collection:</strong> ${collectionTitle}</li>
                <li><strong>Transaction ID:</strong> ${transactionId}</li>
                <li><strong>Status:</strong> Completed</li>
            </ul>
        </div>
        <p>Thank you for your contribution!</p>
        <p>Best regards,<br>The Kolekto Team</p>
    `;
    return baseTemplate(content, 'Payment Successful');
};

// KYC Verification Approved Template
export const kycApprovedTemplate = (userName) => {
    const content = `
        <h2>KYC Verification Approved! ✅</h2>
        <p>Hi ${userName},</p>
        <p>Great news! Your KYC verification has been approved.</p>
        <div class="highlight">
            <p>You can now:</p>
            <ul>
                <li>Withdraw funds from your collections</li>
                <li>Access all platform features</li>
                <li>Create unlimited collections</li>
            </ul>
        </div>
        <p>Thank you for completing the verification process.</p>
        <p>Best regards,<br>The Kolekto Team</p>
    `;
    return baseTemplate(content, 'KYC Verification Approved');
};

// KYC Verification Rejected Template
export const kycRejectedTemplate = (userName, reason) => {
    const content = `
        <h2>KYC Verification Update</h2>
        <p>Hi ${userName},</p>
        <p>We've reviewed your KYC verification documents.</p>
        <div class="highlight" style="border-left-color: #f44336;">
            <p><strong>Status:</strong> Rejected</p>
            ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
        </div>
        <p>Please review the feedback and resubmit your documents. If you have any questions, please contact our support team.</p>
        <p>Best regards,<br>The Kolekto Team</p>
    `;
    return baseTemplate(content, 'KYC Verification Update');
};

// Withdrawal Request Template
export const withdrawalRequestTemplate = (userName, amount, status) => {
    const content = `
        <h2>Withdrawal Request ${status === 'approved' ? 'Approved' : 'Received'}</h2>
        <p>Hi ${userName},</p>
        <p>Your withdrawal request has been ${status === 'approved' ? 'approved and processed' : 'received'}.</p>
        <div class="highlight">
            <p><strong>Withdrawal Details:</strong></p>
            <ul>
                <li><strong>Amount:</strong> ${amount}</li>
                <li><strong>Status:</strong> ${status === 'approved' ? 'Approved' : 'Pending'}</li>
            </ul>
        </div>
        ${status === 'approved' ?
            '<p>Funds will be transferred to your account within 1-3 business days.</p>' :
            '<p>We\'re processing your request. You\'ll receive another email once it\'s approved.</p>'
        }
        <p>Best regards,<br>The Kolekto Team</p>
    `;
    return baseTemplate(content, 'Withdrawal Request');
};

// Generic Notification Template
export const notificationTemplate = (userName, title, message, actionLink = null, actionText = null) => {
    const content = `
        <h2>${title}</h2>
        <p>Hi ${userName},</p>
        <p>${message}</p>
        ${actionLink && actionText ? `
            <div style="text-align: center;">
                <a href="${actionLink}" class="button">${actionText}</a>
            </div>
        ` : ''}
        <p>Best regards,<br>The Kolekto Team</p>
    `;
    return baseTemplate(content, title);
};

export default {
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
};

