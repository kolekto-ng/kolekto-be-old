import { supabase } from './client.js';

export default async function verifyToken(req, res, next) {
    // Try to get token from cookies first (for session-based auth)
    let token = req.cookies?.access_token;



    // Fallback to Authorization header (for API clients)
    if (!token) {
        const authHeader = req.headers.authorization;
        if (authHeader) {
            token = authHeader.split(" ")[1];
        }
    }

    if (!token) {
        return res.status(401).json({ error: "No token provided" });
    }

    try {
        // Use Supabase to verify the token
        const { data, error } = await supabase.auth.getUser(token);

        if (error || !data?.user) {
            // If access token is invalid, try to refresh it
            const refreshToken = req.cookies?.refresh_token;
            if (refreshToken) {
                const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession({
                    refresh_token: refreshToken
                });

                if (!refreshError && refreshData?.session) {
                    // Set new cookies
                    res.cookie('access_token', refreshData.session.access_token, {
                        httpOnly: true,
                        secure: process.env.NODE_ENV === 'production',
                        sameSite: 'none',
                        maxAge: 60 * 60 * 1000,
                        domain: process.env.NODE_ENV === 'production' ? '.kolekto.com.ng' : undefined
                    });

                    req.user = refreshData.user;
                    return next();
                }
            }

            return res.status(401).json({ error: "Invalid or expired token" });
        }

        req.user = data.user; // Attach user info to request
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid token" });
    }
}