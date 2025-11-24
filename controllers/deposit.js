import axios from "axios";
import { supabase } from "../utils/client.js";
import { createContribution } from "./contribution.js";
import crypto from "node:crypto";
import { error } from "node:console";
import { sendEmail } from "../services/emailService.js";
import { sendPaymentInitialize, sendPaymentConfirmation } from "../utils/emailHelper.js";

/**
 * Safely update collection stats after a successful contribution/payment.
 * Handles edge cases: duplicate payments, missing collection, zero/negative amount.
 */
function calculateFees(amount, feeBearer = "organizer") {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return { platformFee: 0, paymentGatewayFee: 0, totalFees: 0, totalPayable: parsedAmount };
    }

    let kolektoFee;

    if (parsedAmount < 1000) {
        kolektoFee = 30;
    } else if (parsedAmount <= 5000) {
        kolektoFee = 50;
    } else if (parsedAmount <= 10000) {
        kolektoFee = 100;
    } else if (parsedAmount <= 20000) {
        kolektoFee = 200;
    } else {
        kolektoFee = Math.min(parsedAmount * 0.01, 2000);
    }

    let gatewayFee = Math.min(parsedAmount * 0.015, 2000);
    const totalFees = kolektoFee + gatewayFee;

    return {
        platformFee: kolektoFee,
        paymentGatewayFee: gatewayFee,
        totalFees,
        totalPayable: feeBearer === "contributor" ? parsedAmount + totalFees : parsedAmount,
    };
}

/**
 * Safely update wallet stats after a successful deposit/payment.
 * Now supports pending balance (T+1 settlement).
 */
export async function updateWalletStats(collectionId, amount) {
    if (!collectionId || !amount || amount <= 0) return;
    console.log(collectionId, amount, '<< updating wallet stats...');

    const [walletResult, collectionResult] = await Promise.all([
        supabase.from("wallets").select("*").eq("collection_id", collectionId).single(),
        supabase.from("collections").select("fee_bearer, type").eq("id", collectionId).single()
    ]);

    const { data: wallet, error: walletError } = walletResult;
    const { data: collection, error: collectionError } = collectionResult;
    if (walletError || !wallet || collectionError || !collection) return;

    let netToAdd = Number(amount);
    console.log(wallet.fee_breakdown.tiers, collection, '<< wallet and collection details');

    if (collection.type === "fixed") {
        const fees = Number(wallet?.fee_breakdown?.totalFees || 0);
        netToAdd = Number(amount) - fees;
        if (netToAdd < 0) netToAdd = 0;
    } else if (collection.type === "tiered") {
        const tierObj = wallet.fee_breakdown?.tiers?.find(t => t.totalPayable === netToAdd);
        const tierFees = Number(tierObj?.totalFees || 0);
        netToAdd = Math.max(Number(amount) - tierFees, 0);
    } else if (collection.type === "fundraising") {
        const fees = 1.025;
        netToAdd = parseFloat((amount / fees).toFixed(2));
    }

    const newGrossPayment = Number(wallet.gross_payment || 0) + Number(amount);
    const newNetPayment = Number(wallet.net_payment || 0) + netToAdd;
    const newPendingBalance = Number(wallet.pending_balance || 0) + netToAdd;
    const newLedgerBalance = Number(wallet.ledger_balance || 0) + netToAdd;

    await supabase
        .from("wallets")
        .update({
            gross_payment: newGrossPayment,
            net_payment: newNetPayment,
            pending_balance: newPendingBalance,
            ledger_balance: newLedgerBalance,
            updated_at: new Date()
        })
        .eq("id", wallet.id);

    const { data: currentCollection } = await supabase
        .from("collections")
        .select("total_contributions")
        .eq("id", collectionId)
        .single();

    await supabase
        .from("collections")
        .update({
            total_contributions: (currentCollection?.total_contributions || 0) + 1
        })
        .eq("id", collectionId);

    console.log('✅ Wallet stats updated (pending balance only, T+1 settlement applies)');
}

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = "https://api.paystack.co";
const PAYMENT_BASE_URL = process.env.PAYMENT_BASE_URL;

const paystackHeaders = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
};

// Initialize a payment (get payment link)
export const initializePayment = async (req, res) => {
    const {
        fullName,
        email,
        phoneNumber,
        amount,
        collectionId,
        callback_url
    } = req.body;

    if (!email || !amount || !fullName || !collectionId) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        const contributionResult = await createContribution(req, res);
        if (res.headersSent) return;

        const contributor = contributionResult?.contributor;
        if (!contributor?.id) {
            return res.status(500).json({ error: "Failed to create contribution record" });
        }

        const contributorId = contributor.id;

        const paystackRes = await axios.post(
            `${PAYSTACK_BASE_URL}/transaction/initialize`,
            {
                email,
                amount: Math.round(contributor.amount * 100),
                callback_url,
                metadata: {
                    fullName,
                    phoneNumber,
                    contributorId,
                    collectionId,
                },
            },
            { headers: paystackHeaders }
        );

        const paystackData = paystackRes.data.data;

        const [walletResult, collectionResult] = await Promise.all([
            supabase.from("wallets").select("*").eq("collection_id", collectionId).single(),
            supabase.from("collections").select("fee_bearer, type, title").eq("id", collectionId).single()
        ]);

        const { data: wallet, error: walletError } = walletResult;
        const { data: collection, error: collectionError } = collectionResult;
        if (walletError || !wallet || collectionError || !collection) {
            return res.status(500).json({ error: "Failed to fetch collection/wallet details" });
        }

        let netToAdd = Number(amount);
        if (collection.type === "fixed") {
            const fees = Number(wallet?.fee_breakdown?.totalFees || 0);
            netToAdd = Number(amount) - fees;
            if (netToAdd < 0) netToAdd = 0;
        } else if (collection.type === "tiered") {
            const tierObj = wallet.fee_breakdown?.tiers?.find(t => t.totalPayable === netToAdd);
            const tierFees = Number(tierObj?.totalFees || 0);
            netToAdd = Math.max(Number(amount) - tierFees, 0);
        } else if (collection.type === "fundraising") {
            const fees = 1.025;
            netToAdd = parseFloat((amount / fees).toFixed(2));
        }

        const { data: payment, error: paymentError } = await supabase
            .from("deposits")
            .insert([
                {
                    full_name: fullName,
                    email,
                    amount: contributor.amount,
                    phone_number: phoneNumber,
                    currency: contributor.currency || "NGN",
                    net_amount: netToAdd,
                    status: "pending",
                    payment_reference: paystackData.reference,
                    authorization_url: paystackData.authorization_url,
                    contributor_id: contributorId,
                    wallet_id: wallet.id,
                    collection_id: collectionId,
                    init_email_sent: false,
                    contributor_confirmed_sent: false,
                    organizer_notified_sent: false
                },
            ])
            .select()
            .single();

        if (paymentError) {
            return res.status(500).json({ error: "Failed to create payment record" });
        }

        // 5️⃣ Send payment initialization email (with contributor details)
        try {
            const contributorDetails = contributor.contributor_information
                ? contributor.contributor_information.flatMap(obj =>
                    Object.entries(obj).map(([label, value]) => ({
                        label: label.charAt(0).toUpperCase() + label.slice(1).replace(/_/g, ' '),
                        value: value
                    }))
                )
                : [];

            const participants = [
                {
                    id: contributorId,
                    details: contributorDetails,
                    uniqueCode: contributor.contributor_unique_code || null
                }
            ];

            await sendPaymentInitialize(
                email,
                fullName,
                collection.title,
                contributor.amount,
                contributor.currency || 'NGN',
                paystackData.authorization_url,
                paystackData.reference,
                participants,
                new Date().toISOString()
            );

            await supabase
                .from("deposits")
                .update({ init_email_sent: true, updated_at: new Date().toISOString() })
                .eq("id", payment.id);

            console.log("✅ Payment initialization email sent");
        } catch (err) {
            console.error("Email send error:", err?.message || err);
        }

        res.status(200).json({
            message: "Payment initialized successfully",
            authorizationUrl: paystackData.authorization_url,
            reference: paystackData.reference,
        });

        (async () => {
            try {
                await supabase
                    .from("contributions")
                    .update({ payment_id: payment.id })
                    .eq("id", contributorId);
            } catch (err) {
                console.error("Background update failed:", err.message);
            }
        })();

    } catch (error) {
        console.error("Error in initializePayment:", error);
        return res.status(500).json({
            error: error.response?.data?.message || error.message,
        });
    }
};

const formatDetails = (infoArr) => {
    if (!Array.isArray(infoArr)) return [];
    return infoArr.flatMap(obj =>
        Object.entries(obj).map(([label, value]) => ({
            label: label.trim(),
            value: value
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
        return res.status(404).json({ error: "Deposit not found" });
    }
    console.log(existingDeposit, 'outside');

    // If already successful, do not verify again
    if (existingDeposit.status === "success") {
        const [{ data: contributor }, { data: collection }] = await Promise.all([
            supabase.from("contributions").select("*").eq("id", existingDeposit.contributor_id).single(),
            supabase.from("collections").select("*").eq("id", existingDeposit.collection_id).single()
        ]);
        console.log('already verified', existingDeposit);

        const participants = [
            {
                id: contributor?.id,
                uniqueCode: contributor?.contributor_unique_code || null,
                details: formatDetails(contributor?.contributor_information)
            }
        ];

        const receiptData = {
            collectionTitle: collection?.title,
            amountPaid: existingDeposit.amount,
            participants,
            transactionRef: existingDeposit.payment_reference,
            status: existingDeposit.status,
            paidAt: existingDeposit.paid_at,
            channel: existingDeposit.channel,
            currency: existingDeposit.currency,
            payer: {
                name: existingDeposit.full_name,
                email: existingDeposit.email,
                phone: existingDeposit.phone_number
            }
        };

        // --- Send contributor confirmation exactly once (using new template) ---
        try {
            const { data: contributorUpdated } = await supabase
                .from("deposits")
                .update({ contributor_confirmed_sent: true, updated_at: new Date().toISOString() })
                .eq("payment_reference", existingDeposit.payment_reference)
                .eq("contributor_confirmed_sent", false)
                .select()
                .single();

            if (contributorUpdated) {
                const { data: profile } = await supabase
                    .from("profiles")
                    .select("id, full_name, email")
                    .eq("id", existingDeposit.contributor_id)
                    .single();

                const recipient = profile?.email || existingDeposit.email;
                const receiptUrl = `${process.env.FRONTEND_URL}/receipts/${existingDeposit.id}`;

                try {
                    await sendPaymentConfirmation(
                        recipient,
                        profile?.full_name || existingDeposit.full_name,
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
                    console.log("✅ Payment confirmation email sent (existing payment)");
                } catch (mailErr) {
                    console.error("Contributor email send error:", mailErr?.message || mailErr);
                }
            }
        } catch (e) {
            console.error("Contributor confirmation update error:", e?.message || e);
        }

        return res.status(200).json({
            message: "Payment already verified",
            payment: existingDeposit,
            contributor,
            collection,
            receiptData
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
                updated_at: new Date()
            })
            .eq("payment_reference", reference)
            .select()
            .single();

        if (depositError) {
            return res.status(500).json({ error: depositError.message });
        }
        console.log(paystackData, 'paystacj data');

        if (deposit && deposit.contributor_id && paystackData.status === "success") {
            if (deposit.collection_id && deposit.amount > 0) {
                console.log('Updating wallet stats...', deposit.collection_id, deposit.amount);
                await updateWalletStats(deposit.collection_id, deposit.amount);
            }

            // Fetch the collection to check for code_prefix
            const { data: collection } = await supabase
                .from("collections")
                .select("code_prefix, title, collection_id")
                .eq("id", deposit.collection_id)
                .single();

            // Fetch the number of contributors for this collection
            const { count, error: countError } = await supabase
                .from("contributions")
                .select("id", { count: "exact", head: true })
                .eq("collection_id", deposit.collection_id)
                .eq("status", "paid");
            console.log(collection, '---col');

            if (collection && collection.code_prefix) {
                // Generate next sequence number, padded to 3 digits
                const nextNumber = String((count || 0) + 1).padStart(3, '0');
                const uniqueCode = `${collection.code_prefix}_${nextNumber}`;
                await supabase
                    .from("contributions")
                    .update({
                        status: "paid",
                        contributor_unique_code: uniqueCode
                    })
                    .eq("id", deposit.contributor_id);
            } else {
                await supabase
                    .from("contributions")
                    .update({ status: "paid" })
                    .eq("id", deposit.contributor_id);
            }

            // --- Send contributor confirmation exactly once (using new template) ---
            try {
                const { data: contributorUpdated } = await supabase
                    .from("deposits")
                    .update({ contributor_confirmed_sent: true, updated_at: new Date().toISOString() })
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

                    const recipient = profile?.email || deposit.email;
                    const receiptUrl = `${process.env.FRONTEND_URL}/receipts/${deposit.id}`;

                    const participants = [
                        {
                            id: contributor?.id,
                            uniqueCode: contributor?.contributor_unique_code || null,
                            details: formatDetails(contributor?.contributor_information)
                        }
                    ];

                    try {
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
                        );
                        console.log("✅ Payment confirmation email sent to contributor");
                    } catch (mailErr) {
                        console.error("Contributor email send error:", mailErr?.message || mailErr);
                    }
                }
            } catch (e) {
                console.error("Contributor confirmation update error:", e?.message || e);
            }

            // --- Notify organizer exactly once ---
            try {
                const { data: organizerUpdated } = await supabase
                    .from("deposits")
                    .update({ organizer_notified_sent: true, updated_at: new Date().toISOString() })
                    .eq("payment_reference", reference)
                    .eq("organizer_notified_sent", false)
                    .select()
                    .single();

                if (organizerUpdated) {
                    const { data: collection } = await supabase
                        .from("collections")
                        .select("id, title, organizer_id")
                        .eq("id", deposit.collection_id)
                        .single();

                    const { data: organizer } = await supabase
                        .from("profiles")
                        .select("id, full_name, email")
                        .eq("id", collection?.organizer_id)
                        .single();

                    try {
                        await sendEmail({
                            to: organizer?.email,
                            subject: `Incoming Payment - ${collection?.title}`,
                            html: `<p>Hi ${organizer?.full_name}, you have received a payment of ${deposit.amount} ${deposit.currency} for "${collection?.title}". Reference: ${deposit.payment_reference}</p>`
                        });
                        console.log("✅ Organizer notification sent to organizer");
                    } catch (mailErr) {
                        console.error("Organizer email send error:", mailErr?.message || mailErr);
                    }
                }
            } catch (e) {
                console.error("Organizer notification update error:", e?.message || e);
            }
        }

        const [{ data: contributor }, { data: collection }] = await Promise.all([
            supabase.from("contributions").select("*").eq("id", deposit.contributor_id).single(),
            supabase.from("collections").select("*").eq("id", deposit.collection_id).single()
        ]);

        const participants = [
            {
                id: contributor?.id,
                uniqueCode: contributor?.contributor_unique_code || null,
                details: formatDetails(contributor?.contributor_information)
            }
        ];

        const receiptData = {
            collectionTitle: collection?.title,
            amountPaid: deposit.amount,
            participants,
            transactionRef: deposit.payment_reference,
            status: deposit.status,
            paidAt: deposit.paid_at,
            channel: deposit.channel,
            currency: deposit.currency,
            payer: {
                name: deposit.full_name,
                email: deposit.email,
                phone: deposit.phone_number
            }
        };

        return res.status(200).json({
            message: "Payment verification complete",
            payment: deposit,
            contributor,
            collection,
            receiptData,
            paystack: paystackData
        });
    } catch (error) {
        return res.status(500).json({ error: error.response?.data?.message || error.message });
    }
};

// List all Paystack transactions
export const listTransactions = async (req, res) => {
    try {
        const response = await axios.get(
            `${PAYSTACK_BASE_URL}/transaction`,
            { headers: paystackHeaders }
        );
        return res.status(200).json(response.data);
    } catch (error) {
        return res.status(500).json({ error: error.response?.data?.message || error.message });
    }
};

// Fetch a single transaction by ID
export const fetchTransaction = async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: "Transaction ID is required" });
    }
    try {
        const response = await axios.get(
            `${PAYSTACK_BASE_URL}/transaction/${id}`,
            { headers: paystackHeaders }
        );
        return res.status(200).json(response.data);
    } catch (error) {
        return res.status(500).json({ error: error.response?.data?.message || error.message });
    }
};

// Helper: Verify Paystack signature
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
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
    return hashHex === signature;
}

// Handle webhook
export const handleWebhook = async (req, res) => {
    console.log("Webhook event received:", req.body);

    const isValid = await verifyPaystackSignature(req);
    if (!isValid) {
        return res.status(403).json({ error: "Invalid signature" });
    }

    const event = req.body;

    if (event.event === "charge.success") {
        const reference = event.data.
            console.log("Processing charge.success for rereference;ference:", reference);

        const { data: deposit, error: depositError } = await supabase
            .from("deposits")
            .select("*")
            .eq("payment_reference", reference)
            .single();
        console.log(deposit, 'webhook depo');

        if (depositError || !deposit) {
            console.error("Deposit not found:", reference);
            return res.status(200).send("Deposit not found");
        }

        if (deposit.status === "success") {
            console.log("Deposit already processed:", reference);
            return res.status(200).send("Already processed");
        }

        await supabase
            .from("deposits")
            .update({
                paid_at: event.data.paid_at ? new Date(event.data.paid_at) : new Date(),
                channel: event.data.channel || null,
                currency: event.data.currency || 'NGN',
                status: event.data.status,
                updated_at: new Date(),
            })
            .eq("id", deposit.id);

        if (deposit.contributor_id) {
            const { data: collection } = await supabase
                .from("collections")
                .select("code_prefix, title, collection_id")
                .eq("id", deposit.collection_id)
                .single();

            const { count } = await supabase
                .from("contributions")
                .select("id", { count: "exact", head: true })
                .eq("collection_id", deposit.collection_id)
                .eq("status", "paid");

            console.log(collection, '---col');
            if (collection && collection.code_prefix) {
                const nextNumber = String((count || 0) + 1).padStart(3, "0");
                const uniqueCode = `${collection.code_prefix}_${nextNumber}`;

                await supabase
                    .from("contributions")
                    .update({
                        status: "paid",
                        contributor_unique_code: uniqueCode,
                    })
                    .eq("id", deposit.contributor_id);
            } else {
                await supabase
                    .from("contributions")
                    .update({ status: "paid" })
                    .eq("id", deposit.contributor_id);
            }
        }

        await updateWalletStats(deposit.collection_id, deposit.amount);

        // --- Send contributor confirmation exactly once (using new template) ---
        try {
            const { data: contributorUpdated } = await supabase
                .from("deposits")
                .update({ contributor_confirmed_sent: true, updated_at: new Date().toISOString() })
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
                        details: formatDetails(contributor?.contributor_information)
                    }
                ];

                try {
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
                    );
                    console.log("✅ Payment confirmation email sent via webhook");
                } catch (mailErr) {
                    console.error("Contributor email send error:", mailErr?.message || mailErr);
                }
            }
        } catch (e) {
            console.error("Contributor confirmation update error:", e?.message || e);
        }

        // --- Notify organizer exactly once ---
        try {
            const { data: organizerUpdated } = await supabase
                .from("deposits")
                .update({ organizer_notified_sent: true, updated_at: new Date().toISOString() })
                .eq("payment_reference", reference)
                .eq("organizer_notified_sent", false)
                .select()
                .single();

            if (organizerUpdated) {
                const { data: collection } = await supabase
                    .from("collections")
                    .select("id, title, organizer_id")
                    .eq("id", deposit.collection_id)
                    .single();

                const { data: organizer } = await supabase
                    .from("profiles")
                    .select("id, full_name, email")
                    .eq("id", collection?.id)
                    .single();

                try {
                    await sendEmail({
                        to: organizer?.email,
                        subject: `Incoming Payment - ${collection?.title}`,
                        html: `<p>Hi ${organizer?.full_name}, you have received a payment of ${deposit.amount} ${deposit.currency} for "${collection?.title}". Reference: ${deposit.payment_reference}</p>`
                    });
                    console.log("✅ Organizer notification sent via webhook");
                } catch (mailErr) {
                    console.error("Organizer email send error:", mailErr?.message || mailErr);
                }
            }
        } catch (e) {
            console.error("Organizer notification update error:", e?.message || e);
        }

        console.log(`✅ Deposit confirmed | Collection: ${deposit.collection_id} | ₦${deposit.amount}`);
    }

    res.status(200).send("Webhook received");
};

export default {
    initializePayment,
    verifyPayment,
    listTransactions,
    fetchTransaction,
    handleWebhook
};