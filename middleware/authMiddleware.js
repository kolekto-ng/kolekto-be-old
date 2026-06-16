// ⚠️ DEPRECATED — DO NOT IMPORT
// Uses CommonJS `module.exports` in an ESM project, and references an
// undefined `supabase`. The real auth middleware is `utils/verifyToken.js`
// (used everywhere in routes/*). Delete in a follow-up cleanup PR.

const authMiddleware = async (req, res, next) => {
    const token = req.headers['authorization'];

    if (!token) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    req.user = data.user;
    next();
};

module.exports = authMiddleware;