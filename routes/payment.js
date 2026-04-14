import express from "express";
import {
    initializePayment,
    verifyPayment,
    listTransactions,
    fetchTransaction,
    handleWebhook,
    sendReceiptNotification,
} from "../controllers/deposit.js";
import { verifyPaystackIP } from "../middleware/verifyPaystickIp.js";

const router = express.Router();

// Initialize a payment
router.post("/initialize-payment", initializePayment);

// Verify a payment (called by frontend after Paystack redirect)
router.get("/verify", verifyPayment);

// List all transactions
router.get("/transactions", listTransactions);

// Fetch a single transaction by ID
router.get("/transaction/:id", fetchTransaction);

// Paystack webhook endpoint (secured by IP allowlist)
router.post("/webhook", verifyPaystackIP, handleWebhook);

// Internal: called by Supabase Edge Function to send receipt emails via Zoho SMTP.
// Secured by x-internal-secret header (set INTERNAL_NOTIFY_SECRET in .env).
router.post("/send-receipt", sendReceiptNotification);

export default router;
