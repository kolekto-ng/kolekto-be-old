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
import { getBanksData } from "../utils/banksData.js";

const router = express.Router();

// Request a withdrawal
router.post("/request", verifyToken, requestWithdrawal);
router.post("/approve", verifyToken, approveWithdrawal);
router.post("/reject", verifyToken, rejectWithdrawal);
router.get("/banks-data", getBanksData);
router.get("/", verifyToken, getUserWithdrawals); // Assuming this is for testing or listing withdrawals
// Paystack webhook for withdrawals
router.post("/webhook", handlePaystackWebhook);

export default router;