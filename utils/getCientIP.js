export function getClientIp(req) {
    // If Cloudfare is Used 
    if (req.headers["cf-connecting-ip"]) return req.headers["cf-connecting-ip"]

    // Return the list of ips either Capital or Small 
    const xff = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'];
    if (xff) return xff.split(',')[0].trim();

    let ip = req.ip || (req.socket && req.remoteClient) || null;
    if (!ip) return null;

    if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
    if (ip === '::1') ip = '127.0.0.1';
    return ip;

}