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

    const client = supabase; // your initialized supabase client
    let wallet, recipientCode, transferCode;

    try {
        // 1️⃣ Fetch wallet and validate balance
        const { data: walletData, error: walletError } = await client
            .from("wallets")
            .select("*")
            .eq("collection_id", collection_id)
            .single();

        if (walletError || !walletData)
            return res.status(404).json({ error: "Wallet not found" });

        wallet = walletData;
        const available = Number(wallet.available_balance || 0);
        const withdrawalAmount = Number(amount);

        if (withdrawalAmount <= 0 || withdrawalAmount > available) {
            return res.status(400).json({ error: "Insufficient available balance" });
        }

        // 2️⃣ Temporarily deduct balance (simulate pending lock)
        const { error: debitError } = await client
            .from("wallets")
            .update({
                available_balance: available - withdrawalAmount,
                ledger_balance: wallet.ledger_balance - withdrawalAmount,
                updated_at: new Date().toISOString(),
            })
            .eq("id", wallet.id);

        if (debitError) throw new Error("Failed to update wallet balance");

        // 3️⃣ Get valid bank code dynamically from Paystack
        const banksRes = await axios.get("https://api.paystack.co/bank?currency=NGN", {
            headers: paystackHeaders,
        });
        const banks = banksRes.data.data;
        const bank = banks.find(
            (b) => b.name.toLowerCase() === userBankName.toLowerCase()
        );
        if (!bank) throw new Error("Invalid bank name");
        const bankCode = bank.code;

        // 4️⃣ Find or create transfer recipient
        const { data: existingRecipient } = await client
            .from("transfer_recipients")
            .select("*")
            .eq("user_id", userId)
            .eq("account_number", accountNumber)
            .eq("bank_code", bankCode)
            .single();

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
                    currency: "NGN",
                },
                { headers: paystackHeaders }
            );
            recipientCode = recipientRes.data.data.recipient_code;

            const { error: recipientInsertError } = await client
                .from("transfer_recipients")
                .insert([
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
            if (recipientInsertError) throw new Error("Failed to save recipient");
        }

        // 5️⃣ Create withdrawal record
        transferCode = "TRF_" + Math.random().toString(36).substr(2, 9).toUpperCase();

        const { error: withdrawalError } = await client.from("withdrawals").insert([
            {
                user_id: userId,
                collection_id,
                wallet_id: wallet.id,
                amount: withdrawalAmount,
                status: "pending",
                destination_account: {
                    accountNumber,
                    accountName,
                    bankCode,
                    bank_name: userBankName,
                },
                paystack_transfer_code: transferCode,
                paystack_recipient_code: recipientCode,
            },
        ]);

        if (withdrawalError) throw new Error("Failed to record withdrawal");

        // ✅ Everything succeeded
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

        // 🧩 Rollback wallet deduction if anything fails
        if (wallet && amount) {
            await client
                .from("wallets")
                .update({
                    available_balance: wallet.available_balance,
                    ledger_balance: wallet.ledger_balance,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", wallet.id);
        }

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

    try {
        // 1. Fetch withdrawal record
        const { data: withdrawal, error: withdrawalError } = await supabase
            .from("withdrawals")
            .select("*")
            .eq("id", withdrawal_id)
            .single();

        if (withdrawalError || !withdrawal) {
            throw new Error("Withdrawal not found");
        }

        // 2. Check if already approved
        if (withdrawal.status === "success") {
            throw new Error("Withdrawal already approved");
        }

        // 3. Fetch wallet
        const { data: wallet, error: walletError } = await supabase
            .from("wallets")
            .select("*")
            .eq("id", withdrawal.wallet_id)
            .single();

        if (walletError || !wallet) {
            throw new Error("Wallet not found");
        }

        const amount = Number(withdrawal.amount);
        const available = Number(wallet.available_balance || 0);

        // 4. Check balance
        if (amount > available) {
            throw new Error(
                `Insufficient balance. Available: ${available}, Requested: ${amount}`
            );
        }

        // 5. Compute new balances
        let updatedAvailable = available - amount;
        let updatedWithdrawn = Number(wallet.withdrawn || 0) + amount;
        let updatedLedger = Number(wallet.ledger_balance || 0) - amount;

        // 6. Update wallet
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
            throw new Error("Failed to update wallet balances");
        }

        // 7. Update withdrawal
        const { error: withdrawalUpdateError } = await supabase
            .from("withdrawals")
            .update({ status: "success" })
            .eq("id", withdrawal_id);

        if (withdrawalUpdateError) {
            // 7a. rollback wallet update manually if this fails
            updatedAvailable = available + amount;
            updatedWithdrawn = Number(wallet.withdrawn || 0) - amount;
            updatedLedger = Number(wallet.ledger_balance || 0) + amount;
            await supabase
                .from("wallets")
                .update({
                    available_balance: available,
                    withdrawn: updatedWithdrawn,
                    ledger_balance: updatedLedger,
                    updated_at: new Date(),
                })
                .eq("id", wallet.id);

            throw new Error("Failed to update withdrawal status — rolled back wallet changes");
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
    } catch (error) {
        console.error("approveWithdrawal error:", error);
        return res.status(500).json({ error: error.message });
    }
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