// Test the dedicated Marketing Mail Agent (isolated ZeptoMail SMTP config)
// used by the Email Campaign / Communications system.
// Run with: node scripts/test-marketing-email.js
// Requires TEST_EMAIL and the MARKETING_SMTP_* vars set in .env.

import dotenv from 'dotenv';
import { verifyMarketingEmailConfig, sendMarketingMail } from '../utils/marketingMailer.js';

dotenv.config();

const REQUIRED_VARS = ['MARKETING_SMTP_HOST', 'MARKETING_SMTP_USER', 'MARKETING_SMTP_PASS'];

async function testMarketingMailAgent() {
  console.log('🧪 Testing Marketing Mail Agent (isolated ZeptoMail config)...\n');

  // Step 0: confirm the dedicated env vars are actually set — this is a
  // separate mail agent, so missing vars here must not silently fall back
  // to the transactional or Ambassador SMTP credentials.
  console.log('0. Checking MARKETING_SMTP_* environment variables...');
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
    console.error('   Set them in .env — see .env.example for the full list.');
    process.exit(1);
  }
  console.log('✅ Marketing SMTP env vars present.\n');

  // Step 1: SMTP authentication check (also implicitly validates host/port).
  console.log('1. Verifying Marketing Mail Agent SMTP connectivity + authentication...');
  const isReady = await verifyMarketingEmailConfig();
  if (!isReady) {
    console.error('❌ Marketing Mail Agent configuration failed!');
    console.error('   This usually means the SMTP host/port/credentials are wrong, or the');
    console.error('   ZeptoMail Mail Agent has not finished provisioning yet.');
    process.exit(1);
  }
  console.log('✅ SMTP authentication succeeded.\n');

  // Step 2: send a real test email — this is the only reliable way to catch
  // sender-authorization and relay-permission problems, which transporter.verify()
  // does not always surface (auth can succeed while sending is still rejected).
  console.log('2. Sending a live test email through the Marketing Mail Agent...');
  const testEmail = process.env.TEST_EMAIL;
  if (!testEmail) {
    console.warn('⚠️  Set TEST_EMAIL in .env to actually send a test message.');
    console.warn('   Example: TEST_EMAIL=you@example.com');
    console.log('\n🎉 SMTP auth check passed, but delivery was not tested (no TEST_EMAIL set).');
    return;
  }

  const result = await sendMarketingMail({
    to: testEmail,
    subject: 'Kolekto Marketing Mail Agent — Test Email',
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;">
        <h2 style="color:#1B5E20;">Marketing Mail Agent Test</h2>
        <p>This email was sent using the <strong>dedicated Email Campaign ZeptoMail Mail Agent</strong>,
        completely isolated from both the main Kolekto transactional email system and the
        Ambassador Program mail agent.</p>
        <p>If you received this, the following are all confirmed working:</p>
        <ul>
          <li>SMTP authentication</li>
          <li>Sender address authorization</li>
          <li>ZeptoMail relay permissions</li>
          <li>End-to-end delivery</li>
        </ul>
      </div>
    `,
    text:
      'This email was sent using the dedicated Email Campaign ZeptoMail Mail Agent, ' +
      'isolated from the transactional and Ambassador mailers. If you received this, ' +
      'SMTP auth, sender authorization, relay permissions, and delivery are all confirmed working.',
  });

  if (!result.success) {
    console.error('❌ Failed to send test email:', result.error);
    console.error('\nPossible causes:');
    console.error('   - MARKETING_SMTP_FROM is not an authorized/verified sender on this Mail Agent');
    console.error('   - The ZeptoMail Mail Agent does not have relay permission for this recipient domain');
    console.error('   - MARKETING_SMTP_USER / MARKETING_SMTP_PASS are incorrect for this Mail Agent');
    process.exit(1);
  }

  console.log('✅ Test email sent successfully!');
  console.log(`   Message ID: ${result.messageId}`);
  console.log(`📧 Check your inbox at: ${testEmail}\n`);
  console.log('🎉 Marketing Mail Agent is fully operational: auth, sender authorization,');
  console.log('   relay permissions, and delivery all confirmed.');
}

testMarketingMailAgent().catch((error) => {
  console.error('❌ Marketing Mail Agent test failed unexpectedly:', error?.message || error);
  process.exit(1);
});
