import express from "express";
import {
    initializePayment,
    verifyPayment,
    listTransactions,
    fetchTransaction,
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

// NOTE: POST /webhook is intentionally NOT registered here.
//
// The webhook needs the RAW request body (Buffer) for Paystack HMAC
// signature verification. The global express.json() parser would consume
// the body before this router runs, so we mount the webhook route directly
// in app.js BEFORE express.json() with express.raw(). See B-1 in app.js.

export default router;
