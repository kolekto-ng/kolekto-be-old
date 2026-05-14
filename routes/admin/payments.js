// F5 — Admin payments routes (only "reconcile-payment" for now).
//
// Mounted at /api/adminurlabdkole, sharing the prefix with routes/admin/kyc.js.
// All routes require verifyToken + requireAdmin.

import express from "express";
import { reconcilePayment } from "../../controllers/admin/payments.js";
import verifyToken from "../../utils/verifyToken.js";
import requireAdmin from "../../utils/requireAdmin.js";

const router = express.Router();

// POST /api/adminurlabdkole/reconcile-payment
// Body: { reference: string }
//
// Manually trigger the verify edge function for a Paystack reference. Used
// when a payment was charged on Paystack but never recorded on Kolekto
// because the FE callback failed (closed tab, killed mobile browser, etc.).
//
// The endpoint is safe to call repeatedly for the same reference — the
// underlying edge function is idempotent.
router.post(
    "/reconcile-payment",
    verifyToken,
    requireAdmin,
    reconcilePayment
);

export default router;
