import jwt from "jsonwebtoken";

export default function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "No token provided" });

    const token = authHeader.split(" ")[1];
    // console.log(authHeader, token);

    try {
        const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
        req.user = decoded; // Attach user info to request
        // console.log("Decoded user:", req.user);

        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid token" });
    }
}