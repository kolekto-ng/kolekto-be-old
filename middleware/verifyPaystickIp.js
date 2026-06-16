// Paystack's published webhook source IPs
const PAYSTACK_IPS = ['52.31.139.75', '52.49.173.169', '52.214.14.220'];

// Allowed in non-production environments only
const LOCAL_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/**
 * Verify that a webhook request originates from Paystack's known IP range.
 *
 * IMPORTANT — this is a defence-in-depth layer only.
 * The primary security control is HMAC signature verification in handleWebhook()
 * (controllers/deposit.js). Even if this IP check is somehow bypassed, a forged
 * request will be rejected by the signature check.
 *
 * We use req.ip (set by Express when app.set('trust proxy', true)) rather than
 * reading x-forwarded-for directly, because a raw header read allows attackers
 * to spoof the IP by injecting their own x-forwarded-for value before reaching
 * the server.  With 'trust proxy' enabled Express correctly resolves the
 * rightmost trusted hop.
 */
export function verifyPaystackIP(req, res, next) {
    // req.ip is normalised by Express based on the 'trust proxy' setting.
    // It strips IPv6-mapped IPv4 prefixes (e.g. "::ffff:52.31.139.75" → "52.31.139.75").
    const clientIP = (req.ip || '').replace(/^::ffff:/, '');

    const isProduction = process.env.NODE_ENV === 'production';
    const allowed = PAYSTACK_IPS.includes(clientIP) ||
        (!isProduction && LOCAL_IPS.includes(clientIP));

    if (!allowed) {
        console.warn(`[verifyPaystackIP] Blocked webhook from IP: ${clientIP}`);
        return res.status(403).json({ error: 'Forbidden' });
    }

    next();
}
