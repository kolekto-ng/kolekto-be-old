import { supabase } from '../utils/client.js';

// Sign In
export const signIn = async (req, res) => {
    const { email, password } = req.body;
    console.log(email, password, "email and password");

    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required." });
    }

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        console.log(data, "data");

        if (error) {
            console.log(error, "error");
            return res.status(400).json({ error: error.message });
        }

        // Set HTTP-only cookies for session management
        res.cookie('access_token', data.session.access_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production', // HTTPS only in production
            sameSite: 'none', // Allow cross-site cookies
            maxAge: 60 * 60 * 1000, // 1 hour
            domain: process.env.NODE_ENV === 'production' ? '.kolekto.com.ng' : undefined // Set domain for production
        });

        res.cookie('refresh_token', data.session.refresh_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'none', // Allow cross-site cookies
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
            domain: process.env.NODE_ENV === 'production' ? '.kolekto.com.ng' : undefined // Set domain for production
        });

        // Return user data without tokens (tokens are in cookies)
        return res.status(200).json({
            user: data.user,
            message: "Successfully signed in"
        });
    } catch (err) {
        console.error('Sign in error:', err);
        return res.status(500).json({ error: "Internal server error during sign in" });
    }
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
    try {
        const { error } = await supabase.auth.signOut();

        // Clear cookies
        res.clearCookie('access_token');
        res.clearCookie('refresh_token');

        if (error) {
            return res.status(400).json({ error: error.message });
        }

        return res.status(200).json({ message: "Signed out successfully." });
    } catch (err) {
        console.error('Sign out error:', err);
        return res.status(500).json({ error: "Internal server error during sign out" });
    }
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
    try {
        // Get token from cookies or headers
        let token = req.cookies?.access_token;

        if (!token) {
            const authHeader = req.headers.authorization;
            if (authHeader) {
                token = authHeader.split(" ")[1];
            }
        }

        if (!token) {
            return res.status(401).json({ valid: false, error: "No token provided." });
        }

        // Use Supabase to get the user from the token
        const { data, error } = await supabase.auth.getUser(token);

        if (error || !data?.user) {
            return res.status(401).json({ valid: false, error: "Invalid or expired token." });
        }

        return res.status(200).json({ valid: true, user: data.user });
    } catch (err) {
        console.error('Session verification error:', err);
        return res.status(500).json({ valid: false, error: err.message });
    }
};

// Get Current User (new endpoint)
export const getCurrentUser = async (req, res) => {
    try {
        // Get token from cookies or headers
        let token = req.cookies?.access_token;
        console.log(token, "token");

        if (!token) {
            const authHeader = req.headers.authorization;
            if (authHeader) {
                token = authHeader.split(" ")[1];
            }
        }

        if (!token) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        // Use Supabase to get the user from the token
        const { data, error } = await supabase.auth.getUser(token);

        if (error || !data?.user) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        return res.status(200).json({ user: data.user });
    } catch (err) {
        console.error('Get current user error:', err);
        return res.status(500).json({ error: "Internal server error" });
    }
};

// Sign In (Token-based for cross-domain)
export const signInWithToken = async (req, res) => {
    const { email, password } = req.body;
    console.log(email, password, "email and password");

    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required." });
    }

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            return res.status(400).json({ error: error.message });
        }

        // Return tokens in response body for frontend storage
        return res.status(200).json({
            user: data.user,
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            expires_at: data.session.expires_at,
            message: "Successfully signed in"
        });
    } catch (err) {
        console.error('Sign in error:', err);
        return res.status(500).json({ error: "Internal server error during sign in" });
    }
};