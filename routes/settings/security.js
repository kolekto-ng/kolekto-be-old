import express from "express";
import verifyToken from "../../utils/verifyToken.js";
import {
  requestPasswordChangeOtp,
  verifyOtpAndChangePassword,
} from "../../controllers/settings/security.js";

const router = express.Router();

// POST /api/settings/security/request-password-otp
router.post("/request-password-otp", verifyToken, requestPasswordChangeOtp);

// POST /api/settings/security/verify-password-otp
router.post("/verify-password-otp", verifyToken, verifyOtpAndChangePassword);

export default router;

