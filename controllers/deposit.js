import axios from "axios";
import { supabase } from "../utils/client.js";
import { createContribution } from "./contribution.js";
import crypto from "node:crypto";
import { sendEmail } from "../services/emailService.js";
import { sendPaymentInitialize, sendPaymentConfirmation } from "../utils/emailHelper.js";
import {
    calculateFees,
    computeWalletBalances,
    roundCurrency,
} from "../utils/financial.js";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = "https://api.paystack.co";

const paystackHeaders = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
};

/**
 * Recomputes and persists all wallet balances for a collection from the source of
 * truth (contributions + withdrawals tables). Called after every successful payment.
 *
 * Balance rules (see utils/financial.js for full definitions):
 *   - net_payment (Total Raised) = sum of contribution.amount — NEVER includes fees
 *   - pending_balance = net amounts received today (after 5am WAT) — not withdrawable yet
 *   - available_balance = settled net amounts minus completed withdrawals
 *   - ledger_balance = available + pending (total funds remaining)
 *   - Fees are stored separately; they are never mixed into any balance field
 */
export async function updateWalletStats(collectionId, grossAmountPaid) {
    if (!collectionId || !grossAmountPaid || grossAmountPaid <= 0) return;

    console.log(`[updateWalletStats] collectionId=${collectionId}, grossAmountPaid=${grossAmountPaid}`);

    try {
        // Fetch collection to determine type and fee_bearer
        const { data: collection, error: collectionError } = await supabase
            .from("collections")
            .select("fee_bearer, type, collection_type")
            .eq("id", collectionId)
            .single();

        if (collectionError || !collection) {
            console.error("[updateWalletStats] Failed to fetch collection:", collectionError);
            return;
        }

        const collectionType = collection.collection_type || collection.type || "fixed";
        const feeBearer = collection.fee_bearer || "organizer";

        // Derive net contribution amount from the gross amount charged
        const { totalFees } = calculateFees(
            feeBearer === "contributor"
                ? roundCurrency(grossAmountPaid / (1 + (collectionType === "fundraising" ? 0.025 : 0.02)))
                : grossAmountPaid,
            collectionType,
            feeBearer
        );

        // Net amount = what the organizer earns from this payment
        const netContribution =
            feeBearer === "contributor"
                ? roundCurrency(grossAmountPaid - totalFees)
                : roundCurrency(grossAmountPaid);

        // Fetch all paid contributions to recompute totals from scratch
        const { data: paidContributions, error: contribError } = await supabase
            .from("contributions")
            .select("amount, gross_amount, created_at")
            .eq("collection_id", collectionId)
            .eq("status", "paid");

        if (contribError) {
            console.error("[updateWalletStats] Failed to fetch contributions:", contribError);
            return;
        }

        // Fetch all withdrawals
        const { data: withdrawals } = await supabase
            .from("withdrawals")
            .select("amount, status")
            .eq("collection_id", collectionId);

        const balances = computeWalletBalances(paidContributions || [], withdrawals || []);

        // Explicit SELECT-then-UPDATE-or-INSERT (upsert with onConflict silently fails
        // if no UNIQUE constraint exists on wallets.collection_id).
        const walletPayload = {
            collection_id: collectionId,
            gross_payment: balances.grossPayment,
            net_payment: balances.netPayment,
            pending_balance: balances.pendingBalance,
            available_balance: balances.availableBalance,
            ledger_balance: balances.ledgerBalance,
            withdrawn: balances.completedWithdrawals,
            currency: "NGN",
            currency_symbol: "₦",
            updated_at: new Date().toISOString(),
        };

        const { data: existingWallet, error: walletCheckErr } = await supabase
            .from("wallets")
            .select("id")
            .eq("collection_id", collectionId)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();

        if (walletCheckErr) {
            console.error("[updateWalletStats] Wallet lookup failed:", walletCheckErr);
            return;
        }

        if (existingWallet) {
            const { error: updateErr } = await supabase
                .from("wallets")
                .update(walletPayload)
                .eq("id", existingWallet.id);
            if (updateErr) {
                console.error("[updateWalletStats] ❌ Wallet UPDATE failed:", updateErr);
                return;
            }
            console.log("[updateWalletStats] ✅ Wallet UPDATED:", existingWallet.id);
        } else {
            const { error: insertErr } = await supabase
                .from("wallets")
                .insert(walletPayload);
            if (insertErr) {
                console.error("[updateWalletStats] ❌ Wallet INSERT failed:", insertErr);
                return;
            }
            console.log("[updateWalletStats] ✅ Wallet INSERTED for collection:", collectionId);
        }

        // Increment total_contributions on the collection
        const { data: currentCollection } = await supabase
            .from("collections")
            .select("total_contributions")
            .eq("id", collectionId)
            .single();

        await supabase
            .from("collections")
            .update({
                total_contributions: (currentCollection?.total_contributions || 0) + 1,
                updated_at: new Date().toISOString(),
            })
            .eq("id", collectionId);

        console.log(`[updateWalletStats] ✅ Wallet updated for ${collectionId}:`, {
            netContribution,
            netPayment: balances.netPayment,
            pendingBalance: balances.pendingBalance,
            availableBalance: balances.availableBalance,
            ledgerBalance: balances.ledgerBalance,
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

        // ── Get wallet ───────────────────────────────────────────────────────
        const { data: wallet } = await supabase
            .from("wallets")
            .select("id")
            .eq("collection_id", collectionId)
            .single();

        // ── Insert deposit record ────────────────────────────────────────────
        const { data: payment, error: paymentError } = await supabase
            .from("deposits")
            .insert([{
                full_name: fullName,
                email,
                amount: totalPayable, // what Paystack charged
                phone_number: phoneNumber,
                currency: "NGN",
                status: "pending",
                payment_reference: paystackData.reference,
                authorization_url: paystackData.authorization_url,
                contributor_id: contributorId,
                wallet_id: wallet?.id || null,
                collection_id: collectionId,
                init_email_sent: false,
                contributor_confirmed_sent: false,
                organizer_notified_sent: false,
            }])
            .select()
            .single();

        if (paymentError) {
            return res.status(500).json({ error: "Failed to create payment record" });
        }

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
            await supabase
                .from("deposits")
                .update({ init_email_sent: true, updated_at: new Date().toISOString() })
                .eq("id", payment.id);
        } catch (err) {
            console.error("Init email error:", err?.message || err);
        }

        console.log(`✅ Payment initialized | ${collectionId} | net=₦${netAmount} | payable=₦${totalPayable}`);

        res.status(200).json({
            message: "Payment initialized successfully",
            authorizationUrl: paystackData.authorization_url,
            authorization_url: paystackData.authorization_url, // both formats
            reference: paystackData.reference,
        });

        // Background: link deposit → contribution
        (async () => {
            try {
                await supabase
                    .from("contributions")
                    .update({ payment_id: payment.id })
                    .eq("id", contributorId);
            } catch (err) {
                console.error("Background link error:", err.message);
            }
        })();
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

    const { data: existingDeposit, error: fetchError } = await supabase
        .from("deposits")
        .select("*")
        .eq("payment_reference", reference)
        .single();

    if (fetchError || !existingDeposit) {
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
                uniqueIdEnabled: Boolean(collection.unique_id_enabled),
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
                    collection.title
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

    // Already successful — return cached data and resend confirmation if needed
    if (existingDeposit.status === "success") {
        const [{ data: contributor }, { data: collection }] = await Promise.all([
            supabase
                .from("contributions")
                .select("*")
                .eq("id", existingDeposit.contributor_id)
                .single(),
            supabase
                .from("collections")
                .select("*")
                .eq("id", existingDeposit.collection_id)
                .single(),
        ]);

        const participants = [
            {
                id: contributor?.id,
                uniqueCode: contributor?.contributor_unique_code || null,
                details: formatDetails(contributor?.contributor_information),
            },
        ];

        // Build fee breakdown for receipt
        const existingCollType = collection?.collection_type || collection?.type || "fixed";
        const existingFeeBearer = collection?.fee_bearer || "organizer";
        const existingNetAmount = contributor?.amount || existingDeposit.amount;
        const existingTotalPaid = existingDeposit.amount;
        const { platformFee: exPlatformFee, gatewayFee: exGatewayFee } =
            calculateFees(existingNetAmount, existingCollType, existingFeeBearer);
        const existingTotalFees = roundCurrency(existingTotalPaid - existingNetAmount);
        const existingTicketSelections =
            contributor?.contributor_information?.[0]?._ticketSelections || [];

        const receiptData = {
            collectionTitle: collection?.title || "",
            collectionType: collection?.collection_type || collection?.type || "fixed",
            description: collection?.description || "",
            campaignSummary: collection?.campaign_summary || "",
            bannerUrl: collection?.banner_url || collection?.banner_image || "",
            eventDate: collection?.event_date || "",
            uniqueIdEnabled: Boolean(collection?.unique_id_enabled),
            codePrefix: collection?.code_prefix || "",
            contributionAmount: existingNetAmount,
            platformFee: exPlatformFee,
            gatewayFee: exGatewayFee,
            totalFees: existingTotalFees > 0 ? existingTotalFees : 0,
            totalPaid: existingTotalPaid,
            participants,
            ticketSelections: existingTicketSelections,
            transactionRef: existingDeposit.payment_reference,
            status: existingDeposit.status,
            paidAt: existingDeposit.paid_at,
            channel: existingDeposit.channel,
            currency: existingDeposit.currency,
            payer: {
                name: existingDeposit.full_name,
                email: existingDeposit.email,
                phone: existingDeposit.phone_number,
            },
        };

        // Resend confirmation email exactly once
        try {
            const { data: contributorUpdated } = await supabase
                .from("deposits")
                .update({
                    contributor_confirmed_sent: true,
                    updated_at: new Date().toISOString(),
                })
                .eq("payment_reference", existingDeposit.payment_reference)
                .eq("contributor_confirmed_sent", false)
                .select()
                .single();

            if (contributorUpdated) {
                const receiptUrl = `${process.env.FRONTEND_URL}/receipts/${existingDeposit.id}`;
                await sendPaymentConfirmation(
                    existingDeposit.email,
                    existingDeposit.full_name,
                    collection?.title,
                    existingDeposit.amount,
                    existingDeposit.currency,
                    existingDeposit.payment_reference,
                    existingDeposit.paid_at,
                    existingDeposit.channel,
                    participants,
                    receiptUrl,
                    collection?.title
                );
            }
        } catch (e) {
            console.error("Contributor confirmation update error:", e?.message || e);
        }

        return res.status(200).json({
            message: "Payment already verified",
            payment: existingDeposit,
            contributor,
            collection,
            receiptData,
        });
    }

    try {
        const response = await axios.get(
            `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
            { headers: paystackHeaders }
        );

        const paystackData = response.data.data;

        const { data: deposit, error: depositError } = await supabase
            .from("deposits")
            .update({
                status: paystackData.status,
                paid_at: paystackData.paid_at ? new Date(paystackData.paid_at) : null,
                channel: paystackData.channel || null,
                currency: paystackData.currency || null,
                updated_at: new Date(),
            })
            .eq("payment_reference", reference)
            .select()
            .single();

        if (depositError) {
            return res.status(500).json({ error: depositError.message });
        }

        if (deposit && deposit.contributor_id && paystackData.status === "success") {
            // ── Step 1: Mark contribution as PAID first (wallet stats depend on this) ──
            const { data: collection } = await supabase
                .from("collections")
                .select("code_prefix")
                .eq("id", deposit.collection_id)
                .single();

            const { count } = await supabase
                .from("contributions")
                .select("id", { count: "exact", head: true })
                .eq("collection_id", deposit.collection_id)
                .eq("status", "paid");

            if (collection?.code_prefix) {
                const nextNumber = String((count || 0) + 1).padStart(3, "0");
                const uniqueCode = `${collection.code_prefix}${nextNumber}`;
                await supabase
                    .from("contributions")
                    .update({
                        status: "paid",
                        contributor_unique_code: uniqueCode,
                        payment_reference: deposit.payment_reference,
                        gross_amount: deposit.amount,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", deposit.contributor_id);
            } else {
                await supabase
                    .from("contributions")
                    .update({
                        status: "paid",
                        payment_reference: deposit.payment_reference,
                        gross_amount: deposit.amount,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", deposit.contributor_id);
            }

            // ── Step 2: Update wallet AFTER contribution is marked paid ──────────
            if (deposit.collection_id && deposit.amount > 0) {
                await updateWalletStats(deposit.collection_id, deposit.amount);
            }

            // Send contributor confirmation exactly once
            try {
                const { data: contributorUpdated } = await supabase
                    .from("deposits")
                    .update({
                        contributor_confirmed_sent: true,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("payment_reference", reference)
                    .eq("contributor_confirmed_sent", false)
                    .select()
                    .single();

                if (contributorUpdated) {
                    const { data: profile } = await supabase
                        .from("profiles")
                        .select("id, full_name, email")
                        .eq("id", deposit.contributor_id)
                        .single();

                    const { data: contributor } = await supabase
                        .from("contributions")
                        .select("*")
                        .eq("id", deposit.contributor_id)
                        .single();

                    const { data: coll } = await supabase
                        .from("collections")
                        .select("title")
                        .eq("id", deposit.collection_id)
                        .single();

                    const recipient = profile?.email || deposit.email;
                    const receiptUrl = `${process.env.FRONTEND_URL}/receipts/${deposit.id}`;
                    const participants = [
                        {
                            id: contributor?.id,
                            uniqueCode: contributor?.contributor_unique_code || null,
                            details: formatDetails(contributor?.contributor_information),
                        },
                    ];

                    await sendPaymentConfirmation(
                        recipient,
                        profile?.full_name || deposit.full_name,
                        coll?.title,
                        deposit.amount,
                        deposit.currency,
                        deposit.payment_reference,
                        deposit.paid_at,
                        deposit.channel,
                        participants,
                        receiptUrl,
                        coll?.title
                    ).catch((err) =>
                        console.error("Contributor email send error:", err?.message || err)
                    );
                }
            } catch (e) {
                console.error("Contributor confirmation update error:", e?.message || e);
            }

            // Notify organizer exactly once
            try {
                const { data: organizerUpdated } = await supabase
                    .from("deposits")
                    .update({
                        organizer_notified_sent: true,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("payment_reference", reference)
                    .eq("organizer_notified_sent", false)
                    .select()
                    .single();

                if (organizerUpdated) {
                    const { data: coll } = await supabase
                        .from("collections")
                        .select("id, title, user_id")
                        .eq("id", deposit.collection_id)
                        .single();

                    const { data: organizer } = await supabase
                        .from("profiles")
                        .select("id, full_name, email")
                        .eq("id", coll?.user_id)
                        .single();

                    await sendEmail({
                        to: organizer?.email,
                        subject: `Incoming Payment - ${coll?.title}`,
                        html: `<p>Hi ${organizer?.full_name}, you have received a payment of ${deposit.amount} ${deposit.currency} for "${coll?.title}". Reference: ${deposit.payment_reference}</p>`,
                    }).catch((err) =>
                        console.error("Organizer email send error:", err?.message || err)
                    );
                }
            } catch (e) {
                console.error("Organizer notification update error:", e?.message || e);
            }
        }

        const [{ data: contributor }, { data: collection }] = await Promise.all([
            supabase
                .from("contributions")
                .select("*")
                .eq("id", deposit.contributor_id)
                .single(),
            supabase
                .from("collections")
                .select("*")
                .eq("id", deposit.collection_id)
                .single(),
        ]);

        const participants = [
            {
                id: contributor?.id,
                uniqueCode: contributor?.contributor_unique_code || null,
                details: formatDetails(contributor?.contributor_information),
            },
        ];

        // Build fee breakdown for receipt
        const verCollType = collection?.collection_type || collection?.type || "fixed";
        const verFeeBearer = collection?.fee_bearer || "organizer";
        const verNetAmount = contributor?.amount || deposit.amount;
        const verTotalPaid = deposit.amount;
        const { platformFee: verPlatformFee, gatewayFee: verGatewayFee } =
            calculateFees(verNetAmount, verCollType, verFeeBearer);
        const verTotalFees = roundCurrency(verTotalPaid - verNetAmount);
        const verTicketSelections =
            contributor?.contributor_information?.[0]?._ticketSelections || [];

        const receiptData = {
            collectionTitle: collection?.title || "",
            collectionType: collection?.collection_type || collection?.type || "fixed",
            description: collection?.description || "",
            campaignSummary: collection?.campaign_summary || "",
            bannerUrl: collection?.banner_url || collection?.banner_image || "",
            eventDate: collection?.event_date || "",
            uniqueIdEnabled: Boolean(collection?.unique_id_enabled),
            codePrefix: collection?.code_prefix || "",
            contributionAmount: verNetAmount,
            platformFee: verPlatformFee,
            gatewayFee: verGatewayFee,
            totalFees: verTotalFees > 0 ? verTotalFees : 0,
            totalPaid: verTotalPaid,
            participants,
            ticketSelections: verTicketSelections,
            transactionRef: deposit.payment_reference,
            status: deposit.status,
            paidAt: deposit.paid_at,
            channel: deposit.channel,
            currency: deposit.currency,
            payer: {
                name: deposit.full_name,
                email: deposit.email,
                phone: deposit.phone_number,
            },
        };

        return res.status(200).json({
            message: "Payment verification complete",
            payment: deposit,
            contributor,
            collection,
            receiptData,
            paystack: paystackData,
        });
    } catch (error) {
        return res
            .status(500)
            .json({ error: error.response?.data?.message || error.message });
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

// Verify Paystack webhook signature
async function verifyPaystackSignature(req) {
    const payload = JSON.stringify(req.body);
    const signature = req.headers["x-paystack-signature"];

    if (crypto?.createHmac) {
        const hash = crypto
            .createHmac("sha512", PAYSTACK_SECRET_KEY)
            .update(payload)
            .digest("hex");
        return hash === signature;
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

// Handle Paystack webhook
export const handleWebhook = async (req, res) => {
    console.log("Webhook event received:", req.body?.event);

    const isValid = await verifyPaystackSignature(req);
    if (!isValid) {
        return res.status(403).json({ error: "Invalid signature" });
    }

    const event = req.body;

    if (event.event === "charge.success") {
        const reference = event.data.reference;
        console.log("Processing charge.success for reference:", reference);

        const { data: deposit, error: depositError } = await supabase
            .from("deposits")
            .select("*")
            .eq("payment_reference", reference)
            .single();

        if (depositError || !deposit) {
            console.error("Deposit not found:", reference);
            return res.status(200).send("Deposit not found");
        }

        // Already processed check happens AFTER we update the deposit.
        // This prevents the edge case where verifyPayment ran first (setting
        // deposit.status = "success"), causing the webhook to skip updateWalletStats.
        const alreadyProcessed = deposit.status === "success";

        if (!alreadyProcessed) {
            await supabase
                .from("deposits")
                .update({
                    paid_at: event.data.paid_at ? new Date(event.data.paid_at) : new Date(),
                    channel: event.data.channel || null,
                    currency: event.data.currency || "NGN",
                    status: event.data.status,
                    updated_at: new Date(),
                })
                .eq("id", deposit.id);
        }

        if (deposit.contributor_id) {
            // ── Step 1: Mark contribution PAID (wallet depends on this) ──────
            const { data: collection } = await supabase
                .from("collections")
                .select("code_prefix")
                .eq("id", deposit.collection_id)
                .single();

            const { count } = await supabase
                .from("contributions")
                .select("id", { count: "exact", head: true })
                .eq("collection_id", deposit.collection_id)
                .eq("status", "paid");

            if (collection?.code_prefix) {
                const nextNumber = String((count || 0) + 1).padStart(3, "0");
                const uniqueCode = `${collection.code_prefix}${nextNumber}`;
                await supabase
                    .from("contributions")
                    .update({
                        status: "paid",
                        contributor_unique_code: uniqueCode,
                        payment_reference: deposit.payment_reference,
                        gross_amount: deposit.amount,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", deposit.contributor_id);
            } else {
                await supabase
                    .from("contributions")
                    .update({
                        status: "paid",
                        payment_reference: deposit.payment_reference,
                        gross_amount: deposit.amount,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", deposit.contributor_id);
            }
        }

        // ── Step 2: Update wallet AFTER contribution is marked paid ──────────
        await updateWalletStats(deposit.collection_id, deposit.amount);

        if (alreadyProcessed) {
            console.log("Deposit already processed by verifyPayment — wallet re-synced:", reference);
            return res.status(200).send("Already processed — wallet re-synced");
        }

        // Send contributor confirmation exactly once
        try {
            const { data: contributorUpdated } = await supabase
                .from("deposits")
                .update({
                    contributor_confirmed_sent: true,
                    updated_at: new Date().toISOString(),
                })
                .eq("payment_reference", reference)
                .eq("contributor_confirmed_sent", false)
                .select()
                .single();

            if (contributorUpdated) {
                const { data: profile } = await supabase
                    .from("profiles")
                    .select("id, full_name, email")
                    .eq("id", deposit.contributor_id)
                    .single();

                const { data: contributor } = await supabase
                    .from("contributions")
                    .select("*")
                    .eq("id", deposit.contributor_id)
                    .single();

                const { data: collection } = await supabase
                    .from("collections")
                    .select("title")
                    .eq("id", deposit.collection_id)
                    .single();

                const recipient = profile?.email || deposit.email;
                const receiptUrl = `${process.env.FRONTEND_URL}/receipts/${deposit.id}`;
                const participants = [
                    {
                        id: contributor?.id,
                        uniqueCode: contributor?.contributor_unique_code || null,
                        details: formatDetails(contributor?.contributor_information),
                    },
                ];

                await sendPaymentConfirmation(
                    recipient,
                    profile?.full_name || deposit.full_name,
                    collection?.title,
                    deposit.amount,
                    deposit.currency,
                    deposit.payment_reference,
                    deposit.paid_at,
                    deposit.channel,
                    participants,
                    receiptUrl,
                    collection?.title
                ).catch((err) =>
                    console.error("Contributor email send error:", err?.message || err)
                );
            }
        } catch (e) {
            console.error("Contributor confirmation update error:", e?.message || e);
        }

        // Notify organizer exactly once
        try {
            const { data: organizerUpdated } = await supabase
                .from("deposits")
                .update({
                    organizer_notified_sent: true,
                    updated_at: new Date().toISOString(),
                })
                .eq("payment_reference", reference)
                .eq("organizer_notified_sent", false)
                .select()
                .single();

            if (organizerUpdated) {
                const { data: collection } = await supabase
                    .from("collections")
                    .select("id, title, user_id")
                    .eq("id", deposit.collection_id)
                    .single();

                const { data: organizer } = await supabase
                    .from("profiles")
                    .select("id, full_name, email")
                    .eq("id", collection?.user_id)
                    .single();

                await sendEmail({
                    to: organizer?.email,
                    subject: `Incoming Payment - ${collection?.title}`,
                    html: `<p>Hi ${organizer?.full_name}, you have received a payment of ${deposit.amount} ${deposit.currency} for "${collection?.title}". Reference: ${deposit.payment_reference}</p>`,
                }).catch((err) =>
                    console.error("Organizer email send error:", err?.message || err)
                );
            }
        } catch (e) {
            console.error("Organizer notification update error:", e?.message || e);
        }

        console.log(`✅ Webhook processed | Collection: ${deposit.collection_id} | ₦${deposit.amount}`);
    }

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
            collectionTitle
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
