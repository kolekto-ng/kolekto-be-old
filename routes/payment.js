import express from "express";
import {
    initializePayment,
    verifyPayment,
    listTransactions,
    fetchTransaction,
    handleWebhook,
    sendReceiptNotification,
} from "../controllers/deposit.js";

const router = express.Router();

// Initialize a payment
router.post("/initialize-payment", initializePayment);

// Verify a payment (called by frontend after Paystack redirect)
router.get("/verify", verifyPayment);

// List all transactions
router.get("/transactions", listTransactions);

// Fetch a single transaction by ID
router.get("/transaction/:id", fetchTransaction);

// Paystack verify payment webhook endpoint
// Signature verification in `handleWebhook` is sufficient and more robust than fixed IP allowlists.
router.post("/webhook", handleWebhook);

export default router;
