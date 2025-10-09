import express from "express";
import {
    getAllKycDocuments,
    getUserKycDocuments,
    getKycVerifications,
    getSingleKycVerification
} from "../../controllers/admin/kyc.js";

const router = express.Router();

// Get all KYC submissions (all users)
router.get("/kyc-documents", getAllKycDocuments);

// Get all KYC documents/files for a specific user
router.get("/kyc-documents/:userId", getUserKycDocuments);

// Get all KYC verifications
router.get("/kyc-verifications", getKycVerifications);

// Get a single KYC verification
router.get("/kyc-verifications/:id", getSingleKycVerification);

export default router;