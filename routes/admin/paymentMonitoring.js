import express from "express";
import {
    getPaymentMonitoring,
    getPaymentMonitoringDetail,
    retryPayment,
    manualReconcilePayment,
    retryAllFailed,
    resolvePayment,
    addPaymentNote,
} from "../../controllers/admin/paymentMonitoring.js";
import verifyToken from "../../utils/verifyToken.js";
import requireAdmin from "../../utils/requireAdmin.js";

// Mounted at /api/adminurlabdkole, sharing the prefix with routes/admin/payments.js
// and routes/admin/kyc.js. All routes require verifyToken + requireAdmin.
const router = express.Router();

router.get("/payment-monitoring", verifyToken, requireAdmin, getPaymentMonitoring);
router.get("/payment-monitoring/:reference", verifyToken, requireAdmin, getPaymentMonitoringDetail);
router.post("/payment-monitoring/:reference/retry", verifyToken, requireAdmin, retryPayment);
router.post("/payment-monitoring/:reference/manual-reconcile", verifyToken, requireAdmin, manualReconcilePayment);
router.post("/payment-monitoring/retry-all-failed", verifyToken, requireAdmin, retryAllFailed);
router.post("/payment-monitoring/:reference/resolve", verifyToken, requireAdmin, resolvePayment);
router.post("/payment-monitoring/:reference/notes", verifyToken, requireAdmin, addPaymentNote);

export default router;
