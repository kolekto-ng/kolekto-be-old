import { supabase } from '../services/supabaseClient';

export const signUp = async (req, res) => {
    const { email, password, fullName, phoneNumber } = req.body;
    if (!email || !password || !fullName) {
        return res.status(400).json({ error: 'Email, password, and full name are required' });
    }
    // Validate phone number if provided
    if (phoneNumber && !/^\+?[1-9]\d{1,14}$/.test(phoneNumber)) {
        return res.status(400).json({ error: 'Invalid phone number format' });
    }
    // Check if user already exists
    const { data: existingUser, error: existingUserError } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .single();
    if (existingUserError && existingUserError.code !== 'PGRST116') {
        return res.status(500).json({ error: existingUserError.message });
    }
    if (existingUser) {
        return res.status(400).json({ error: 'User already exists with this email' });
    }
    // Create new user
    // Note: Ensure you have a 'users' table in your Supabase database
    const { data: userData, error: userError } = await supabase
        .from('users')
        .insert([{ email, full_name: fullName, phone_number: phoneNumber }])
        .single();
    if (userError) {
        return res.status(500).json({ error: userError.message });
    }
    // Sign up with Supabase Auth
    if (!userData) {
        return res.status(500).json({ error: 'Failed to create user in database' });
    }
    // Use the email and password to sign up
    // Note: Ensure you have the 'auth.users' table in your Supabase database
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: {
                full_name: fullName,
                phone_number: phoneNumber
            }
        }
    });

    if (error) {
        return res.status(400).json({ error: error.message });
    }
    // Return the user data
    const user = {
        id: userData.id,
        email: userData.email,
        full_name: userData.full_name,
        phone_number: userData.phone_number,
        created_at: userData.created_at
    };
    // Optionally, you can return the session data if needed
    // if (data.session) {
    //     user.session = data.session;
    // }
    // Return the user data in the response
    return res.status(201).json({ user });
}

export const signIn = (req, res) => {
    const { email, password } = req.body;
    const { user, error } = supabase.auth.signIn({ email, password });

    if (error) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ user });
}

export const getUser = (req, res) => {
    const { user } = supabase.auth.getUser();

    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    return res.status(200).json({ user });
}

export const forgotPassword = (req, res) => {
    const { email } = req.body;
    const { data, error } = supabase.auth.resetPasswordForEmail(email, {
        redirectTo: process.env.PASSWORD_RESET_REDIRECT_URL, // Set in your .env
    });

    if (error) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ message: "Password reset email sent" });
}

export const signOut = (req, res) => {
    const { error } = supabase.auth.signOut();
    if (error) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ message: "Signed out successfully" });
}

// For Google OAuth (to add later)
export const signInWithProvider = (req, res) => {
    const { provider } = req.body; // e.g., 'google'
    const { data, error } = supabase.auth.signInWithOAuth({ provider });
    if (error) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ url: data.url }); // Redirect user to URL on frontend
}