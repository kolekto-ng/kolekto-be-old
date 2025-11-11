// Example: How to integrate email service into your controllers

import { sendWelcomeEmail, sendVerificationEmail, sendPasswordResetEmail } from '../utils/emailHelper.js';
import { sendCollectionCreatedEmail, sendContributionReceivedEmail } from '../utils/emailHelper.js';
import { sendKYCApprovedEmail, sendKYCRejectedEmail } from '../utils/emailHelper.js';

// ============================================
// Example 1: Send welcome email on signup
// ============================================
export const signUpWithEmail = async (req, res) => {
    const { email, password, firstName, lastName } = req.body;

    // ... your existing signup logic ...

    // After successful signup, send welcome email
    try {
        await sendWelcomeEmail(
            email,
            `${firstName} ${lastName}`
        );
        console.log('Welcome email sent successfully');
    } catch (error) {
        console.error('Failed to send welcome email:', error);
        // Don't fail the signup if email fails
    }

    // ... rest of your signup logic ...
};

// ============================================
// Example 2: Send email verification
// ============================================
export const sendEmailVerification = async (userEmail, userName, userId) => {
    const verificationLink = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

    try {
        await sendVerificationEmail(
            userEmail,
            userName,
            verificationLink
        );
        console.log('Verification email sent');
    } catch (error) {
        console.error('Failed to send verification email:', error);
    }
};

// ============================================
// Example 3: Send password reset email
// ============================================
export const sendPasswordReset = async (req, res) => {
    const { email } = req.body;

    // Generate reset token
    const resetToken = generateResetToken();
    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    // Send email
    try {
        await sendPasswordResetEmail(
            email,
            'User', // or fetch from database
            resetLink
        );
        return res.status(200).json({ message: 'Password reset email sent' });
    } catch (error) {
        console.error('Failed to send password reset email:', error);
        return res.status(500).json({ error: 'Failed to send email' });
    }
};

// ============================================
// Example 4: Send collection created email
// ============================================
export const createCollectionWithEmail = async (req, res) => {
    const user_id = req.user.id;
    const { title } = req.body;

    // ... your existing collection creation logic ...

    // After collection is created
    const collectionLink = `${process.env.FRONTEND_URL}/collection/${collection.slug || collection.id}`;

    try {
        // Get user email and name
        const { data: profile } = await supabase
            .from('profiles')
            .select('email, full_name')
            .eq('id', user_id)
            .single();

        if (profile) {
            await sendCollectionCreatedEmail(
                profile.email,
                profile.full_name,
                title,
                collectionLink
            );
        }
    } catch (error) {
        console.error('Failed to send collection created email:', error);
    }

    // ... rest of your logic ...
};

// ============================================
// Example 5: Send contribution received email
// ============================================
export const handleContributionWithEmail = async (req, res) => {
    const { collectionId, contributorName, amount } = req.body;

    // ... your existing contribution logic ...

    // After contribution is created
    try {
        // Get collection organizer details
        const { data: collection } = await supabase
            .from('collections')
            .select('user_id, title')
            .eq('id', collectionId)
            .single();

        const { data: organizer } = await supabase
            .from('profiles')
            .select('email, full_name')
            .eq('id', collection.user_id)
            .single();

        if (organizer) {
            await sendContributionReceivedEmail(
                organizer.email,
                organizer.full_name,
                contributorName,
                amount,
                collection.title
            );
        }
    } catch (error) {
        console.error('Failed to send contribution email:', error);
    }

    // ... rest of your logic ...
};

// ============================================
// Example 6: Send KYC approval/rejection email
// ============================================
export const approveKYCWithEmail = async (req, res) => {
    const { id } = req.params;

    // ... your existing KYC approval logic ...

    // After KYC is approved
    try {
        const { data: kyc } = await supabase
            .from('kyc_verifications')
            .select('user_id')
            .eq('id', id)
            .single();

        const { data: profile } = await supabase
            .from('profiles')
            .select('email, full_name')
            .eq('id', kyc.user_id)
            .single();

        if (profile) {
            await sendKYCApprovedEmail(
                profile.email,
                profile.full_name
            );
        }
    } catch (error) {
        console.error('Failed to send KYC approval email:', error);
    }

    // ... rest of your logic ...
};

export const rejectKYCWithEmail = async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    // ... your existing KYC rejection logic ...

    // After KYC is rejected
    try {
        const { data: kyc } = await supabase
            .from('kyc_verifications')
            .select('user_id')
            .eq('id', id)
            .single();

        const { data: profile } = await supabase
            .from('profiles')
            .select('email, full_name')
            .eq('id', kyc.user_id)
            .single();

        if (profile) {
            await sendKYCRejectedEmail(
                profile.email,
                profile.full_name,
                reason
            );
        }
    } catch (error) {
        console.error('Failed to send KYC rejection email:', error);
    }

    // ... rest of your logic ...
};

// ============================================
// Example 7: Initialize email service on app startup
// ============================================
// Add this to your app.js or server startup file:

import { verifyEmailConfig } from './services/emailService.js';

// On app startup
const initializeEmailService = async () => {
    const isReady = await verifyEmailConfig();
    if (isReady) {
        console.log('✅ Email service initialized successfully');
    } else {
        console.warn('⚠️ Email service not configured properly');
    }
};

// Call it when your app starts
// initializeEmailService();

