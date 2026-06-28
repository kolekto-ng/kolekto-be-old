// F5 — Admin payments routes (only "reconcile-payment" for now).
//
// Mounted at /api/adminurlabdkole, sharing the prefix with routes/admin/kyc.js.
// All routes require verifyToken + requireAdmin.

import express from "express";
import { reconcilePayment } from "../../controllers/admin/payments.js";
import { getCollectionWalletLive } from "../../controllers/admin/wallet.js";
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

// GET /api/adminurlabdkole/collections/:id/wallet-live
//
// Read-only, live-recomputed wallet snapshot for any collection. Reuses the
// canonical computeWalletBalances() so the admin sees the same settled vs.
// pending split the host dashboard computes per-request, instead of the
// (potentially stale-after-settlement) cached `wallets` columns. Never writes.
router.get(
    "/collections/:id/wallet-live",
    verifyToken,
    requireAdmin,
    getCollectionWalletLive
);

export default router;
