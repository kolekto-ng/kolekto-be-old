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
                    // B-11: rotate BOTH cookies on a successful refresh.
                    //
                    // Supabase may rotate the refresh token (refresh-token
                    // rotation is enabled by default in newer projects).
                    // Previously we only wrote a new access_token cookie and
                    // left the stale refresh_token cookie in place. On the
                    // next access-token expiry the client would present the
                    // OLD refresh token, Supabase would reject it, and the
                    // user would be silently logged out mid-session.
                    //
                    // Cookie options match exactly what controllers/auth.js
                    // (signIn) sets, so the browser overwrites rather than
                    // accumulates two cookies of the same name.
                    const isProd = process.env.NODE_ENV === 'production';
                    const baseCookieOptions = {
                        httpOnly: true,
                        secure: isProd,
                        sameSite: 'none',
                        path: '/',
                        domain: isProd ? '.kolekto.com.ng' : undefined,
                    };
                    res.cookie('access_token', refreshData.session.access_token, {
                        ...baseCookieOptions,
                        maxAge: 60 * 60 * 1000, // 1 hour — matches signIn
                    });
                    // Supabase always returns a refresh_token in the new
                    // session payload (either rotated or the same one). Always
                    // re-set it so the cookie maxAge resets to 7 days.
                    if (refreshData.session.refresh_token) {
                        res.cookie('refresh_token', refreshData.session.refresh_token, {
                            ...baseCookieOptions,
                            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days — matches signIn
                        });
                    }

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