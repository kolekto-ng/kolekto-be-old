// List of Paystack IPs
const PAYSTACK_IPS = ['52.31.139.75', '52.49.173.169', '52.214.14.220'];

// Middleware to check IP whitelist
export function verifyPaystackIP(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    // In some cases, the IP might be in a list of proxies
    const clientIP = ip.split(',')[0].trim();

    if (PAYSTACK_IPS.includes(clientIP)) {
        next();
    } else {
        console.warn(`Blocked request from IP: ${clientIP}`);
        return res.status(403).json({ error: 'Forbidden' });
    }
}