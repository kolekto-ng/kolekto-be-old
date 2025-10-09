import express from "express";
import verifyToken from "../utils/verifyToken.js";
import { approveKyc } from "../controllers/admin/kyc.js";

const router = express.Router();

// Admin protection can be augmented by checking a role/claim on req.user
router.post("/kyc-verifications/:id/approve", verifyToken, approveKyc);

export default router;
