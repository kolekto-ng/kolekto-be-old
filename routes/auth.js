import express from "express";
import {
    signIn,
    signUp,
    signOut,
    sendMagicLink,
    sendPasswordReset,
    resetPassword,
    verifySession
} from "../controllers/auth.js";
import verifyToken from "../utils/verifyToken.js";

const router = express.Router();

// Auth routes
router.post("/signup", signUp);
router.post("/signin", signIn);
router.post("/signout", verifyToken, signOut); // Only signed-in users can sign out

// Magic link login
router.post("/magic-link", sendMagicLink);

// Password reset
router.post("/forgot-password", sendPasswordReset); // Send password reset email
router.post("/reset-password", resetPassword);      // Reset password with access_token

// Session verification
router.post("/verify-session", verifySession);

export default router;