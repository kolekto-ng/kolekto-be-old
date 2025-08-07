import { supabase } from '../utils/client.js';

// Sign In
export const signIn = async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required." });
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ user: data.user, session: data.session });
};

// Sign Up
export const signUp = async (req, res) => {
    const { email, password, fullName } = req.body;
    if (!email || !password || !fullName) {
        return res.status(400).json({ error: "Email, password, and full name are required." });
    }
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: { full_name: fullName }
        }
    });
    if (error) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(201).json({ user: data.user });
};

// Sign Out
export const signOut = async (req, res) => {
    const { error } = await supabase.auth.signOut();
    if (error) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ message: "Signed out successfully." });
};

// Send Magic Link
export const sendMagicLink = async (req, res) => {
    const { email, emailRedirectTo } = req.body;
    if (!email) {
        return res.status(400).json({ error: "Email is required to send a magic link." });
    }
    const { data, error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo }
    });
    if (error) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ message: "Magic link sent." });
};

// Send Password Reset Email
export const sendPasswordReset = async (req, res) => {
    const { email, emailRedirectTo } = req.body;
    if (!email) {
        return res.status(400).json({ error: "Email is required." });
    }
    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: emailRedirectTo
    });
    if (error) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ message: "Password reset email sent." });
};

// Reset Password (after clicking email link)
export const resetPassword = async (req, res) => {
    const { access_token, newPassword } = req.body;
    if (!access_token || !newPassword) {
        return res.status(400).json({ error: "Access token and new password are required." });
    }
    // Create a new Supabase client with the user's access token
    const { createClient } = await import('@supabase/supabase-js');
    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { global: { headers: { Authorization: `Bearer ${access_token}` } } }
    );
    const { data, error } = await supabaseClient.auth.updateUser({
        password: newPassword
    });
    if (error) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ message: "Password has been reset." });
};

// Verify Session
export const verifySession = async (req, res) => {
    const { token } = req.body;
    if (!token) {
        return res.status(400).json({ valid: false, error: "Token is required." });
    }
    try {
        // Use Supabase to get the user from the token
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data?.user) {
            return res.status(401).json({ valid: false, error: "Invalid or expired token." });
        }
        return res.status(200).json({ valid: true, user: data.user });
    } catch (err) {
        return res.status(500).json({ valid: false, error: err.message });
    }
};