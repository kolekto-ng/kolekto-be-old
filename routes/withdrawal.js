import express from "express";
import {
    requestWithdrawal,
    handlePaystackWebhook,
    getCollectionWalletWithdrawals,
    getUserWithdrawals
} from "../controllers/withdrawal.js";
import verifyToken from "../utils/verifyToken.js";

const router = express.Router();

// Request a withdrawal
router.post("/request", verifyToken, requestWithdrawal);
router.get("/", verifyToken, getUserWithdrawals); // Assuming this is for testing or listing withdrawals
// Paystack webhook for withdrawals
router.post("/webhook", handlePaystackWebhook);

export default router;