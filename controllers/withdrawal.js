import axios from "axios";
import { supabase } from "../utils/client.js";
import { sendEmail } from "../services/emailService.js";
import { computeWalletBalances, roundCurrency } from "../utils/financial.js";
import { withdrawalRequestTemplate } from "../templates/withdrawalRequest.js";
import { withdrawalApprovalRequestTemplate } from "../templates/admin/withdrawalApprovalRequest.js";
import { withdrawalApprovedTemplate } from "../templates/withdrawalApproved.js";
import { adminWithdrawalProcessedTemplate } from "../templates/admin/withdrwalrequestprocessed.js";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const paystackHeaders = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
};

/**
 * Recompute wallet balances from source of truth and persist them.
 * Called after any withdrawal state change.
 */
async function refreshWallet(walletId, collectionId) {
    const [{ data: contributions }, { data: withdrawals }] = await Promise.all([
        supabase
            .from("contributions")
            .select("amount, created_at")
            .eq("collection_id", collectionId)
            .eq("status", "paid"),
        supabase
            .from("withdrawals")
            .select("amount, status")
            .eq("collection_id", collectionId),
    ]);

    const balances = computeWalletBalances(contributions || [], withdrawals || []);

    await supabase
        .from("wallets")
        .update({
            net_payment: balances.netPayment,
            pending_balance: balances.pendingBalance,
            available_balance: balances.availableBalance,
            ledger_balance: balances.ledgerBalance,
            withdrawn: balances.completedWithdrawals,
            updated_at: new Date().toISOString(),
        })
        .eq("id", walletId);

    return balances;
}

export const requestWithdrawal = async (req, res) => {
    const {
        organizer_id: userId,
        collection_id,
        amount,
        account_number: accountNumber,
        account_name: accountName,
        bank_name: userBankName,
        bank_code: providedBankCode,
    } = req.body;

    if (!userId || !collection_id || !amount || !accountNumber || !accountName || !userBankName) {
        return res.status(400).json({ error: "Missing required withdrawal fields" });
    }

    const withdrawalAmount = roundCurrency(Number(amount));
    if (withdrawalAmount <= 0) {
        return res.status(400).json({ error: "Withdrawal amount must be greater than zero" });
    }

    // Fetch wallet and check available_balance only
    const { data: wallet, error: walletError } = await supabase
        .from("wallets")
        .select("*")
        .eq("collection_id", collection_id)
        .single();

    if (walletError || !wallet) {
        return res.status(404).json({ error: "Wallet not found for this collection" });
    }

    const availableBalance = roundCurrency(Number(wallet.available_balance || 0));

    if (withdrawalAmount > availableBalance) {
        return res.status(400).json({
            error: "Insufficient available balance",
            detail: `You can only withdraw from your available balance (₦${availableBalance.toLocaleString("en-NG")}). Pending balance is not yet withdrawable.`,
            available_balance: availableBalance,
            pending_balance: roundCurrency(Number(wallet.pending_balance || 0)),
        });
    }

    try {
        let bankCode = providedBankCode || null;

        if (!bankCode) {
            // Fallback: resolve bank code from Paystack's bank list by name
            function getBankCodeByName(banks, bankName) {
                const bank = banks.find(
                    (b) => b.name.toLowerCase() === bankName.toLowerCase()
                );
                return bank ? bank.code : null;
            }

            const banksRes = await axios.get("https://api.paystack.co/bank?currency=NGN", {
                headers: paystackHeaders,
            });
            const banks = banksRes.data.data;
            bankCode = getBankCodeByName(banks, userBankName);
        }

        if (!bankCode) {
            return res.status(400).json({ error: "Invalid bank name" });
        }

        // Check for existing recipient
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

            await supabase.from("transfer_recipients").insert([{
                user_id: userId,
                account_number: accountNumber,
                bank_code: bankCode,
                account_name: accountName,
                bank_name: userBankName,
                recipient_code: recipientCode,
                currency: "NGN",
            }]);
        }

        function generateTransferCode() {
            return "TRF_" + Math.random().toString(36).substring(2, 11).toUpperCase();
        }
        const transferCode = generateTransferCode();

        // Insert withdrawal record (status: pending)
        const { data: insertedWithdrawal, error: insertError } = await supabase
            .from("withdrawals")
            .insert([{
                user_id: userId,
                collection_id,
                amount: withdrawalAmount,
                status: "pending",
                destination_account: { accountNumber, bankCode, accountName, bank_name: userBankName },
                paystack_transfer_code: transferCode,
                paystack_recipient_code: recipientCode,
                wallet_id: wallet.id,
            }])
            .select()
            .single();

        if (insertError || !insertedWithdrawal) {
            console.error("Withdrawal insert error:", insertError);
            return res.status(500).json({ error: "Failed to create withdrawal record" });
        }

        // Deduct from available_balance immediately and recompute full balances
        const newAvailableBalance = roundCurrency(availableBalance - withdrawalAmount);
        const { error: walUpdateError } = await supabase
            .from("wallets")
            .update({
                available_balance: newAvailableBalance,
                // ledger_balance decreases by the same amount (available moved out)
                ledger_balance: roundCurrency(
                    Number(wallet.ledger_balance || 0) - withdrawalAmount
                ),
                updated_at: new Date().toISOString(),
            })
            .eq("id", wallet.id);

        if (walUpdateError) {
            console.error("Wallet update error:", walUpdateError);
            return res.status(500).json({ error: "Failed to update wallet balance" });
        }

        // Fetch requester profile for emails
        const { data: profile } = await supabase
            .from("profiles")
            .select("full_name, email")
            .eq("id", userId)
            .single();

        // Fire-and-forget email notifications
        (async () => {
            try {
                const userHtml = withdrawalRequestTemplate({
                    userName: profile?.full_name || "User",
                    amount: withdrawalAmount,
                    currency: "NGN",
                    withdrawalId: insertedWithdrawal.id,
                    status: "received",
                    accountName,
                    accountNumber,
                    bankName: userBankName,
                    submittedAt: insertedWithdrawal.created_at || new Date().toISOString(),
                });
                await sendEmail({
                    to: profile?.email,
                    subject: `Withdrawal Request Received - Kolekto`,
                    html: userHtml,
                    text: `We received your withdrawal request of ₦${withdrawalAmount}. ID: ${insertedWithdrawal.id}`,
                });
            } catch (err) {
                console.error("Failed to send withdrawal email to user:", err?.message || err);
            }

            try {
                const approveUrl = `${process.env.FRONTEND_URL || "https://www.kolekto.com.ng"}/admin/withdrawals/approve?id=${insertedWithdrawal.id}`;
                const declineUrl = `${process.env.FRONTEND_URL || "https://www.kolekto.com.ng"}/admin/withdrawals/decline?id=${insertedWithdrawal.id}`;
                const adminHtml = withdrawalApprovalRequestTemplate({
                    adminName: "Gazali",
                    userName: profile?.full_name || "User",
                    amount: withdrawalAmount,
                    currency: "NGN",
                    withdrawalId: insertedWithdrawal.id,
                    accountName,
                    accountNumber,
                    bankName: userBankName,
                    submittedAt: insertedWithdrawal.created_at || new Date().toISOString(),
                    approveUrl,
                    declineUrl,
                });
                await sendEmail({
                    to: "gazalianfellow@gmail.com",
                    subject: `Withdrawal Approval Required - ${profile?.full_name || "Requester"}`,
                    html: adminHtml,
                    text: `Withdrawal request of ₦${withdrawalAmount} requires approval. ID: ${insertedWithdrawal.id}`,
                });
            } catch (err) {
                console.error("Failed to send withdrawal approval email to admin:", err?.message || err);
            }
        })();

        return res.status(200).json({
            success: true,
            withdrawal: insertedWithdrawal,
            available_balance: newAvailableBalance,
            pending_balance: roundCurrency(Number(wallet.pending_balance || 0)),
        });
    } catch (error) {
        return res.status(500).json({
            error: error.response?.data?.message || error.message,
        });
    }
};

export const handlePaystackWebhook = async (req, res) => {
    const event = req.body.event;
    const data = req.body.data;

    if (
        event === "transfer.success" ||
        event === "transfer.failed" ||
        event === "transfer.reversed"
    ) {
        const transferCode = data.transfer_code;

        const { data: withdrawal, error: withdrawalError } = await supabase
            .from("withdrawals")
            .select("*")
            .eq("paystack_transfer_code", transferCode)
            .single();

        if (withdrawalError || !withdrawal) {
            return res.status(404).json({ error: "Withdrawal not found" });
        }

        const { data: wallet } = await supabase
            .from("wallets")
            .select("*")
            .eq("collection_id", withdrawal.collection_id)
            .single();

        if (event === "transfer.success") {
            await supabase
                .from("withdrawals")
                .update({ status: "success" })
                .eq("id", withdrawal.id);

            // Recompute balances from source of truth
            await refreshWallet(wallet.id, withdrawal.collection_id);

        } else if (event === "transfer.failed" || event === "transfer.reversed") {
            const newStatus = event === "transfer.failed" ? "failed" : "reversed";
            await supabase
                .from("withdrawals")
                .update({ status: newStatus })
                .eq("id", withdrawal.id);

            // Refund available_balance since withdrawal won't proceed
            // Then recompute from source of truth
            await refreshWallet(wallet.id, withdrawal.collection_id);
        }
    }

    res.status(200).send("OK");
};

export const getCollectionWalletWithdrawals = async (req, res) => {
    const { collection_id } = req.query;

    const { data: wallet, error: walletError } = await supabase
        .from("wallets")
        .select("id")
        .eq("collection_id", collection_id)
        .single();

    if (walletError || !wallet) {
        return res.status(404).json({ error: "Wallet not found for this collection" });
    }

    const { data: withdrawals, error } = await supabase
        .from("withdrawals")
        .select(`
            *,
            collections (
                id, title, code_prefix, currency, currency_symbol
            ),
            wallets (
                id,
                available_balance,
                pending_balance,
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
        .eq("wallet_id", wallet.id)
        .order("created_at", { ascending: false });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ withdrawals });
};

export const getUserWithdrawals = async (req, res) => {
    const userId = req.user.id;

    const { data: withdrawals, error } = await supabase
        .from("withdrawals")
        .select(`
            *,
            collections (
                id, title, code_prefix, currency, currency_symbol
            ),
            wallets (
                id,
                available_balance,
                pending_balance,
                ledger_balance,
                gross_payment,
                net_payment,
                withdrawn,
                fee_breakdown,
                currency,
                currency_symbol
            )
        `)
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ withdrawals });
};

export const approveWithdrawal = async (req, res) => {
    const { id: withdrawal_id } = req.body;

    const { data: withdrawal, error: withdrawalError } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("id", withdrawal_id)
        .single();

    if (withdrawalError || !withdrawal) {
        return res.status(404).json({ error: "Withdrawal not found" });
    }

    if (withdrawal.status === "success") {
        return res.status(400).json({ error: "Withdrawal already approved" });
    }

    const { data: wallet, error: walletError } = await supabase
        .from("wallets")
        .select("*")
        .eq("id", withdrawal.wallet_id)
        .single();

    if (walletError || !wallet) {
        return res.status(404).json({ error: "Wallet not found" });
    }

    // Mark withdrawal as successful
    await supabase
        .from("withdrawals")
        .update({ status: "success" })
        .eq("id", withdrawal.id);

    // Recompute all balances from source of truth
    const balances = await refreshWallet(wallet.id, withdrawal.collection_id);

    // Fire-and-forget email notifications
    (async () => {
        try {
            const { data: profile } = await supabase
                .from("profiles")
                .select("full_name, email")
                .eq("id", withdrawal.user_id)
                .single();

            const destination = withdrawal.destination_account || {};
            const processedAt = new Date().toISOString();
            const reference = withdrawal.paystack_transfer_code || withdrawal.id;

            const userHtml = withdrawalApprovedTemplate({
                userName: profile?.full_name || "User",
                amount: withdrawal.amount,
                currency: withdrawal.currency || "NGN",
                withdrawalId: withdrawal.id,
                processedAt,
                status: "Processed",
                accountName: destination.accountName || destination.account_name || "",
                accountNumber: destination.accountNumber || destination.account_number || "",
                bankName: destination.bank_name || destination.bankName || "",
                reference,
                currentBalance: balances?.ledgerBalance || 0,
                availableBalance: balances?.availableBalance || 0,
                dashboardUrl: process.env.FRONTEND_URL,
                supportEmail: process.env.SUPPORT_EMAIL || "support@kolekto.com.ng",
            });

            await sendEmail({
                to: profile?.email,
                subject: `Withdrawal Processed - ${reference}`,
                html: userHtml,
                text: `Your withdrawal of ₦${withdrawal.amount} has been processed. Reference: ${reference}`,
            });

            const adminHtml = adminWithdrawalProcessedTemplate({
                adminName: "Admin",
                userName: profile?.full_name || "User",
                userEmail: profile?.email,
                userId: withdrawal.user_id,
                amount: withdrawal.amount,
                currency: withdrawal.currency || "NGN",
                withdrawalId: withdrawal.id,
                processedAt,
                accountName: destination.accountName || destination.account_name || "",
                accountNumber: destination.accountNumber || destination.account_number || "",
                bankName: destination.bank_name || destination.bankName || "",
                reference,
                walletLink: `${process.env.FRONTEND_URL || "https://www.kolekto.com.ng"}/admin/withdrawals/${withdrawal.id}`,
                note: "",
            });

            await sendEmail({
                to: process.env.ADMIN_EMAIL || "gazalianfellow@gmail.com",
                subject: `Withdrawal Processed - ${profile?.full_name || "Requester"} - ${reference}`,
                html: adminHtml,
                text: `Withdrawal ${reference} of ₦${withdrawal.amount} has been processed for ${profile?.full_name || "user"}.`,
            });
        } catch (err) {
            console.error("Error sending withdrawal processed emails:", err?.message || err);
        }
    })();

    return res.status(200).json({
        success: true,
        message: "Withdrawal approved and wallet updated successfully",
        available_balance: balances?.availableBalance || 0,
        ledger_balance: balances?.ledgerBalance || 0,
    });
};

export const rejectWithdrawal = async (req, res) => {
    const { id: withdrawal_id } = req.body;

    const { data: withdrawal, error: withdrawalError } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("id", withdrawal_id)
        .single();

    if (withdrawalError || !withdrawal) {
        return res.status(404).json({ error: "Withdrawal not found" });
    }

    if (withdrawal.status === "rejected") {
        return res.status(400).json({ error: "Withdrawal already rejected" });
    }

    const { data: wallet, error: walletError } = await supabase
        .from("wallets")
        .select("*")
        .eq("id", withdrawal.wallet_id)
        .single();

    if (walletError || !wallet) {
        return res.status(404).json({ error: "Wallet not found" });
    }

    await supabase
        .from("withdrawals")
        .update({ status: "rejected" })
        .eq("id", withdrawal.id);

    // Recompute all balances from source of truth (rejection restores available balance)
    const balances = await refreshWallet(wallet.id, withdrawal.collection_id);

    return res.status(200).json({
        success: true,
        message: "Withdrawal rejected and available balance refunded successfully",
        available_balance: balances?.availableBalance || 0,
        ledger_balance: balances?.ledgerBalance || 0,
    });
};
