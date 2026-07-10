import { supabase } from '../utils/client.js';
import fetch from "node-fetch";
import { verifyRecaptcha } from '../utils/recaptcha.js';

function cleanString(value) {
    return String(value || '').trim();
}

function normalizeAmbassadorCode(value) {
    return cleanString(value).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
}

async function findAcceptedAmbassadorByCode(code) {
    if (!code) return null;

    const { data, error } = await supabase
        .from('ambassador_profiles')
        .select('id, full_name, ambassador_code, status')
        .eq('ambassador_code', code)
        .maybeSingle();

    if (error) throw error;
    if (!data || data.status !== 'accepted') return null;
    return data;
}

async function attachOrganizerToAmbassador({ ambassador, organizer }) {
    if (!ambassador?.id || !organizer?.id) return;

    const { data: existing, error: lookupError } = await supabase
        .from('ambassador_influenced_organizers')
        .select('id')
        .eq('organizer_id', organizer.id)
        .maybeSingle();

    if (lookupError) throw lookupError;

    if (!existing) {
        const { error: insertError } = await supabase
            .from('ambassador_influenced_organizers')
            .insert([{
                ambassador_id: ambassador.id,
                organizer_id: organizer.id,
                organizer_name: organizer.fullName,
                organizer_email: organizer.email,
                status: 'active',
            }]);

        if (insertError) throw insertError;
    }

    const { error: profileError } = await supabase
        .from('profiles')
        .update({
            referred_by_ambassador_id: ambassador.id,
            ambassador_referral_code: ambassador.ambassador_code,
        })
        .eq('id', organizer.id);

    if (profileError) {
        console.warn('[ambassador referral] profile update failed:', profileError.message);
    }
}
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
        console.error('Sign in error:', err);
        return res.status(500).json({ message: "Internal server error during sign in" });
    }
};

// Sign Up
export const signUp = async (req, res) => {

    const {
        email,
        password,
        firstName,
        lastName,
        phoneNumber,
        recaptcherToken: token,
        recatcherType: type,
        emailRedirectTo,
        ambassadorReferralCode,
        ambassador_referral_code,
    } = req.body;
    const referralCode = normalizeAmbassadorCode(ambassadorReferralCode || ambassador_referral_code);

    if (!email || !password || !firstName || !lastName || !phoneNumber) {
        return res.status(400).json({ error: "Email, password, first name and last name are required." });
    }

    try {
        if (type === "v3") {
            const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_V3_SECRET}&response=${token}`;
            const response = await fetch(verifyUrl, { method: "POST" });
            const data = await response.json();
            if (!data.success || data.score < 0.5) {
                return res.json({ requireV2: true }); // fallback
            }

        }

        if (type === "v2") {
            const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_V2_SECRET}&response=${token}`;
            const response = await fetch(verifyUrl, { method: "POST" });
            const data = await response.json();
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
        console.error(err);
        res.status(500).json({ message: "Verification failed" });
    }

    let referringAmbassador = null;
    try {
        if (referralCode) {
            referringAmbassador = await findAcceptedAmbassadorByCode(referralCode);
            if (!referringAmbassador) {
                return res.status(400).json({ error: "Invalid ambassador referral code." });
            }
        }
    } catch (err) {
        console.error('[ambassador referral] lookup failed:', err);
        return res.status(500).json({ error: "Could not validate ambassador referral code." });
    }

    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        phone: phoneNumber,
        options: {
            emailRedirectTo: emailRedirectTo || process.env.FRONTEND_URL,
            data: {
                phone: phoneNumber,
                first_name: firstName,
                last_name: lastName,
                full_name: `${firstName} ${lastName}`,
                ambassador_referral_code: referringAmbassador?.ambassador_code || null,

            }
        }
    });
    if (error) {
        return res.status(400).json({ error: error.message });
    }

    if (data?.user && referringAmbassador) {
        try {
            await attachOrganizerToAmbassador({
                ambassador: referringAmbassador,
                organizer: {
                    id: data.user.id,
                    fullName: `${firstName} ${lastName}`,
                    email,
                },
            });
        } catch (err) {
            console.error('[ambassador referral] attach failed:', err);
        }
    }

    return res.status(201).json({
        user: data.user,
        session: data.session || null,
        requiresEmailVerification: !data.session,
        message: data.session
            ? "Account created successfully."
            : "Account created. Please verify your email before signing in.",
    });
};

// Sign Out
export const signOut = async (req, res) => {
    try {
        const { error } = await supabase.auth.signOut();

        // Cookies were set in signIn with sameSite/secure/domain/path options.
        // Cookies are only cleared when ALL of those options match — otherwise
        // the browser leaves the original cookie in place. Use the same
        // options here so production cookies actually disappear on logout.
        const cookieOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'none',
            path: '/',
            domain: process.env.NODE_ENV === 'production' ? '.kolekto.com.ng' : undefined,
        };
        res.clearCookie('access_token', cookieOptions);
        res.clearCookie('refresh_token', cookieOptions);

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
        console.error('Get current user error:', err);
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
        console.error('Sign in error:', err);
        return res.status(500).json({ error: "Internal server error during sign in" });
    }
};
