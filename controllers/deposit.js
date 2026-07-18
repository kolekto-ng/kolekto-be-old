import axios from "axios";
import { supabase } from "../utils/client.js";
import { createContribution } from "./contribution.js";
import crypto from "node:crypto";
import { sendEmail } from "../services/emailService.js";
import { sendPaymentInitialize, sendPaymentConfirmation } from "../utils/emailHelper.js";
import {
    notifyContributionByReference,
    notifyPaymentIssue,
} from "../utils/pushNotifications.js";
import {
    calculateFees,
    computeWalletBalances,
    roundCurrency,
    normalizeContributions,
    deriveNetContribution,
} from "../utils/financial.js";
import { resolveContributionUniqueCode, shouldGenerateUniqueCode } from "../utils/contributionCodeService.js";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY?.replace(/['"\r\n\s]/g, "");
const PAYSTACK_BASE_URL = "https://api.paystack.co";

/**
 * F1: Invoke the Supabase edge function `verify-paystack-payment`.
 *
 * This is the same function the frontend's PaymentCallback calls. We call
 * it from the webhook as a safety net for payments where the FE never got
 * a chance to call it (browser closed, mobile tab killed, network drop).
 *
 * The edge function is fully idempotent — calling it again for an already-
 * processed reference is a no-op that just re-derives the receipt.
 *
 * Returns { ok: boolean, status: number, body: any }.
 *
 * Exported so the F5 admin reconcile endpoint can reuse the same code path.
 *
 * @param {string} reference
 * @param {string|null} [overrideCollectionId] - Manual recovery hint, only
 *   used by the edge function when automatic metadata resolution (the
 *   pending_payment_context row + Paystack's own metadata) both fail to
 *   produce a collectionId. Supplied by an admin via Admin Reconcile after
 *   confirming, out-of-band, which collection a stranded payment belongs to.
 * @param {string|null} [overrideSelectedTierId] - Manual recovery hint for
 *   `tiered` collections, for the rarer case where amount-based tier
 *   inference is ambiguous. The admin panel's Reconcile form has always
 *   collected this (see ReconcilePaymentPage.tsx) but it was silently
 *   dropped here — never read off req.body, never forwarded. Fixed
 *   alongside the invocationSource addition below since both touch this
 *   same call site.
 * @param {string|null} [invocationSource] - 'webhook' | 'admin_reconcile' |
 *   'scheduled_recovery' | 'frontend_callback'. Optional — the edge function
 *   infers a sensible default from the request shape if omitted, so existing
 *   callers that don't pass this keep working identically.
 */
export async function invokeVerifyEdgeFunction(reference, overrideCollectionId = null, overrideSelectedTierId = null, invocationSource = null) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
        process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
        return {
            ok: false,
            status: 500,
            body: { error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/ANON_KEY missing" },
        };
    }

    // Edge functions are reachable at `<supabase-url>/functions/v1/<name>`.
    // Supabase rejects requests without a valid Bearer (anon or service-role
    // key). We use service-role for trust + to bypass any RLS gates the
    // edge function might rely on internally.
    const url = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/verify-paystack-payment`;

    // Use a hard timeout to avoid hanging the webhook on a slow edge function.
    // Paystack's own webhook timeout is ~30s; we cap at 25s.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    const body = { reference };
    if (overrideCollectionId) body.overrideCollectionId = overrideCollectionId;
    if (overrideSelectedTierId) body.overrideSelectedTierId = overrideSelectedTierId;
    if (invocationSource) body.invocationSource = invocationSource;

    try {
        const res = await axios.post(
            url,
            body,
            {
                headers: {
                    Authorization: `Bearer ${supabaseKey}`,
                    apikey: supabaseKey,
                    "Content-Type": "application/json",
                },
                signal: controller.signal,
                timeout: 25000,
                // Tell axios not to throw on non-2xx so we can inspect status.
                validateStatus: () => true,
            }
        );
        return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            body: res.data,
        };
    } catch (err) {
        return {
            ok: false,
            status: 0,
            body: {
                error: err?.message || "edge function invocation failed",
                aborted: err?.name === "CanceledError" || err?.name === "AbortError",
            },
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Validate the client-supplied contribution amount against collection settings.
 *
 * Returns null when the amount is valid, or an error string when it is not.
 * The caller must reject the request if a non-null string is returned.
 *
 * Amount tolerance: ₦1 to absorb minor floating-point rounding differences.
 */
function validateContributionAmount({ collectionType, collection, netAmount, metadata }) {
    const TOLERANCE = 1; // ₦1
    const amount = roundCurrency(netAmount);

    if (!amount || amount <= 0) {
        return "Contribution amount must be greater than zero";
    }

    switch (collectionType) {
        case 'fixed': {
            const expected = roundCurrency(Number(collection.amount || 0));
            if (Math.abs(amount - expected) > TOLERANCE) {
                return `Invalid amount for fixed collection: expected ₦${expected}, received ₦${amount}`;
            }
            break;
        }

        case 'tiered': {
            const tiers = collection.price_tiers || collection.pricing_tiers || [];
            if (!tiers.length) break; // no tiers configured — allow any amount

            const tierId = metadata?.selectedTierId;
            const tierName = metadata?.selectedTier;
            const qty = Math.max(1, Number(metadata?.quantity || 1));

            const matchedTier = tiers.find((t) =>
                (tierId && String(t.id) === String(tierId)) ||
                (tierName && String(t.name) === String(tierName))
            );

            if (matchedTier) {
                const expected = roundCurrency(Number(matchedTier.price) * qty);
                if (Math.abs(amount - expected) > TOLERANCE) {
                    return `Invalid amount for tiered collection: expected ₦${expected} (${qty}× ₦${matchedTier.price}), received ₦${amount}`;
                }
            }
            break;
        }

        case 'ticket': {
            const tiers = collection.price_tiers || collection.pricing_tiers || [];
            const ticketSelections = Array.isArray(metadata?.ticketSelections)
                ? metadata.ticketSelections
                : [];

            if (tiers.length && ticketSelections.length) {
                let expected = 0;
                for (const sel of ticketSelections) {
                    const tier = tiers.find(
                        (t) => String(t.id) === String(sel.tierId) ||
                            String(t.name) === String(sel.tierName)
                    );
                    if (tier) expected += roundCurrency(Number(tier.price) * Number(sel.quantity || 1));
                }
                expected = roundCurrency(expected);
                if (expected > 0 && Math.abs(amount - expected) > TOLERANCE) {
                    return `Invalid ticket amount: expected ₦${expected}, received ₦${amount}`;
                }
            }
            break;
        }

        case 'open_pool':
        case 'fundraising': {
            // Any positive amount is valid; enforce minimum if configured
            const minimum = roundCurrency(
                Number(collection.minimum_amount || collection.minimum_donation || 0)
            );
            if (minimum > 0 && amount < minimum - TOLERANCE) {
                return `Minimum contribution for this collection is ₦${minimum}`;
            }
            break;
        }

        default:
            break;
    }

    return null; // valid
}

const paystackHeaders = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
};

/**
 * Recomputes and persists all wallet balances for a collection from the
 * SOURCE OF TRUTH (contributions + withdrawals tables).
 *
 * B-2: This used to be a read-modify-write that ADDED `netToAdd` to the
 * existing wallet row each call. Because both verifyPayment AND the Paystack
 * webhook ran this function for the same deposit, the wallet was
 * double-credited whenever both paths completed in the same window. Daily
 * 5am-WAT cron eventually corrected drift via the same source-of-truth math,
 * but the window allowed withdrawals against money that didn't exist yet.
 *
 * The new implementation is IDEMPOTENT: running it twice (or N times) for
 * the same deposit yields the same wallet row. We mirror the proven pattern
 * from controllers/withdrawal.js#refreshWallet (which has been correct from
 * day one) by calling utils/financial.js#computeWalletBalances on the live
 * contributions+withdrawals rows.
 *
 * The function signature is preserved (collectionId, grossAmountPaid) so
 * callers do not need to change. The grossAmountPaid arg is now used only
 * for logging — the actual numbers come from the database.
 *
 * Balance rules (see utils/financial.js for full definitions):
 *   - net_payment (Total Raised) = sum of paid contribution.amount
 *   - gross_payment              = sum of contribution.gross_amount (with fees)
 *   - pending_balance            = net amounts after the 5am WAT cutoff
 *   - available_balance          = settled net minus completed withdrawals
 *   - ledger_balance             = available + pending
 *   - withdrawn                  = sum of completed/approved withdrawals
 */
export async function updateWalletStats(collectionId, grossAmountPaid) {
    if (!collectionId) return;

    console.log(
        `[updateWalletStats] (source-of-truth) collectionId=${collectionId}` +
        (grossAmountPaid ? `, triggeredBy=₦${grossAmountPaid}` : "")
    );

    try {
        // Locate the wallet for this collection. If a collection has multiple
        // wallet rows (legacy data), pick the most recently updated one — the
        // existing wallet.js#getCollectionWallet uses the same strategy.
        const { data: wallet, error: walletError } = await supabase
            .from("wallets")
            .select("id")
            .eq("collection_id", collectionId)
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (walletError || !wallet) {
            console.warn(
                `[updateWalletStats] wallet not found for collection ${collectionId}`,
                walletError?.message
            );
            return;
        }
        // Pull everything we need to compute the canonical balances.
        const [
            { data: collection, error: colError },
            { data: contributions, error: contribError },
            { data: withdrawals, error: withError },
        ] = await Promise.all([
            supabase
                .from("collections")
                .select("fee_bearer, collection_type")
                .eq("id", collectionId)
                .single(),
            supabase
                .from("contributions")
                .select("amount, gross_amount, created_at")
                .eq("collection_id", collectionId)
                .eq("status", "paid"),
            supabase
                .from("withdrawals")
                .select("amount, status")
                .eq("collection_id", collectionId),
        ]);

        if (colError || contribError || withError) {
            console.error(
                "[updateWalletStats] source fetch failed:",
                (colError || contribError || withError)?.message
            );
            return;
        }

        const normalized = normalizeContributions(
            contributions || [],
            collection?.fee_bearer || "organizer",
            collection?.collection_type || "fixed"
        );

        const balances = computeWalletBalances(normalized, withdrawals || []);

        const { error: updateError } = await supabase
            .from("wallets")
            .update({
                gross_payment: balances.grossPayment,
                net_payment: balances.netPayment,
                pending_balance: balances.pendingBalance,
                available_balance: balances.availableBalance,
                ledger_balance: balances.ledgerBalance,
                withdrawn: balances.completedWithdrawals,
                updated_at: new Date().toISOString(),
            })
            .eq("id", wallet.id);

        if (updateError) {
            console.error(
                "[updateWalletStats] wallet write failed:",
                updateError.message
            );
            return;
        }

        // Keep collections.total_contributions in sync with the paid count.
        // Idempotent: derived from the same source-of-truth array we just
        // computed balances from.
        const paidCount = (contributions || []).length;
        await supabase
            .from("collections")
            .update({
                total_contributions: paidCount,
                updated_at: new Date().toISOString(),
            })
            .eq("id", collectionId);

        console.log(`[updateWalletStats] ✅ Wallet recomputed for ${collectionId}:`, {
            paidContributions: paidCount,
            netPayment: balances.netPayment,
            grossPayment: balances.grossPayment,
            pending: balances.pendingBalance,
            available: balances.availableBalance,
            ledger: balances.ledgerBalance,
            withdrawn: balances.completedWithdrawals,
        });
    } catch (err) {
        console.error("[updateWalletStats] Unexpected error:", err?.message || err);
    }
}


// Initialize a payment (get payment link)
// Accepts two formats:
//   NEW (from ContributeFlow): { email, callback_url, metadata: { collectionId, contributionAmount, totalPayable, contact, formData, ticketSelections, ... } }
//   LEGACY (from ContributionForm): { fullName, email, phoneNumber, amount, collectionId, callback_url, contributor: {...} }
export const initializePayment = async (req, res) => {
    const body = req.body || {};
    console.log("[initializePayment] body keys:", Object.keys(body));

    // ── Detect format ────────────────────────────────────────────────────────
    const isNewFormat = body.metadata && typeof body.metadata === "object";
    console.log("[initializePayment] isNewFormat:", isNewFormat, "| email:", body.email);

    let email, fullName, phoneNumber, collectionId, callback_url;
    let netAmount;      // what the organizer earns (= Total Raised contribution)
    let totalPayable;   // what Paystack charges (may include fees on top)
    let formData = {};
    let ticketSelections = [];
    let paystackMeta = {};

    if (isNewFormat) {
        const meta = body.metadata;
        email = body.email;
        callback_url = body.callback_url;
        collectionId = meta.collectionId || meta.collection_id;
        fullName = meta.contact?.name || "";
        phoneNumber = meta.contact?.phone || "";
        netAmount = Number(meta.contributionAmount || meta.amount || 0);
        totalPayable = Number(meta.totalPayable || netAmount);
        formData = meta.formData && typeof meta.formData === "object" ? meta.formData : {};
        ticketSelections = Array.isArray(meta.ticketSelections) ? meta.ticketSelections : [];
        // Only send essential fields to Paystack — avoid metadata size limit
        paystackMeta = {
            collectionId,
            collectionType: meta.collectionType || meta.collectiontype,
            feeBearer: meta.feeBearer,
            contributionAmount: netAmount,
            totalPayable,
            selectedTier: meta.selectedTier || null,
            selectedTierId: meta.selectedTierId || null,
            quantity: meta.quantity || 1,
            codePrefix: meta.codePrefix || null,
            isAnonymous: meta.isAnonymous || false,
            fullName,
            phoneNumber,
        };
    } else {
        // Legacy format — delegate to createContribution for contribution record
        email = body.email;
        fullName = body.fullName;
        phoneNumber = body.phoneNumber;
        collectionId = body.collectionId;
        callback_url = body.callback_url;
        netAmount = Number(body.amount || 0);
        totalPayable = netAmount;
        paystackMeta = { fullName, phoneNumber, collectionId };
    }

    console.log("[initializePayment] collectionId:", collectionId, "| netAmount:", netAmount, "| totalPayable:", totalPayable);

    if (!email || !collectionId || !netAmount) {
        return res.status(400).json({ error: "email, collectionId, and amount are required", debug: { email: !!email, collectionId, netAmount } });
    }

    try {
        // ── Validate collection ──────────────────────────────────────────────
        const { data: collection, error: collectionError } = await supabase
            .from("collections")
            .select("*")
            .eq("id", collectionId)
            .single();

        console.log("[initializePayment] collection fetch:", { found: !!collection, error: collectionError?.message });

        if (collectionError || !collection) {
            return res.status(404).json({ error: "Collection not found", collectionId, supabaseError: collectionError?.message });
        }

        // ── Server-side amount validation ────────────────────────────────────
        // Recompute the expected net contribution from collection settings so
        // that a tampered client payload cannot change what Paystack charges.
        const collType = collection.collection_type || collection.collectionType || 'fixed';
        const feeBearer = (isNewFormat ? body.metadata?.feeBearer : null)
            || collection.fee_bearer
            || 'organizer';

        const amountError = validateContributionAmount({
            collectionType: collType,
            collection,
            netAmount,
            metadata: isNewFormat ? body.metadata : null,
        });
        if (amountError) {
            return res.status(400).json({ error: amountError });
        }

        // Re-derive totalPayable server-side — ignore whatever the client sent
        const { totalPayable: serverTotalPayable } = calculateFees(netAmount, collType, feeBearer);
        totalPayable = serverTotalPayable;
        // Keep paystackMeta in sync with server-computed values
        if (isNewFormat) {
            paystackMeta.totalPayable = totalPayable;
            paystackMeta.feeBearer = feeBearer;
        }

        let contributorId;

        if (isNewFormat) {
            // ── New format: create contribution inline ───────────────────────
            // Store formData + ticketSelections in contributor_information
            const infoEntry = { ...formData };
            if (ticketSelections.length > 0) infoEntry._ticketSelections = ticketSelections;

            const { data: contributorData, error: contributorError } = await supabase
                .from("contributions")
                .insert([{
                    collection_id: collectionId,
                    name: fullName,
                    email,
                    phone: phoneNumber,
                    amount: netAmount,  // ALWAYS the net contribution (Total Raised tracks this)
                    contributor_information: Object.keys(infoEntry).length ? [infoEntry] : [],
                    status: "pending",
                }])
                .select()
                .single();

            if (contributorError) throw contributorError;
            contributorId = contributorData.id;
            paystackMeta.contributorId = contributorId;
        } else {
            // ── Legacy format: use createContribution ────────────────────────
            const contributionResult = await createContribution(req, res);
            if (res.headersSent) return;

            const contributor = contributionResult?.contributor;
            if (!contributor?.id) {
                return res.status(500).json({ error: "Failed to create contribution record" });
            }
            contributorId = contributor.id;
            // Use the amount the legacy flow computed (may include fees for organizer-borne)
            totalPayable = contributor.amount;
            netAmount = contributor.amount;
            paystackMeta.contributorId = contributorId;
        }

        // ── Call Paystack ────────────────────────────────────────────────────
        const paystackRes = await axios.post(
            `${PAYSTACK_BASE_URL}/transaction/initialize`,
            {
                email,
                amount: Math.round(totalPayable * 100), // kobo — always totalPayable
                callback_url: callback_url || `${process.env.FRONTEND_URL}/payment/verify`,
                metadata: paystackMeta,
            },
            { headers: paystackHeaders }
        );

        const paystackData = paystackRes.data.data;

        // Tier 1: the legacy `deposits` record was removed. The contribution
        // (created above) is the payment source of truth; verification reads it.

        // ── Send init email (fire-and-forget) ────────────────────────────────
        try {
            const details = Object.entries(formData)
                .filter(([k]) => !k.startsWith("_"))
                .map(([label, value]) => ({
                    label: label.charAt(0).toUpperCase() + label.slice(1).replace(/_/g, " "),
                    value,
                }));

            await sendPaymentInitialize(
                email, fullName, collection.title,
                totalPayable, "NGN",
                paystackData.authorization_url,
                paystackData.reference,
                [{ id: contributorId, details, uniqueCode: null }],
                new Date().toISOString()
            );
        } catch (err) {
            console.error("Init email error:", err?.message || err);
        }

        // F4: structured log for end-to-end correlation
        console.log(
            `[initiate-be ref=${paystackData.reference}] PAYMENT_INITIATED collectionId=${collectionId} netAmount=${netAmount} totalPayable=${totalPayable} feeBearer=${feeBearer} type=${collType}`
        );

        res.status(200).json({
            message: "Payment initialized successfully",
            authorizationUrl: paystackData.authorization_url,
            authorization_url: paystackData.authorization_url, // both formats
            reference: paystackData.reference,
        });
    } catch (error) {
        console.error("[initializePayment] CAUGHT ERROR:", error?.message, error?.code, error?.response?.data);
        return res.status(500).json({
            error: error?.response?.data?.message || error?.message || "Internal server error",
            code: error?.code,
            detail: error?.response?.data || error?.details || undefined,
        });
    }
};

const formatDetails = (infoArr) => {
    if (!Array.isArray(infoArr)) return [];
    return infoArr.flatMap((obj) =>
        Object.entries(obj).map(([label, value]) => ({
            label: label.trim(),
            value,
        }))
    );
};

// Verify a payment
export const verifyPayment = async (req, res) => {
    const { reference } = req.query;

    if (!reference) {
        return res.status(400).json({ error: "Reference is required" });
    }

    // F4: correlation log
    console.log(`[verify-be ref=${reference}] VERIFY_CALLED`);

    // Canonical verify: the payment source of truth is `contributions` (written
    // by the edge initiate/verify path). Verify with Paystack and read the
    // contribution. The legacy `deposits` lookup was removed in Tier 1 — it was
    // always empty and never on the live path.
    {
        // ── Fallback: payment was initiated via Supabase Edge Function, so no
        // deposits record exists. Verify directly with Paystack and read from
        // the contributions table (which the edge function always writes to).
        try {
            const paystackRes = await axios.get(
                `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
                { headers: paystackHeaders }
            );
            const tx = paystackRes.data.data;

            const meta = (tx.metadata && typeof tx.metadata === "object") ? tx.metadata : {};
            const collectionId = String(meta.collectionId || meta.collection_id || "").trim();
            if (!collectionId) {
                return res.status(404).json({ error: "Deposit not found and no collection ID in payment metadata." });
            }

            const [{ data: contribution }, { data: collection }] = await Promise.all([
                supabase
                    .from("contributions")
                    .select("*")
                    .eq("payment_reference", reference)
                    .eq("collection_id", collectionId)
                    .order("created_at", { ascending: true })
                    .limit(1)
                    .maybeSingle(),
                supabase
                    .from("collections")
                    .select("*")
                    .eq("id", collectionId)
                    .single(),
            ]);

            if (!collection) {
                return res.status(404).json({ error: "Collection not found for this payment." });
            }

            const fallbackNetAmount = contribution?.amount ?? roundCurrency(Number(tx.amount || 0) / 100);
            const fallbackTotalPaid = roundCurrency(Number(tx.amount || 0) / 100);
            const fallbackCollType = collection.collection_type || collection.type || "fixed";
            const fallbackFeeBearer = collection.fee_bearer || "organizer";
            const { platformFee: fbPlatformFee, gatewayFee: fbGatewayFee } =
                calculateFees(fallbackNetAmount, fallbackCollType, fallbackFeeBearer);
            const fallbackTotalFees = roundCurrency(fallbackTotalPaid - fallbackNetAmount);

            const fallbackParticipants = contribution
                ? [{
                    id: contribution.id,
                    uniqueCode: contribution.contributor_unique_code || null,
                    details: formatDetails(contribution.contributor_information),
                }]
                : [];

            const fallbackTicketSelections =
                contribution?.contributor_information?.[0]?._ticketSelections || [];

            const fallbackReceiptData = {
                collectionTitle: collection.title || "",
                collectionType: fallbackCollType,
                description: collection.description || "",
                campaignSummary: collection.campaign_summary || "",
                bannerUrl: collection.banner_url || collection.banner_image || "",
                eventDate: collection.event_date || "",
                uniqueIdEnabled: shouldGenerateUniqueCode(collection),
                codePrefix: collection.code_prefix || "",
                contributionAmount: fallbackNetAmount,
                platformFee: fbPlatformFee,
                gatewayFee: fbGatewayFee,
                totalFees: fallbackTotalFees > 0 ? fallbackTotalFees : 0,
                totalPaid: fallbackTotalPaid,
                participants: fallbackParticipants,
                ticketSelections: fallbackTicketSelections,
                transactionRef: String(tx.reference || reference),
                status: String(tx.status || "success"),
                paidAt: tx.paid_at || new Date().toISOString(),
                channel: tx.channel || "",
                currency: tx.currency || "NGN",
                payer: {
                    name: contribution?.name || String(tx.customer?.email || "").split("@")[0] || "",
                    email: contribution?.email || String(tx.customer?.email || ""),
                    phone: contribution?.phone || "",
                },
            };

            // Send receipt email (non-blocking, best-effort)
            if (tx.status === "success" && fallbackReceiptData.payer.email) {
                sendPaymentConfirmation(
                    fallbackReceiptData.payer.email,
                    fallbackReceiptData.payer.name,
                    collection.title,
                    fallbackTotalPaid,
                    tx.currency || "NGN",
                    String(tx.reference || reference),
                    tx.paid_at,
                    tx.channel,
                    fallbackParticipants,
                    `${process.env.FRONTEND_URL}/payment/verify?reference=${reference}`,
                    null
                ).catch((err) =>
                    console.error("[verifyPayment fallback] email error:", err?.message || err)
                );
            }

            return res.status(200).json({
                message: "Payment verified",
                receiptData: fallbackReceiptData,
            });
        } catch (fallbackErr) {
            console.error("[verifyPayment fallback] error:", fallbackErr?.message);
            return res.status(404).json({ error: "Deposit not found and fallback verification failed." });
        }
    }

};

// List all Paystack transactions
export const listTransactions = async (req, res) => {
    try {
        const response = await axios.get(`${PAYSTACK_BASE_URL}/transaction`, {
            headers: paystackHeaders,
        });
        return res.status(200).json(response.data);
    } catch (error) {
        return res
            .status(500)
            .json({ error: error.response?.data?.message || error.message });
    }
};

// Fetch a single transaction by ID
export const fetchTransaction = async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: "Transaction ID is required" });
    }
    try {
        const response = await axios.get(`${PAYSTACK_BASE_URL}/transaction/${id}`, {
            headers: paystackHeaders,
        });
        return res.status(200).json(response.data);
    } catch (error) {
        return res
            .status(500)
            .json({ error: error.response?.data?.message || error.message });
    }
};

// Verify Paystack webhook signature.
//
// B-1: Paystack signs the EXACT bytes of the HTTP body. If express.json()
// runs before this handler, req.body is a JS object and JSON.stringify(obj)
// produces different whitespace/key order than the bytes Paystack signed —
// so the HMAC will never match. The route must be mounted with
// express.raw() in app.js BEFORE express.json(), which gives us a Buffer here.
//
// We assert Buffer-ness defensively below: if we ever receive a parsed
// object on this code path we log a critical warning and refuse the request,
// because verifying against a re-serialised object is unsafe.
async function verifyPaystackSignature(req) {
    if (!Buffer.isBuffer(req.body)) {
        console.error(
            "[webhook] req.body is not a Buffer — express.raw() is not wired correctly for /api/payments/webhook. Refusing signature verification."
        );
        return false;
    }
    // Guard against missing secret key — createHmac throws TypeError if key is undefined
    if (!PAYSTACK_SECRET_KEY) {
        console.error("[webhook] PAYSTACK_SECRET_KEY is not set — cannot verify signature. Refusing.");
        return false;
    }
    const payload = req.body.toString("utf8");
    const signature = req.headers["x-paystack-signature"];

    if (!signature) {
        console.warn("[webhook] missing x-paystack-signature header");
        return false;
    }

    if (crypto?.createHmac) {
        const hash = crypto
            .createHmac("sha512", PAYSTACK_SECRET_KEY)
            .update(payload)
            .digest("hex");
        // timingSafeEqual would be ideal but length-mismatched buffers throw;
        // both values are hex of the same length when signature is well-formed
        // so a constant-time compare here is fine.
        try {
            const a = Buffer.from(hash, "hex");
            const b = Buffer.from(String(signature), "hex");
            return a.length === b.length && crypto.timingSafeEqual(a, b);
        } catch {
            return hash === signature;
        }
    }

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(PAYSTACK_SECRET_KEY),
        { name: "HMAC", hash: "SHA-512" },
        false,
        ["sign"]
    );
    const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const hashHex = Array.from(new Uint8Array(sigBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return hashHex === signature;
}

async function notifyOrganizerPushForReference(reference, source) {
    if (!reference) return { sent: 0, skipped: true };

    try {
        const result = await notifyContributionByReference(reference);
        console.log(`[webhook ref=${reference}] ORGANIZER_PUSH_${source}`, {
            sent: result?.sent || 0,
            duplicate: Boolean(result?.duplicate),
            skipped: Boolean(result?.skipped),
            error: result?.error?.message || null,
        });
        return result;
    } catch (error) {
        console.error(`[webhook ref=${reference}] ORGANIZER_PUSH_${source}_FAILED`, {
            message: error?.message || error,
        });
        return { sent: 0, error };
    }
}

// Handle Paystack webhook
export const handleWebhook = async (req, res) => {
    // We expect a raw Buffer here (see app.js wiring). Parse defensively so a
    // future misconfiguration doesn't crash with a JSON.parse error on an
    // already-parsed object.
    let event;
    try {
        event = Buffer.isBuffer(req.body)
            ? JSON.parse(req.body.toString("utf8"))
            : req.body;
    } catch (parseErr) {
        console.error("[webhook] failed to parse body:", parseErr?.message);
        return res.status(400).send("Invalid JSON");
    }

    const isValid = await verifyPaystackSignature(req);
    if (!isValid) {
        // Log the event type for ops visibility but never the full payload —
        // it can contain PII / card metadata.
        console.warn("[webhook] invalid signature for event:", event?.event || "(unknown)");
        return res.status(403).json({ error: "Invalid signature" });
    }
    console.log("[webhook] received valid event:", event?.event);

    if (event.event === "charge.success") {
        const reference = event.data?.reference;
        console.log(`[webhook ref=${reference}] WEBHOOK_RECEIVED charge.success`);

        // ── Outer safety net: any unhandled throw returns 500 (Paystack retries)
        // instead of crashing Express and causing a 502 Bad Gateway.
        try {

        // ─── F1: Safety-net check #1 ─────────────────────────────────────────
        try {
            const { data: existingContribs, error: contribErr } = await supabase
                .from("contributions")
                .select("id, status")
                .eq("payment_reference", reference)
                .limit(1);
            if (!contribErr && existingContribs && existingContribs.length > 0) {
                const anyPaid = existingContribs.some(
                    (c) => String(c.status || "").toLowerCase() === "paid"
                );
                if (anyPaid) {
                    console.log(
                        `[webhook ref=${reference}] WEBHOOK_ALREADY_PROCESSED — contribution already paid, no-op`
                    );
                    await notifyOrganizerPushForReference(reference, "ALREADY_PAID");
                    return res
                        .status(200)
                        .send("Already processed");
                }
            }
        } catch (lookupErr) {
            console.warn(
                `[webhook ref=${reference}] contribution lookup failed (non-fatal):`,
                lookupErr?.message
            );
        }

        // ─── Recovery: no PAID contribution exists yet. The canonical payment
        // source of truth is `contributions`; invoke the idempotent verify edge
        // function to record/settle the payment. (The legacy `deposits` lookup
        // was removed in Tier 1 — it was always empty and never on the live path.)
        {
            // D-1 diagnostic: the webhook payload carries its OWN copy of
            // metadata, separate from what the edge function fetches via
            // /transaction/verify. Logging its shape here (never the values
            // beyond type/keys) lets a future investigation compare whether
            // Paystack's webhook and verify-API ever disagree on metadata
            // shape for the same reference — useful if "Missing collection
            // ID" recurs after the D-1 fix in verify-paystack-payment.
            console.log(`[webhook ref=${reference}] WEBHOOK_METADATA_DIAGNOSTIC`, {
                rawMetadataType: typeof event.data?.metadata,
                metadataKeys:
                    event.data?.metadata && typeof event.data.metadata === "object"
                        ? Object.keys(event.data.metadata)
                        : null,
            });
            console.log(
                `[webhook ref=${reference}] WEBHOOK_INVOKED_VERIFY — no contributions or deposits row exists; recovering via edge function`
            );
            const invokeResult = await invokeVerifyEdgeFunction(reference, null, null, "webhook");
            if (invokeResult.ok) {
                console.log(
                    `[webhook ref=${reference}] WEBHOOK_VERIFY_RECOVERED status=${invokeResult.status}`
                );
                await notifyOrganizerPushForReference(reference, "VERIFY_RECOVERED");
                return res.status(200).send("Recovered via edge function");
            }
            // Return 500 so Paystack retries — the edge function may have
            // hit a transient issue (DB error, etc.).
            console.error(
                `[webhook ref=${reference}] WEBHOOK_VERIFY_FAILED status=${invokeResult.status}`,
                {
                    error: invokeResult.body?.error,
                    code: invokeResult.body?.code,
                }
            );
            return res.status(500).json({
                error: "Edge function verification failed",
                paystack_reference: reference,
                edge_function_status: invokeResult.status,
                edge_function_error: invokeResult.body?.error || null,
            });
        }


        } catch (whErr) {
            // Catch-all for the entire charge.success processing path.
            // Returns 500 so Paystack retries — never crashes Express.
            console.error(`[webhook ref=${reference}] WEBHOOK_UNHANDLED_ERROR`, {
                message: whErr?.message,
                stack: whErr?.stack,
            });
            return res.status(500).json({
                error: "Webhook processing failed",
                ref: reference,
            });
        }
    } // end if charge.success

    // All other event types — always acknowledge with 200
    console.log(
        `[webhook ref=${event?.data?.reference || "?"}] WEBHOOK_DONE event=${event?.event || "?"}`
    );
    res.status(200).send("Webhook received");
};

/**
 * POST /api/payments/send-receipt
 *
 * Internal endpoint called by the Supabase Edge Function after a successful
 * payment. Sends a confirmation email to the contributor and notifies the
 * organizer, using the existing Zoho SMTP email infrastructure.
 *
 * Secured by an optional x-internal-secret header
 * (set INTERNAL_NOTIFY_SECRET in backend .env and as a Supabase secret).
 */
export const sendReceiptNotification = async (req, res) => {
    // Optional simple secret header guard (prevents abuse from the public internet)
    const internalSecret = process.env.INTERNAL_NOTIFY_SECRET;
    if (internalSecret) {
        const provided = req.headers["x-internal-secret"];
        if (provided !== internalSecret) {
            return res.status(403).json({ error: "Forbidden" });
        }
    }

    const {
        payerEmail,
        payerName,
        collectionTitle,
        totalPaid,
        currency = "NGN",
        transactionRef,
        paidAt,
        channel = "card",
        participants = [],
        collectionId,
        // Premium-receipt fields (sent by the edge function; all optional so the
        // template degrades gracefully if an older caller omits them).
        collectionType,
        collectionDescription,
        contributionAmount,
        platformFee,
        gatewayFee,
        transactionId,
        organizerName,
        uniqueCodes,
    } = req.body || {};

    if (!payerEmail || !collectionTitle || !transactionRef) {
        return res.status(400).json({
            error: "payerEmail, collectionTitle, and transactionRef are required",
        });
    }

    const results = { payer: null, organizer: null };

    // ── Contributor receipt email ────────────────────────────────────────────
    try {
        results.payer = await sendPaymentConfirmation(
            payerEmail,
            payerName || payerEmail.split("@")[0],
            collectionTitle,
            totalPaid,
            currency,
            transactionRef,
            paidAt || new Date().toISOString(),
            channel,
            participants,
            `${process.env.FRONTEND_URL}/payment/verify?reference=${transactionRef}`,
            organizerName || null,
            {
                collectionType,
                collectionDescription,
                contributionAmount,
                platformFee,
                gatewayFee,
                totalPaid,
                transactionId,
                organizerName: organizerName || undefined,
                uniqueCodes,
            }
        );
        console.log("[sendReceiptNotification] ✅ Contributor email sent to", payerEmail);
    } catch (err) {
        console.error("[sendReceiptNotification] ❌ Contributor email error:", err?.message);
    }

    // ── Organizer notification ───────────────────────────────────────────────
    if (collectionId) {
        try {
            const { data: coll } = await supabase
                .from("collections")
                .select("title, user_id")
                .eq("id", collectionId)
                .single();

            if (coll?.user_id) {
                const { data: organizer } = await supabase
                    .from("profiles")
                    .select("email, full_name")
                    .eq("id", coll.user_id)
                    .single();

                if (organizer?.email) {
                    const amountFormatted = new Intl.NumberFormat("en-NG", {
                        style: "currency", currency, minimumFractionDigits: 2,
                    }).format(totalPaid || 0);

                    results.organizer = await sendEmail({
                        to: organizer.email,
                        subject: `New Payment Received — ${collectionTitle}`,
                        html: `
                          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
                            <div style="background:linear-gradient(135deg,#1B5E20,#388E3C);padding:24px;border-radius:8px 8px 0 0;text-align:center;">
                              <h1 style="color:#fff;margin:0;font-size:20px;">New Payment Received</h1>
                            </div>
                            <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
                              <p style="color:#374151;margin:0 0 16px;">Hi <strong>${organizer.full_name || "there"}</strong>,</p>
                              <p style="color:#4b5563;margin:0 0 24px;">You have received a new payment for <strong>${collectionTitle}</strong>.</p>
                              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                                <tr style="border-bottom:1px solid #f3f4f6;">
                                  <td style="padding:10px 0;color:#6b7280;">Payer</td>
                                  <td style="padding:10px 0;color:#111827;font-weight:600;text-align:right;">${payerName || payerEmail}</td>
                                </tr>
                                <tr style="border-bottom:1px solid #f3f4f6;">
                                  <td style="padding:10px 0;color:#6b7280;">Amount</td>
                                  <td style="padding:10px 0;color:#16a34a;font-weight:700;font-size:16px;text-align:right;">${amountFormatted}</td>
                                </tr>
                                <tr>
                                  <td style="padding:10px 0;color:#6b7280;">Reference</td>
                                  <td style="padding:10px 0;color:#111827;font-family:monospace;text-align:right;">${transactionRef}</td>
                                </tr>
                              </table>
                              <p style="color:#9ca3af;font-size:12px;margin:24px 0 0;text-align:center;">Kolekto · Secure group payments</p>
                            </div>
                          </div>`,
                    });
                    console.log("[sendReceiptNotification] ✅ Organizer email sent to", organizer.email);
                }
            }
        } catch (err) {
            console.error("[sendReceiptNotification] ❌ Organizer email error:", err?.message);
        }
    }

    // ── Organizer + contributor PUSH ─────────────────────────────────────────
    // The edge function (verify-paystack-payment) calls this endpoint on EVERY
    // first-time confirmed payment, so it — not just the Paystack webhook — is a
    // reliable trigger for the payment push. Relying only on the webhook means a
    // misconfigured/blocked webhook URL silently kills ALL payment pushes even
    // though payments, wallets and emails are fine. This call is fully
    // idempotent: notifyContributionByReference dedupes on
    // `contribution-paid:<reference>` (organizer) and `contributor-paid:<reference>`
    // (contributor), so the webhook also firing never produces a second push.
    // Best-effort and non-blocking — a push failure must never fail the receipt.
    if (transactionRef) {
        await notifyOrganizerPushForReference(transactionRef, "SEND_RECEIPT").catch((err) =>
            console.error("[sendReceiptNotification] ❌ Organizer push error:", err?.message || err)
        );
    }

    return res.status(200).json({ success: true, results });
};

export default {
    initializePayment,
    verifyPayment,
    listTransactions,
    fetchTransaction,
    handleWebhook,
    sendReceiptNotification,
};
