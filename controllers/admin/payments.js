// F5 — Admin "Reconcile Payment" endpoint.
//
// Purpose: when a contributor pays on Paystack but the contribution never
// landed in our database (closed tab on callback, mobile browser killed,
// network glitch, etc.), an admin can paste the Paystack reference here
// and trigger the same verification logic the FE's PaymentCallback would
// have run.
//
// Implementation: thin wrapper around the existing `invokeVerifyEdgeFunction`
// helper (controllers/deposit.js). The edge function is idempotent — calling
// it twice for the same reference is safe, the second call just returns the
// same receipt without inserting duplicates.
//
// Auth: verifyToken + requireAdmin (enforced at the route layer).

import { invokeVerifyEdgeFunction } from "../deposit.js";

export const reconcilePayment = async (req, res) => {
    const adminEmail = req.user?.email || "(unknown)";
    const reference = String(req.body?.reference || "").trim();

    if (!reference) {
        return res.status(400).json({
            error: "Paystack reference is required.",
            code: "MISSING_REFERENCE",
        });
    }

    // Conservative format guard — Paystack references for our integration are
    // shaped like "kolekto-<ms>-<rand>" (see initiate-paystack-payment edge
    // function, ~line 591). We don't enforce the exact shape because manual
    // references from other gateways could exist in older data, but we do
    // reject anything obviously not a payment reference.
    if (reference.length < 6 || reference.length > 128 || /[\r\n\s]/.test(reference)) {
        return res.status(400).json({
            error: "Reference looks malformed.",
            code: "INVALID_REFERENCE",
        });
    }

    console.log(
        `[reconcile ref=${reference}] RECONCILE_REQUESTED by admin=${adminEmail}`
    );

    const result = await invokeVerifyEdgeFunction(reference);

    if (result.ok) {
        console.log(
            `[reconcile ref=${reference}] RECONCILE_SUCCESS status=${result.status} admin=${adminEmail}`
        );
        return res.status(200).json({
            ok: true,
            message:
                "Reconciliation succeeded. The contribution(s) are now recorded.",
            reference,
            edgeStatus: result.status,
            // Pass through the receipt data so the admin UI can show what
            // got processed — useful for confirming the right payment was
            // recovered.
            receiptData: result.body?.receiptData || null,
            contributions: result.body?.contributions || [],
        });
    }

    // Edge function rejected the reconcile. Surface the underlying error so
    // the admin can see exactly why (collection not found / amount mismatch /
    // Paystack says the txn was not successful / etc.).
    console.error(
        `[reconcile ref=${reference}] RECONCILE_FAILED status=${result.status} admin=${adminEmail}`,
        {
            error: result.body?.error,
            code: result.body?.code,
        }
    );
    return res.status(result.status >= 400 ? result.status : 502).json({
        ok: false,
        error:
            result.body?.error ||
            "Edge function verification failed. Inspect server logs for details.",
        code: result.body?.code || "EDGE_FUNCTION_FAILED",
        edgeStatus: result.status,
        reference,
    });
};
