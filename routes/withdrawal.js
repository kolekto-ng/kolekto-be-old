import express from "express";
import {
    requestWithdrawal,
    handlePaystackWebhook
} from "../controllers/withdrawal.js";
import verifyToken from "../utils/verifyToken.js";

const router = express.Router();

// Request a withdrawal
router.post("/request", verifyToken, requestWithdrawal);

// Paystack webhook for withdrawals
router.post("/webhook", handlePaystackWebhook);

export default router;