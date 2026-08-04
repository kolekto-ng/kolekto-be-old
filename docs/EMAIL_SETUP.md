# Email Service Setup Guide - ZeptoMail with Nodemailer

This guide will help you set up email service using Nodemailer with ZeptoMail SMTP.

> Migration note: env var names were kept as `ZOHO_*` to avoid touching deploy
> config, but they now hold ZeptoMail credentials, not Zoho's.

## Prerequisites

1. A ZeptoMail account with a verified sending domain (e.g. `kolekto.com.ng`)
2. A ZeptoMail Mail Agent with SMTP sending enabled

## Step 1: Get ZeptoMail SMTP Credentials

1. Log in to the [ZeptoMail dashboard](https://www.zoho.com/zeptomail/)
2. Open your Mail Agent > **SMTP & API Settings**
3. Under SMTP, copy the **SMTP username** and generate/copy the **SMTP password**
4. Confirm your sending domain (e.g. `kolekto.com.ng`) is verified (SPF/DKIM passing)

## Step 2: Configure Environment Variables

Add these variables to your `.env` file:

```env
# ZeptoMail SMTP Configuration (var names kept as ZOHO_* for compatibility)
ZOHO_EMAIL=your-zeptomail-smtp-username
ZOHO_APP_PASSWORD=your-zeptomail-smtp-password
ZOHO_SMTP_HOST=smtp.zeptomail.com
ZOHO_SMTP_PORT=587
ZOHO_SMTP_SECURE=false

# Verified ZeptoMail sender identity used as the `from` address
FROM_EMAIL=no-reply@kolekto.com.ng
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

## What is NOT on this path

Signup/sign-in OTP and email-confirmation emails are sent by **Supabase Auth's
own mailer** (`supabase.auth.signUp()` in `controllers/auth.js`), configured
separately in the Supabase Dashboard under Authentication > SMTP Settings.
They do not go through this service — update that dashboard SMTP config
separately if you want signup emails on ZeptoMail too.

## ZeptoMail SMTP Settings

- **Host:** smtp.zeptomail.com
- **Port:** 587 (recommended) or 465 (SSL)
- **Security:** STARTTLS for port 587 (`secure: false`), SSL for port 465 (`secure: true`)
- **Authentication:** Required (SMTP username + password from the dashboard, not your Zoho account login)

## Troubleshooting

### Common Issues

1. **"Invalid login" / EAUTH error**
   - Make sure you're using the ZeptoMail SMTP username/password, not API token or account login
   - Regenerate the SMTP password from the dashboard if unsure

2. **"Connection timeout"**
   - Check your firewall/egress rules allow outbound 587
   - Verify `ZOHO_SMTP_HOST` is exactly `smtp.zeptomail.com`

3. **Emails rejected / bounced**
   - Confirm the `from` address (`FROM_EMAIL`) belongs to a verified ZeptoMail sending domain
   - Check SPF/DKIM status for the domain in the ZeptoMail dashboard

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

1. **Rate Limiting**: Respect ZeptoMail's sending limits for your plan. Use `sendBulkEmail()` for multiple emails with delays
2. **Error Handling**: `sendEmail()` tags failures as `[EMAIL_SMTP_ERROR]` (transport-level) or `[EMAIL_APP_ERROR]` (logic-level) in logs — use this to triage
3. **Logging**: Log all email activities for debugging
4. **Security**: Never commit `.env` file with credentials
5. **Monitoring**: Set up alerts for `[EMAIL_SMTP_ERROR]` log lines

## Support

For ZeptoMail-specific issues, visit: [ZeptoMail Documentation](https://www.zoho.com/zeptomail/help/)
