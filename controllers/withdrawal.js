import axios from "axios";
import { supabase } from "../utils/client.js";

// Initialize Paystack secret key from environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = "https://api.paystack.co";
const PAYMENT_BASE_URL = process.env.PAYMENT_BASE_URL;

// Helper to set headers
const paystackHeaders = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
};

export const requestWithdrawal = async (req, res) => {
    const { organizer_id: userId, collection_id, amount, account_number: accountNumber, account_name: accountName, bank_name: userBankName } = req.body;

    // 1. Validate input and check wallet balance
    const { data: wallet } = await supabase
        .from("wallets")
        .select("*")
        .eq("collection_id", collection_id)
        .single();

    console.log(wallet, 'wallet in requestWithdrawal');

    if (!wallet || amount > wallet.available_balance) {
        return res.status(400).json({ error: "Insufficient balance" });
    }

    try {

        function getBankCodeByName(banks, bankName) {
            const bank = banks.find(b => b.name.toLowerCase() === bankName.toLowerCase());
            return bank ? bank.code : null;
        }

        // 1. Get all banks from Paystack
        const banksRes = await axios.get(
            "https://api.paystack.co/bank?currency=NGN",
            { headers: paystackHeaders }
        );
        const banks = banksRes.data.data;

        // 2. Find the code for the user's bank
        const bankCode = getBankCodeByName(banks, userBankName);
        if (!bankCode) {
            return res.status(400).json({ error: "Invalid bank name" });
        }

        // Check if recipient exists
        const { data: existingRecipient } = await supabase
            .from("transfer_recipients")
            .select("*")
            .eq("user_id", userId)
            .eq("account_number", accountNumber)
            .eq("bank_code", bankCode)
            .single();

        let recipientCode;

        if (existingRecipient) {
            recipientCode = existingRecipient.recipient_code;
        } else {
            // Create recipient on Paystack
            const recipientRes = await axios.post(
                "https://api.paystack.co/transferrecipient",
                {
                    type: "nuban",
                    name: accountName,
                    account_number: accountNumber,
                    bank_code: bankCode,
                    currency: "NGN"
                },
                { headers: paystackHeaders }
            );
            recipientCode = recipientRes.data.data.recipient_code;

            // Save recipient in DB
            await supabase.from("transfer_recipients").insert([{
                user_id: userId,
                account_number: accountNumber,
                bank_code: bankCode,
                account_name: accountName,
                recipient_code: recipientCode,
                currency: "NGN"
            }]);
        }

        // 3. Initiate transfer
        const transferRes = await axios.post(
            "https://api.paystack.co/transfer",
            {
                source: "balance",
                amount: Math.round(amount * 100), // Paystack expects kobo
                recipient: recipientCode,
                reason: "Withdrawal from Kolekto"
            },
            { headers: paystackHeaders }
        );
        const transferData = transferRes.data.data;

        // 4. Save withdrawal record (status: pending)
        await supabase.from("withdrawals").insert([{
            user_id: userId,
            collection_id: collection_id,
            amount,
            status: "pending",
            destination_account: {
                accountNumber,
                bankCode,
                accountName
            },
            paystack_transfer_code: transferData.transfer_code,
            paystack_recipient_code: recipientCode,
            wallet_id: wallet.id
        }]);

        // 5. Deduct from wallet.available_balance immediately
        await supabase
            .from("wallets")
            .update({
                available_balance: wallet.available_balance - amount
            })
            .eq("id", wallet.id);

        return res.status(200).json({ success: true, transfer: transferData });
    } catch (error) {
        return res.status(500).json({ error: error.response?.data?.message || error.message });
    }
};

// This should be added to your webhook route/controller
export const handlePaystackWebhook = async (req, res) => {
    // Paystack sends events as POST JSON
    const event = req.body.event;
    const data = req.body.data;

    // For security, you should verify the Paystack signature here (see Paystack docs)

    if (event === "transfer.success" || event === "transfer.failed" || event === "transfer.reversed") {
        const transferCode = data.transfer_code;

        // Fetch the withdrawal record
        const { data: withdrawal, error: withdrawalError } = await supabase
            .from("withdrawals")
            .select("*")
            .eq("paystack_transfer_code", transferCode)
            .single();

        if (withdrawalError || !withdrawal) {
            return res.status(404).json({ error: "Withdrawal not found" });
        }

        // Fetch the wallet
        const { data: wallet } = await supabase
            .from("wallets")
            .select("*")
            .eq("collection_id", withdrawal.collection_id)
            .single();

        // Handle status update
        if (event === "transfer.success") {
            // Mark withdrawal as successful
            await supabase
                .from("withdrawals")
                .update({ status: "success" })
                .eq("id", withdrawal.id);

            // Update wallet: increase withdrawn, decrease ledger_balance
            await supabase
                .from("wallets")
                .update({
                    withdrawn: Number(wallet.withdrawn || 0) + Number(withdrawal.amount),
                    ledger_balance: Number(wallet.ledger_balance || 0) - Number(withdrawal.amount)
                })
                .eq("id", wallet.id);

        } else if (event === "transfer.failed" || event === "transfer.reversed") {
            // Mark withdrawal as failed/reversed
            await supabase
                .from("withdrawals")
                .update({ status: event === "transfer.failed" ? "failed" : "reversed" })
                .eq("id", withdrawal.id);

            // Refund available_balance
            await supabase
                .from("wallets")
                .update({
                    available_balance: Number(wallet.available_balance || 0) + Number(withdrawal.amount)
                })
                .eq("id", wallet.id);
        }
    }

    res.status(200).send("OK");    // Respond to Paystack    res.status(200).send("OK");
};