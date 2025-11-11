// Test Email Service
// Run with: node test-email.js

import dotenv from 'dotenv';
import { verifyEmailConfig, sendEmail } from './services/emailService.js';
import { sendWelcomeEmail } from './utils/emailHelper.js';

dotenv.config();

async function testEmailService() {
    console.log('🧪 Testing Email Service...\n');

    // Step 1: Verify configuration
    console.log('1. Verifying email configuration...');
    const isReady = await verifyEmailConfig();
    
    if (!isReady) {
        console.error('❌ Email service configuration failed!');
        console.error('Please check your .env file and ensure:');
        console.error('- ZOHO_EMAIL is set');
        console.error('- ZOHO_APP_PASSWORD is set');
        console.error('- ZOHO_SMTP_HOST is set (default: smtp.zoho.com)');
        console.error('- ZOHO_SMTP_PORT is set (default: 587)');
        process.exit(1);
    }

    console.log('✅ Email configuration verified!\n');

    // Step 2: Test basic email
    console.log('2. Testing basic email send...');
    const testEmail = process.env.TEST_EMAIL || 'your-email@example.com';
    
    if (testEmail === 'your-email@example.com') {
        console.warn('⚠️  Please set TEST_EMAIL in .env file to test email sending');
        console.warn('   Example: TEST_EMAIL=your-email@example.com');
        return;
    }

    const basicEmailResult = await sendEmail({
        to: testEmail,
        subject: 'Test Email from Kolekto Backend',
        html: `
            <h1>Test Email</h1>
            <p>This is a test email from Kolekto backend.</p>
            <p>If you received this, your email service is working correctly! ✅</p>
        `,
        text: 'This is a test email from Kolekto backend. If you received this, your email service is working correctly!'
    });

    if (basicEmailResult.success) {
        console.log('✅ Basic email sent successfully!');
        console.log(`   Message ID: ${basicEmailResult.messageId}\n`);
    } else {
        console.error('❌ Failed to send basic email:', basicEmailResult.error);
        return;
    }

    // Step 3: Test template email
    console.log('3. Testing welcome email template...');
    const templateEmailResult = await sendWelcomeEmail(
        testEmail,
        'Test User'
    );

    if (templateEmailResult.success) {
        console.log('✅ Welcome email template sent successfully!');
        console.log(`   Message ID: ${templateEmailResult.messageId}\n`);
    } else {
        console.error('❌ Failed to send welcome email:', templateEmailResult.error);
    }

    console.log('🎉 Email service test completed!');
    console.log(`📧 Check your inbox at: ${testEmail}`);
}

// Run the test
testEmailService().catch(error => {
    console.error('❌ Test failed:', error);
    process.exit(1);
});

