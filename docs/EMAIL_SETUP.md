# Email Service Setup Guide - Zoho with Nodemailer

This guide will help you set up email service using Nodemailer with Zoho SMTP.

## Prerequisites

1. A Zoho Mail account (free or paid)
2. Zoho App Password (not your regular password)

## Step 1: Get Zoho App Password

1. Log in to your Zoho account
2. Go to [Zoho Account Security](https://accounts.zoho.com/home#security/app-passwords)
3. Click on "Generate New Password"
4. Give it a label (e.g., "Kolekto Backend")
5. Copy the generated password (you won't see it again!)

## Step 2: Configure Environment Variables

Add these variables to your `.env` file:

```env
# Zoho Email Configuration
ZOHO_EMAIL=your-email@zoho.com
ZOHO_APP_PASSWORD=your-app-password-here
ZOHO_SMTP_HOST=smtp.zoho.com
ZOHO_SMTP_PORT=587
ZOHO_SMTP_SECURE=false

# Default sender email (optional)
FROM_EMAIL=noreply@kolekto.com.ng
```

## Step 3: Verify Configuration

The email service will automatically verify the configuration on startup. You can also manually verify:

```javascript
import { verifyEmailConfig } from './services/emailService.js';

verifyEmailConfig().then(isReady => {
    if (isReady) {
        console.log('Email service is ready!');
    }
});
```

## Step 4: Use Email Service

### Basic Usage

```javascript
import { sendEmail } from './services/emailService.js';

await sendEmail({
    to: 'user@example.com',
    subject: 'Test Email',
    html: '<h1>Hello World</h1>',
    text: 'Hello World'
});
```

### Using Email Helpers

```javascript
import { sendWelcomeEmail } from './utils/emailHelper.js';

await sendWelcomeEmail('user@example.com', 'John Doe');
```

## Available Email Templates

1. **Welcome Email** - `sendWelcomeEmail()`
2. **Email Verification** - `sendVerificationEmail()`
3. **Password Reset** - `sendPasswordResetEmail()`
4. **Collection Created** - `sendCollectionCreatedEmail()`
5. **Contribution Received** - `sendContributionReceivedEmail()`
6. **Contribution Confirmation** - `sendContributionConfirmationEmail()`
7. **Payment Successful** - `sendPaymentSuccessfulEmail()`
8. **KYC Approved** - `sendKYCApprovedEmail()`
9. **KYC Rejected** - `sendKYCRejectedEmail()`
10. **Withdrawal Request** - `sendWithdrawalRequestEmail()`
11. **Generic Notification** - `sendNotificationEmail()`

## Zoho SMTP Settings

- **Host:** smtp.zoho.com
- **Port:** 587 (TLS) or 465 (SSL)
- **Security:** TLS for port 587, SSL for port 465
- **Authentication:** Required (use App Password)

## Troubleshooting

### Common Issues

1. **"Invalid login" error**
   - Make sure you're using App Password, not your regular password
   - Verify your email address is correct

2. **"Connection timeout"**
   - Check your firewall settings
   - Verify SMTP port (587 or 465)
   - Try using SSL (port 465) instead of TLS

3. **"Email not sending"**
   - Check Zoho account status
   - Verify App Password hasn't expired
   - Check email quota limits

### Testing Email Service

Create a test file `test-email.js`:

```javascript
import { verifyEmailConfig, sendEmail } from './services/emailService.js';

async function testEmail() {
    // Verify configuration
    const isReady = await verifyEmailConfig();
    if (!isReady) {
        console.error('Email service not ready');
        return;
    }

    // Send test email
    const result = await sendEmail({
        to: 'your-email@example.com',
        subject: 'Test Email from Kolekto',
        html: '<h1>Test Email</h1><p>This is a test email from Kolekto backend.</p>',
        text: 'This is a test email from Kolekto backend.'
    });

    console.log('Email result:', result);
}

testEmail();
```

Run: `node test-email.js`

## Production Considerations

1. **Rate Limiting**: Zoho has rate limits. Use `sendBulkEmail()` for multiple emails with delays
2. **Error Handling**: Always handle email errors gracefully
3. **Logging**: Log all email activities for debugging
4. **Security**: Never commit `.env` file with credentials
5. **Monitoring**: Set up alerts for email failures

## Support

For Zoho-specific issues, visit: [Zoho Mail Support](https://help.zoho.com/portal/en/kb/mail)

