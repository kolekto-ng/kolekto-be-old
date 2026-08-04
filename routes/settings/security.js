import express from "express";
import verifyToken from "../../utils/verifyToken.js";
import {
  requestPasswordChangeOtp,
  verifyOtpAndChangePassword,
  requestEmailChangeOtp,
  verifyEmailChangeOtp,
  confirmEmailChange,
} from "../../controllers/settings/security.js";

const router = express.Router();

// POST /api/settings/security/request-password-otp
router.post("/request-password-otp", verifyToken, requestPasswordChangeOtp);

// POST /api/settings/security/verify-password-otp
router.post("/verify-password-otp", verifyToken, verifyOtpAndChangePassword);

// POST /api/settings/security/request-email-change-otp
router.post("/request-email-change-otp", verifyToken, requestEmailChangeOtp);

// POST /api/settings/security/verify-email-change-otp
router.post("/verify-email-change-otp", verifyToken, verifyEmailChangeOtp);

// POST /api/settings/security/confirm-email-change
// No verifyToken: the confirmation token itself is the credential, since the
// user may click the link from a different device/session.
router.post("/confirm-email-change", confirmEmailChange);

export default router;

