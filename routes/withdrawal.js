import express from "express";
import {
    requestWithdrawal,
    handlePaystackWebhook,
    getCollectionWalletWithdrawals,
    getUserWithdrawals,
    approveWithdrawal,
    rejectWithdrawal
} from "../controllers/withdrawal.js";
import verifyToken from "../utils/verifyToken.js";
import requireAdmin from "../utils/requireAdmin.js";
import { getBanksData } from "../utils/banksData.js";

const router = express.Router();

// Request a withdrawal (any authenticated organizer — ownership checked in controller)
router.post("/request", verifyToken, requestWithdrawal);

// Approve / reject — admin only
router.post("/approve", verifyToken, requireAdmin, approveWithdrawal);
router.post("/reject", verifyToken, requireAdmin, rejectWithdrawal);
router.get("/banks-data", getBanksData);
router.get("/", verifyToken, getUserWithdrawals); // Assuming this is for testing or listing withdrawals
// Paystack webhook for withdrawals
// router.post("/webhook", handlePaystackWebhook);

export default router;