import express from "express";
import {
    getAllKycDocuments,
    getUserKycDocuments,
    getKycVerifications,
    getSingleKycVerification,
    approveKyc,
    rejectKyc,
    approveDocument,
    rejectDocument,
    addNote
} from "../../controllers/admin/kyc.js";
import verifyToken from "../../utils/verifyToken.js";
import requireAdmin from "../../utils/requireAdmin.js";

const router = express.Router();

// Every admin/KYC route now requires both authentication AND membership in
// the ADMIN_EMAILS allowlist. Previously these were verifyToken-only, which
// meant any signed-in user could approve their own KYC and proceed to
// withdraw funds (B-4 privilege escalation).
//
// Required env: ADMIN_EMAILS (comma-separated) or ADMIN_EMAIL (singular).
// Missing env → all routes 403 with "Forbidden: admin access required".

// Get all KYC submissions (all users)
router.get("/kyc-documents", verifyToken, requireAdmin, getAllKycDocuments);

// Get all KYC documents/files for a specific user
router.get("/kyc-documents/:userId", verifyToken, requireAdmin, getUserKycDocuments);

// Get all KYC verifications
router.get("/kyc-verifications", verifyToken, requireAdmin, getKycVerifications);

// Get a single KYC verification
router.get("/kyc-verifications/:id", verifyToken, requireAdmin, getSingleKycVerification);

// Approve KYC verification
router.post("/kyc-verifications/:id/approve", verifyToken, requireAdmin, approveKyc);

// Reject KYC verification
router.post("/kyc-verifications/:id/reject", verifyToken, requireAdmin, rejectKyc);

// Approve specific document
router.post("/kyc-documents/:documentId/approve", verifyToken, requireAdmin, approveDocument);

// Reject specific document
router.post("/kyc-documents/:documentId/reject", verifyToken, requireAdmin, rejectDocument);

// Add note to KYC verification
router.post("/kyc-verifications/:id/add-note", verifyToken, requireAdmin, addNote);

export default router;