import { supabase } from './client.js';

/**
 * Middleware that restricts a route to admin users only.
 *
 * Admin emails are read from the ADMIN_EMAILS environment variable as a
 * comma-separated list.  Falls back to ADMIN_EMAIL (singular) for backwards
 * compatibility.
 *
 * Must be used AFTER verifyToken (so req.user is already populated).
 *
 * Usage:
 *   router.post('/approve', verifyToken, requireAdmin, approveWithdrawal);
 */
export default function requireAdmin(req, res, next) {
    const adminEmailsRaw =
        process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '';

    const adminEmails = adminEmailsRaw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);

    const callerEmail = (req.user?.email || '').toLowerCase();

    if (!callerEmail || !adminEmails.includes(callerEmail)) {
        return res.status(403).json({ error: 'Forbidden: admin access required' });
    }

    next();
}
