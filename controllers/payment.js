import axios from "axios";
import { supabase } from "../utils/client.js";
import { createContribution } from "./contribution.js";
// import { updateCollectionStats } from "../utils/collectionStats.js";

/**
 * Safely update collection stats after a successful contribution/payment.
 * Handles edge cases: duplicate payments, missing collection, zero/negative amount.
 */
export async function updateCollectionStats(collectionId, amount) {
    if (!collectionId || !amount || amount <= 0) return;

    // Fetch the collection
    const { data: collection, error: collectionError } = await supabase
        .from("collections")
        .select("*")
        .eq("id", collectionId)
        .single();

    if (collectionError || !collection) return;

    // Determine net amount to add based on fee_bearer and amountbreakdown
    let netToAdd = Number(amount);
    if (collection.fee_bearer === "organizer" && collection.amount_breakdown) {
        // Use per-contribution fee calculation if available
        const { totalFees } = collection.amount_breakdown;
        if (typeof totalFees === "number") {
            netToAdd = Number(amount) - Number(totalFees);
            if (netToAdd < 0) netToAdd = 0;
        }
    }

    // Calculate new values
    const newTotalContributions = (collection.total_contributions || 0) + 1;
    const newGrossPayment = Number(collection.gross_payment || 0) + Number(amount);
    const newNetPayment = Number(collection.net_payment || 0) + netToAdd;
    const newBalance = Number(collection.balance || 0) + netToAdd;

    await supabase
        .from("collections")
        .update({
            total_contributions: newTotalContributions,
            gross_payment: newGrossPayment,
            net_payment: newNetPayment,
            balance: newBalance
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

    console.log(`Initializing payment for ${fullName} (${email}) with amount: ${amount} for collection ID: ${collectionId}`);


    let contributorId = null;
    let paymentId = null;

    try {
        // 1. Create a contribution record
        req.body.name = fullName;
        req.body.phone = phoneNumber;
        req.body.amount = amount;
        req.params.collectionId = collectionId;

        const contributionResult = await createContribution(req, res);
        console.log(contributionResult, 'contributor in initializePayment');

        if (res.headersSent) return;

        const contributor = contributionResult?.contributor;

        contributorId = contributor?.id;

        if (!contributorId) {
            return res.status(500).json({ error: "Failed to create contribution record" });
        }

        // 2. Initialize payment with Paystack
        const response = await axios.post(
            `${PAYSTACK_BASE_URL}/transaction/initialize`,
            {
                email,
                amount: Math.round(amount * 100),
                callback_url: callback_url, // Your callback URL
                metadata: {
                    fullName,
                    phoneNumber,
                    amount,
                    contributorId,
                    collectionId,
                },
            },
            { headers: paystackHeaders }
        );

        console.log(`Paystack response for ${fullName}:`, response);


        const paystackData = response.data.data;

        // 3. Save payment record in Supabase
        const { data: payment, error: paymentError } = await supabase
            .from("payments")
            .insert([{
                full_name: fullName,
                email,
                phone_number: phoneNumber,
                amount,
                status: "pending",
                payment_reference: paystackData.reference,
                access_code: paystackData.access_code, // Save access_code
                authorization_url: paystackData.authorization_url, // Save authorization_url
                contributor_id: contributorId,
                collection_id: collectionId,
            }])
            .select()
            .single();

        if (paymentError) {
            // Rollback: delete the contribution
            await supabase.from("contributions").delete().eq("id", contributorId);
            return res.status(500).json({ error: paymentError.message });
        }
        paymentId = payment.id;

        // 4. Optionally update contributor with payment reference
        const { error: updateError } = await supabase
            .from("contributions")
            .update({ payment_id: paymentId })
            .eq("id", contributorId);

        if (updateError) {
            // Rollback: delete both payment and contribution
            await supabase.from("payments").delete().eq("id", paymentId);
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
            await supabase.from("payments").delete().eq("id", paymentId);
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
    const { data: existingPayment, error: fetchError } = await supabase
        .from("payments")
        .select("*")
        .eq("payment_reference", reference)
        .single();

    if (fetchError || !existingPayment) {
        return res.status(404).json({ error: "Payment not found" });
    }

    // 2. If already successful, do not verify again
    if (existingPayment.status === "success") {
        // Fetch contributor and collection for response
        const [{ data: contributor }, { data: collection }] = await Promise.all([
            supabase.from("contributions").select("*").eq("id", existingPayment.contributor_id).single(),
            supabase.from("collections").select("*").eq("id", existingPayment.collection_id).single()
        ]);

        console.log(contributor.contributor_information);

        const participants = [
            {
                id: contributor?.id,
                uniqueCode: contributor?.contributor_unique_code || null,
                details: formatDetails(contributor?.contributor_information)
            }
        ];
        const receiptData = {
            collectionTitle: collection?.title,
            amountPaid: existingPayment.amount,
            participants,
            transactionRef: existingPayment.payment_reference,
            status: existingPayment.status,
            paidAt: existingPayment.paid_at,
            channel: existingPayment.channel,
            currency: existingPayment.currency,
            payer: {
                name: existingPayment.full_name,
                email: existingPayment.email,
                phone: existingPayment.phone_number
            }
        }

        return res.status(200).json({
            message: "Payment already verified",
            payment: existingPayment,
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
        const { data: payment, error: paymentError } = await supabase
            .from("payments")
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

        if (paymentError) {
            return res.status(500).json({ error: paymentError.message });
        }

        // Optionally update contribution status
        if (payment && payment.contributor_id && paystackData.status === "success") {
            await supabase
                .from("contributions")
                .update({ status: "paid" })
                .eq("id", payment.contributor_id);

            // --- Update collection stats here ---
            if (payment.collection_id && payment.amount > 0) {
                await updateCollectionStats(payment.collection_id, payment.amount);
            }
        }

        // Fetch contributor and collection for response
        const [{ data: contributor }, { data: collection }] = await Promise.all([
            supabase.from("contributions").select("*").eq("id", payment.contributor_id).single(),
            supabase.from("collections").select("*").eq("id", payment.collection_id).single()
        ]);

        const receiptData = {
            collectionTitle: collection?.title,
            amountPaid: payment.amount,
            participants,
            transactionRef: payment.payment_reference,
            status: payment.status,
            paidAt: payment.paid_at,
            channel: payment.channel,
            currency: payment.currency,
            payer: {
                name: payment.full_name,
                email: payment.email,
                phone: payment.phone_number
            }
        }

        return res.status(200).json({
            message: "Payment verification complete",
            payment,
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
export const handleWebhook = async (req, res) => {
    const event = req.body;
    console.log('webhook event received:', event);

    // Only handle successful charges
    if (event.event === "charge.success") {
        const reference = event.data.reference;

        // Fetch payment by reference
        const { data: payment, error } = await supabase
            .from("payments")
            .select("*")
            .eq("payment_reference", reference)
            .single();

        if (error || !payment) {
            return res.status(404).json({ error: "Payment not found" });
        }

        // If already marked as success, do nothing (idempotent)
        if (payment.status === "success") {
            return res.status(200).send("Already processed");
        }

        // Update payment status
        await supabase
            .from("payments")
            .update({ status: "success", updated_at: new Date() })
            .eq("id", payment.id);

        // Optionally update contribution status
        if (payment.contributor_id) {
            await supabase
                .from("contributions")
                .update({ status: "paid" })
                .eq("id", payment.contributor_id);
        }

        // Update collection stats
        await updateCollectionStats(payment.collection_id, payment.amount);
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