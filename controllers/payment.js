import axios from "axios";

// Initialize Paystack secret key from environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = "https://api.paystack.co";

// Helper to set headers
const paystackHeaders = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
};

// Initialize a payment (get payment link)
export const initializePayment = async (req, res) => {
    const { email, amount, reference, callback_url, metadata } = req.body;

    if (!email || !amount) {
        return res.status(400).json({ error: "Email and amount are required" });
    }

    try {
        const response = await axios.post(
            `${PAYSTACK_BASE_URL}/transaction/initialize`,
            {
                email,
                amount: Math.round(amount * 100), // Paystack expects amount in kobo
                reference,
                callback_url,
                metadata
            },
            { headers: paystackHeaders }
        );
        return res.status(200).json(response.data);
    } catch (error) {
        return res.status(500).json({ error: error.response?.data?.message || error.message });
    }
};

// Verify a payment
export const verifyPayment = async (req, res) => {
    const { reference } = req.query;

    if (!reference) {
        return res.status(400).json({ error: "Reference is required" });
    }

    try {
        const response = await axios.get(
            `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
            { headers: paystackHeaders }
        );
        return res.status(200).json(response.data);
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
    // Paystack sends events as POST requests to your webhook endpoint
    const event = req.body;
    // You should verify the event signature here for security (see Paystack docs)
    // Process the event as needed (e.g., update payment status in your DB)
    console.log("Received Paystack webhook event:", event);

    // Respond quickly to acknowledge receipt
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