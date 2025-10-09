import express from "express";
import {
    getAllKycDocuments,
    getUserKycDocuments,
    getKycVerifications,
    getSingleKycVerification
} from "../../controllers/admin/kyc.js";
import verifyToken from "../../utils/verifyToken.js";

const router = express.Router();

// Get all KYC submissions (all users)
router.get("/kyc-documents", verifyToken, getAllKycDocuments);

// Get all KYC documents/files for a specific user
router.get("/kyc-documents/:userId", verifyToken, getUserKycDocuments);

// Get all KYC verifications
router.get("/kyc-verifications", verifyToken, getKycVerifications);

// Get a single KYC verification
router.get("/kyc-verifications/:id", verifyToken, getSingleKycVerification);

export default router;