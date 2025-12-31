import { supabase } from '../utils/client.js';
import fetch from "node-fetch";
import { verifyRecaptcha } from '../utils/recaptcha.js';
// Sign In
export const signIn = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required." });
    }

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            console.log(error, "error");
            return res.status(400).json({ message: error.message });
        }

        // Fetch user profile data
        const { data: profile, error: profileError } = await supabase
            .from('profiles') // Replace 'profiles' with your actual profile table name
            .select('*') // Select the fields you want to return
            .eq('id', data.user.id) // Assuming profile id matches user id
            .single();

        if (profileError) {
            console.log('Profile fetch error:', profileError);
            // You might want to continue without profile data or return an error
            // For now, we'll continue without profile data
        }

        // Set HTTP-only cookies for session management
        res.cookie('access_token', data.session.access_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production', // HTTPS only in production
            sameSite: 'none', // Allow cross-site cookies
            maxAge: 60 * 60 * 1000, // 1 hour
            path: '/',
            domain: process.env.NODE_ENV === 'production' ? '.kolekto.com.ng' : undefined // Set domain for production
        });

        res.cookie('refresh_token', data.session.refresh_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'none', // Allow cross-site cookies
            path: '/',
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
            domain: process.env.NODE_ENV === 'production' ? '.kolekto.com.ng' : undefined // Set domain for production
        });

        // Return user data with profile information
        return res.status(200).json({
            data: {
                ...data,
                profile: profile || null // Include profile data if available
            },
            message: "Successfully signed in"
        });
    } catch (err) {
        throw new Error(`Sign in error: ${err.message}`);
        return res.status(500).json({ message: "Internal server error during sign in" });
    }
};

// Sign Up
export const signUp = async (req, res) => {

    const { email, password, firstName, lastName, phoneNumber, recaptcherToken: token, recatcherType: type } = req.body;

    if (!email || !password || !firstName || !lastName || !phoneNumber) {
        return res.status(400).json({ error: "Email, password, first name and last name are required." });
    }

    try {
        if (type === "v3") {
            console.log(process.env.RECAPTCHA_V3_SECRET, token);

            const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_V3_SECRET}&response=${token}`;
            const response = await fetch(verifyUrl, { method: "POST" });
            const data = await response.json();
            console.log(data, "recapcha data");
            if (!data.success || data.score < 0.5) {
                return res.json({ requireV2: true }); // fallback
            }

        }

        if (type === "v2") {
            const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_V2_SECRET}&response=${token}`;
            const response = await fetch(verifyUrl, { method: "POST" });
            const data = await response.json();
            console.log(data, 'v2 data');
            if (!data.success) {
                return res.status(400).json({ message: "Failed v2 verification" });
            }

        }

        if (!type) {
            return res.status(400).json({ message: "Recaptcha type is required." });
        }

        if (type !== "v2" && type !== "v3") {
            return res.status(400).json({ message: "Recaptcha type must be either v2 or v3." });
        }

    } catch (err) {
        throw new Error(`Recaptcha verification failed: ${err.message}`);
        res.status(500).json({ message: "Verification failed" });
    }

    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        phone: phoneNumber,
        options: {
            data: {
                phone: phoneNumber,
                first_name: firstName,
                last_name: lastName,
                full_name: `${firstName} ${lastName}`,

            }
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
        throw new Error(`Sign out error: ${err.message}`);
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
        throw new Error(`Session verification error: ${err.message}`);
        return res.status(500).json({ valid: false, error: err.message });
    }
};

// Get Current User (new endpoint)
export const getCurrentUser = async (req, res) => {
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
            return res.status(401).json({ error: "Not authenticated" });
        }

        // Use Supabase to get the user from the token
        const { data, error } = await supabase.auth.getUser(token);

        if (error || !data?.user) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        // Fetch user profile data
        const { data: profile, error: profileError } = await supabase
            .from('profiles') // Replace 'profiles' with your actual profile table name
            .select('*') // Select the fields you want to return
            .eq('id', data.user.id) // Assuming profile id matches user id
            .single();

        if (profileError) {
            console.log('Profile fetch error:', profileError);
            // Continue without profile data or handle as needed
        }

        return res.status(200).json({
            user: {
                ...data.user, ...profile
            },
            profile: profile || null
        });
    } catch (err) {
        throw new Error(`Get current user error: ${err.message}`);
        return res.status(500).json({ error: "Internal server error" });
    }
};

// Sign In (Token-based for cross-domain)
export const signInWithToken = async (req, res) => {
    const { email, password } = req.body;

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
        throw new Error(`Sign in error: ${err.message}`);
        return res.status(500).json({ error: "Internal server error during sign in" });
    }
};
