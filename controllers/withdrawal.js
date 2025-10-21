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
    const {
        organizer_id: userId,
        collection_id,
        amount,
        account_number: accountNumber,
        account_name: accountName,
        bank_name: userBankName
    } = req.body;

    try {
        // 1. Fetch wallet and validate balance
        const { data: wallet, error: walletError } = await supabase
            .from("wallets")
            .select("*")
            .eq("collection_id", collection_id)
            .single();

        if (walletError || !wallet) {
            return res.status(404).json({ error: "Wallet not found" });
        }

        const available = Number(wallet.available_balance || 0);
        const withdrawalAmount = Number(amount);

        if (withdrawalAmount <= 0 || withdrawalAmount > available) {
            return res.status(400).json({ error: "Insufficient available balance" });
        }

        // 2. Fetch bank list from Paystack
        const banksRes = await axios.get("https://api.paystack.co/bank?currency=NGN", {
            headers: paystackHeaders,
        });
        const banks = banksRes.data.data;

        const getBankCodeByName = (banks, bankName) => {
            const bank = banks.find((b) => b.name.toLowerCase() === bankName.toLowerCase());
            return bank ? bank.code : null;
        };

        const bankCode = getBankCodeByName(banks, userBankName);
        if (!bankCode) return res.status(400).json({ error: "Invalid bank name" });

        // 3. Find or create transfer recipient
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
            const recipientRes = await axios.post(
                "https://api.paystack.co/transferrecipient",
                {
                    type: "nuban",
                    name: accountName,
                    account_number: accountNumber,
                    bank_code: bankCode,
                    bank_name: userBankName,
                    currency: "NGN",
                },
                { headers: paystackHeaders }
            );
            recipientCode = recipientRes.data.data.recipient_code;

            await supabase.from("transfer_recipients").insert([
                {
                    user_id: userId,
                    account_number: accountNumber,
                    bank_code: bankCode,
                    account_name: accountName,
                    bank_name: userBankName,
                    recipient_code: recipientCode,
                    currency: "NGN",
                },
            ]);
        }

        // 4. Create withdrawal record (status: pending)
        const transferCode = "TRF_" + Math.random().toString(36).substr(2, 9).toUpperCase();

        const { error: insertError } = await supabase.from("withdrawals").insert([
            {
                user_id: userId,
                collection_id,
                amount: withdrawalAmount,
                status: "pending",
                destination_account: {
                    accountNumber,
                    bankCode,
                    accountName,
                    bank_name: userBankName,
                },
                paystack_transfer_code: transferCode,
                paystack_recipient_code: recipientCode,
                wallet_id: wallet.id,
            },
        ]);

        if (insertError) throw insertError;

        // 5. Move funds to pending_withdrawal (lock them)
        const newAvailable = available - withdrawalAmount;
        const newPendingWithdrawal = Number(wallet.pending_withdrawal || 0) + withdrawalAmount;

        const { error: walletUpdateError } = await supabase
            .from("wallets")
            .update({
                available_balance: newAvailable,
                pending_withdrawal: newPendingWithdrawal,
                updated_at: new Date(),
            })
            .eq("id", wallet.id);

        if (walletUpdateError) throw walletUpdateError;

        // 6. Respond success
        return res.status(200).json({
            success: true,
            message: "Withdrawal request submitted successfully",
            withdrawal: {
                amount: withdrawalAmount,
                status: "pending",
                transfer_code: transferCode,
            },
        });
    } catch (error) {
        console.error("Withdrawal request error:", error);
        return res
            .status(500)
            .json({ error: error.response?.data?.message || error.message });
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

export const getCollectionWalletWithdrawals = async (req, res) => {
    const { collection_id } = req.query;

    // 1. Get the wallet for this collection
    const { data: wallet, error: walletError } = await supabase
        .from("wallets")
        .select("id")
        .eq("collection_id", collection_id)
        .single();

    if (walletError || !wallet) {
        return res.status(404).json({ error: "Wallet not found for this collection" });
    }

    // 2. Fetch all withdrawals for this wallet, including collection and wallet details
    const { data: withdrawals, error } = await supabase
        .from("withdrawals")
        .select(`
            *,
            collections (
                id,
                title,
                code_prefix,
                currency,
                currency_symbol
            ),
            wallets (
                id,
                available_balance,
                ledger_balance,
                gross_payment,
                net_payment,
                withdrawn,
                total_fees,
                fee_breakdown,
                total_contributions,
                currency,
                currency_symbol,
                fee_bearer
            )
        `)
        .eq("wallet_id", wallet.id);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ withdrawals });
};

export const getUserWithdrawals = async (req, res) => {
    const userId = req.user.id; // or req.user.id, depending on your auth

    // Fetch all withdrawals for this user, including collection and wallet details
    const { data: withdrawals, error } = await supabase
        .from("withdrawals")
        .select(`
            *,
            collections (
                id,
                title,
                code_prefix,
                currency,
                currency_symbol
            ),
            wallets (
                id,
                available_balance,
                ledger_balance,
                gross_payment,
                net_payment,
                withdrawn,
                fee_breakdown,
                currency,
                currency_symbol
            )
        `)
        .eq("user_id", userId);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ withdrawals });
};

export const approveWithdrawal = async (req, res) => {
    const { id: withdrawal_id } = req.body;

    // 1. Fetch the withdrawal record
    const { data: withdrawal, error: withdrawalError } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("id", withdrawal_id)
        .single();

    if (withdrawalError || !withdrawal) {
        return res.status(404).json({ error: "Withdrawal not found" });
    }

    // 2. Check if it's already approved
    if (withdrawal.status === "success") {
        return res.status(400).json({ error: "Withdrawal already approved" });
    }

    // 3. Fetch the wallet
    const { data: wallet, error: walletError } = await supabase
        .from("wallets")
        .select("*")
        .eq("id", withdrawal.wallet_id)
        .single();

    if (walletError || !wallet) {
        return res.status(404).json({ error: "Wallet not found" });
    }

    const amount = Number(withdrawal.amount);
    const available = Number(wallet.available_balance || 0);

    // 4. Ensure available balance is sufficient
    if (amount > available) {
        return res.status(400).json({
            error: `Insufficient available balance. Available: ${available}, Requested: ${amount}`,
        });
    }

    // 5. Compute new balances
    const updatedAvailable = available - amount;
    const updatedWithdrawn = Number(wallet.withdrawn || 0) + amount;
    const updatedLedger = Number(wallet.ledger_balance || 0) - amount;

    // 6. Apply updates atomically (wallet first)
    const { error: walletUpdateError } = await supabase
        .from("wallets")
        .update({
            available_balance: updatedAvailable,
            withdrawn: updatedWithdrawn,
            ledger_balance: updatedLedger,
            updated_at: new Date(),
        })
        .eq("id", wallet.id);

    if (walletUpdateError) {
        return res
            .status(500)
            .json({ error: "Failed to update wallet balances", details: walletUpdateError });
    }

    // 7. Mark withdrawal as successful
    const { error: withdrawalUpdateError } = await supabase
        .from("withdrawals")
        .update({ status: "success", approved_at: new Date() })
        .eq("id", withdrawal.id);

    if (withdrawalUpdateError) {
        return res
            .status(500)
            .json({ error: "Failed to update withdrawal status", details: withdrawalUpdateError });
    }

    return res.status(200).json({
        success: true,
        message: "Withdrawal approved and wallet updated successfully",
        new_balances: {
            available_balance: updatedAvailable,
            withdrawn: updatedWithdrawn,
            ledger_balance: updatedLedger,
        },
    });
};


export const rejectWithdrawal = async (req, res) => {
    const { id: withdrawal_id } = req.body;

    // 1. Fetch the withdrawal record
    const { data: withdrawal, error: withdrawalError } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("id", withdrawal_id)
        .single();

    if (withdrawalError || !withdrawal) {
        return res.status(404).json({ error: "Withdrawal not found" });
    }

    // 2. Check if it's already rejected
    if (withdrawal.status === "rejected") {
        return res.status(400).json({ error: "Withdrawal already rejected" });
    }

    // 3. Fetch the wallet
    const { data: wallet, error: walletError } = await supabase
        .from("wallets")
        .select("*")
        .eq("id", withdrawal.wallet_id)
        .single();

    if (walletError || !wallet) {
        return res.status(404).json({ error: "Wallet not found" });
    }

    // 4. Refund the available balance
    const updatedAvailableBalance = Number(wallet.available_balance || 0) + Number(withdrawal.amount);

    const { error: updateError } = await supabase
        .from("wallets")
        .update({
            available_balance: updatedAvailableBalance
        })
        .eq("id", wallet.id);

    if (updateError) {
        return res.status(500).json({ error: "Failed to update wallet balances" });
    }

    await supabase
        .from("withdrawals")
        .update({ status: "rejected" })
        .eq("id", withdrawal.id);

    return res.status(200).json({ success: true, message: "Withdrawal rejected and available balance refunded successfully" });
};