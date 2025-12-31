const PAYSTACK_IPS = ['52.31.139.75', '52.49.173.169', '52.214.14.220'];
const LOCAL_IPS = ['127.0.0.1', '::1']; // IPv4 and IPv6 localhost

export function verifyPaystackIP(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const clientIP = ip.split(',')[0].trim();

    // Allow if in Paystack's list or local testing
    if (PAYSTACK_IPS.includes(clientIP) || LOCAL_IPS.includes(clientIP)) {
        return next();
    } else {
        throw new Error(`Blocked request from IP: ${clientIP}`);
    }
}
