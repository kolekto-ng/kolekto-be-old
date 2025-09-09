import axios from "axios";
import { supabase } from "../utils/client.js";
import { createContribution } from "./contribution.js";
// import { updateCollectionStats } from "../utils/collectionStats.js";

/**
 * Safely update collection stats after a successful contribution/payment.
 * Handles edge cases: duplicate payments, missing collection, zero/negative amount.
 *//**
* Calculate fees based on the new fee structure from createCollection
*/
function calculateFees(amount, feeBearer = "organizer") {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return { platformFee: 0, paymentGatewayFee: 0, totalFees: 0, totalPayable: parsedAmount };
    }

    let kolektoFee;

    // Same fee structure as in createCollection
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
 * Handles edge cases: duplicate payments, missing wallet, zero/negative amount.
 */
export async function updateWalletStats(collectionId, amount) {
    if (!collectionId || !amount || amount <= 0) return;
    console.log(collectionId, amount, '<< updating wallet stats...');

    // Fetch both wallet and collection data in parallel
    const [walletResult, collectionResult] = await Promise.all([
        supabase.from("wallets").select("*").eq("collection_id", collectionId).single(),
        supabase.from("collections").select("fee_bearer, type").eq("id", collectionId).single()
    ]);

    const { data: wallet, error: walletError } = walletResult;
    const { data: collection, error: collectionError } = collectionResult;

    if (walletError || !wallet || collectionError || !collection) return;

    let netToAdd = Number(amount);
    console.log(wallet.fee_breakdown.tiers, collection, '<< wallet and collection details');

    // If organizer pays fees, deduct them from the net amount
    if (collection.type === "fixed") {
        const fees = Number(wallet?.fee_breakdown?.totalFees || 0);

        if (collection.fee_bearer === "contributor") {
            // contributor already covered fees, so wallet gets full amount
            netToAdd = Number(amount) - fees;;
            console.log(netToAdd, '<< net to add for contributor pays fees');

        } else {
            // organizer covers fees, deduct from wallet
            netToAdd = Number(amount) - fees;
            if (netToAdd < 0) netToAdd = 0;
        }
    } else if (collection.type === "tired") {
        // Tiered
        console.log(wallet.fee_breakdown, '<< wallet tiers');

        const tierObj = wallet.fee_breakdown?.tiers?.find(
            t => t.totalPayable === netToAdd
        );

        console.log(tierObj, '<< this is the tier object');


        const tierFees = Number(tierObj?.totalFees || 0);

        if (collection.fee_bearer === "contributor") {
            // Contributor paid: tierAmount + fees
            netToAdd = Number(amount) - tierFees;
            console.log(netToAdd, '<< net to add for contributor pays fees');

        } else {
            // Organizer pays: fees deducted from wallet
            netToAdd = Number(amount) - tierFees;
            if (netToAdd < 0) netToAdd = 0;
        }
    }

    if (collection.type === "fundraising") {
        const fees = 0.025
        netToAdd = Number(amount) - (amount * fees);
        console.log(netToAdd, '<< net to add for contributor pays fees');
        if (netToAdd < 0) netToAdd = 0;
    }

    // ✅ Correct use of grossToAdd and netToAdd
    const newGrossPayment = Number(wallet.gross_payment || 0) + Number(amount);
    const newNetPayment = Number(wallet.net_payment || 0) + netToAdd;
    const newAvailableBalance = Number(wallet.available_balance || 0) + netToAdd;
    const newLedgerBalance = Number(wallet.ledger_balance || 0) + netToAdd;


    // Update wallet
    await supabase
        .from("wallets")
        .update({
            gross_payment: newGrossPayment,
            net_payment: newNetPayment,
            available_balance: newAvailableBalance,
            ledger_balance: newLedgerBalance
        })
        .eq("id", wallet.id);

    // Update total contributions in collection
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
}

// Initialize Paystack secret key from environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = "https://api.paystack.co";
const PAYMENT_BASE_URL = process.env.PAYMENT_BASE_URL;

// Helper to set headers
const paystackHeaders = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
};

// Initialize a payment (get payment link)
export const initializePayment = async (req, res) => {
    const { fullName, email, phoneNumber, amount, collectionId, callback_url } = req.body;

    if (!email || !amount || !fullName || !collectionId) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    let contributorId = null;
    let paymentId = null;

    try {
        // 1. Create a contribution record
        const contributionResult = await createContribution(req, res);

        if (res.headersSent) return;
        console.log(amount, '<< amount in initializePayment', contributionResult);

        const contributor = contributionResult?.contributor;
        console.log(contributor, '<< this is the contributor');

        contributorId = contributor?.id;

        if (!contributorId) {
            return res.status(500).json({ error: "Failed to create contribution record" });
        }

        // 2. Initialize payment with Paystack
        const response = await axios.post(
            `${PAYSTACK_BASE_URL}/transaction/initialize`,
            {
                email,
                amount: Math.round(contributor.amount * 100),
                callback_url: callback_url, // Your callback URL
                metadata: {
                    fullName,
                    phoneNumber,
                    ampunt: contributor.amount,
                    contributorId,
                    collectionId,
                },
            },
            { headers: paystackHeaders }
        );

        const paystackData = response.data.data;

        // 3. Save payment record in Supabase
        const { data: wallet } = await supabase
            .from("wallets")
            .select("id")
            .eq("collection_id", collectionId)
            .single();



        const { data: payment, error: depositsError } = await supabase
            .from("deposits")
            .insert([{
                full_name: fullName,
                email,
                phone_number: phoneNumber,
                amount: contributor.amount,
                status: "pending",
                payment_reference: paystackData.reference,
                access_code: paystackData.access_code, // Save access_code
                authorization_url: paystackData.authorization_url, // Save authorization_url
                contributor_id: contributorId,
                wallet_id: wallet.id,
                collection_id: collectionId,
            }])
            .select()
            .single();

        if (depositsError) {
            // Rollback: delete the contribution
            await supabase.from("contributions").delete().eq("id", contributorId);
            return res.status(500).json({ error: depositsError.message });
        }
        paymentId = payment.id;

        // 4. Optionally update contributor with payment reference
        const { error: updateError } = await supabase
            .from("contributions")
            .update({ payment_id: paymentId })
            .eq("id", contributorId);

        if (updateError) {
            // Rollback: delete both payment and contribution
            await supabase.from("deposits").delete().eq("id", depositId);
            await supabase.from("contributions").delete().eq("id", contributorId);
            return res.status(500).json({ error: updateError.message });
        }

        // 5. Respond with Paystack payment link
        res.status(200).json({
            message: "Payment initialized successfully",
            authorizationUrl: paystackData.authorization_url,
            reference: paystackData.reference,
        });
    } catch (error) {
        // Rollback: delete any created records if IDs exist
        if (paymentId) {
            await supabase.from("deposits").delete().eq("id", depositId);
        }
        if (contributorId) {
            await supabase.from("contributions").delete().eq("id", contributorId);
        }
        console.error("Error in initializePayment:", error);
        return res.status(500).json({ error: error.response?.data?.message || error.message });
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

    // 1. Fetch payment by reference
    const { data: existingDeposit, error: fetchError } = await supabase
        .from("deposits")
        .select("*")
        .eq("payment_reference", reference)
        .single();

    if (fetchError || !existingDeposit) {
        return res.status(404).json({ error: "deposit not found" });
    }

    // 2. If already successful, do not verify again
    if (existingDeposit.status === "success") {
        // Fetch contributor and collection for response
        const [{ data: contributor }, { data: collection }] = await Promise.all([
            supabase.from("contributions").select("*").eq("id", existingDeposit.contributor_id).single(),
            supabase.from("collections").select("*").eq("id", existingDeposit.collection_id).single()
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
        }

        return res.status(200).json({
            message: "Payment already verified",
            payment: existingDeposit,
            contributor,
            collection, receiptData
        });
    }

    try {
        // 3. Verify with Paystack
        const response = await axios.get(
            `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
            { headers: paystackHeaders }
        );

        const paystackData = response.data.data;

        // 4. Update payment status in your DB
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

        // Optionally update contribution status
        if (deposit && deposit.contributor_id && paystackData.status === "success") {

            // --- Update collection stats here ---
            if (deposit.collection_id && deposit.amount > 0) {
                console.log('updating wallet stats...', deposit.collection_id, deposit.amount);
                console.log(deposit.amount, 'deposit amo');

                await updateWalletStats(deposit.collection_id, deposit.amount);
            }

            // Fetch the collection to check for code_prefix
            const { data: collection } = await supabase
                .from("collections")
                .select("code_prefix")
                .eq("id", deposit.collection_id)
                .single();

            // Fetch the number of contributors for this collection
            const { count, error: countError } = await supabase
                .from("contributions")
                .select("id", { count: "exact", head: true })
                .eq("collection_id", deposit.collection_id)
                .eq("status", "paid");

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
        }

        // Fetch contributor and collection for response
        const [{ data: contributor }, { data: collection }] = await Promise.all([
            supabase.from("contributions").select("*").eq("id", deposit.contributor_id).single(),
            supabase.from("collections").select("*").eq("id", deposit.collection_id).single()
        ]);

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
        }

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

// Handle Paystack webhook (for payment events)
import crypto from "node:crypto"; // Ensures Node built-in is used

// Helper: Verify Paystack signature (works in Node and edge runtimes)
async function verifyPaystackSignature(req) {
    const payload = JSON.stringify(req.body);
    const signature = req.headers["x-paystack-signature"];

    // Try Node.js crypto first
    if (crypto?.createHmac) {
        const hash = crypto
            .createHmac("sha512", PAYSTACK_SECRET_KEY)
            .update(payload)
            .digest("hex");
        return hash === signature;
    }

    // Fallback: Web Crypto API (for edge/serverless runtimes)
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

export const handleWebhook = async (req, res) => {
    console.log("webhook event received: deposit", req.body);

    const isValid = await verifyPaystackSignature(req);
    if (!isValid) {
        return res.status(403).json({ error: "Invalid signature" });
    }

    const event = req.body;

    // Only handle successful charges
    if (event.event === "charge.success") {
        const reference = event.data.reference;
        console.log(reference, '<< webhook reference');

        // Fetch payment by reference
        const { data: deposit, error } = await supabase
            .from("deposits")
            .select("*")
            .eq("payment_reference", reference)
            .single();

        if (error || !deposit) {
            return res.status(404).json({ error: "Payment not found" });
        }

        // If already marked as success, do nothing
        if (deposit.status === "success") {
            return res.status(200).send("Already processed");
        }

        // Update deposit status
        await supabase
            .from("deposits")
            .update({ status: "success", updated_at: new Date() })
            .eq("id", deposit.id);

        // Update contribution status
        if (deposit.contributor_id) {
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

            if (collection && collection.code_prefix) {
                const nextNumber = String((count || 0) + 1).padStart(3, "0");
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
        }

        // Update collection stats
        await updateWalletStats(deposit.collection_id, deposit.amount);
    }

    // Always respond quickly to Paystack
    res.status(200).send("Webhook received");
};

// Export all controllers
export default {
    initializePayment,
    verifyPayment,
    listTransactions,
    fetchTransaction,
    handleWebhook
};