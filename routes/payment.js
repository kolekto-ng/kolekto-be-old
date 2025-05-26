import express from "express";
import {
    initializePayment,
    verifyPayment,
    listTransactions,
    fetchTransaction,
    handleWebhook
} from "../controllers/payment.js";

const router = express.Router();

// Initialize a payment
router.post("/initialize-payment", initializePayment);

// Verify a payment
router.get("/verify", verifyPayment);

// List all transactions
router.get("/transactions", listTransactions);

// Fetch a single transaction by ID
router.get("/transaction/:id", fetchTransaction);

// Paystack webhook endpoint
router.post("/webhook", handleWebhook);

export default router;