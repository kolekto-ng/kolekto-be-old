import axios from "axios";
import { supabase } from "../utils/client.js";
import { sendEmail } from "../services/emailService.js";
import { withdrawalRequestTemplate } from "../templates/withdrawalRequest.js";
import { withdrawalApprovalRequestTemplate } from "../templates/admin/withdrawalApprovalRequest.js";
import { withdrawalApprovedTemplate } from "../templates/withdrawalApproved.js";
import { adminWithdrawalProcessedTemplate } from "../templates/admin/withdrwalrequestprocessed.js";

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
                    bank_name: userBankName,
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
                bank_name: userBankName,
                recipient_code: recipientCode,
                currency: "NGN"
            }]);
        }



        // Generate a random transfer code
        function generateTransferCode() {
            return "TRF_" + Math.random().toString(36).substr(2, 9).toUpperCase();
        }
        const transferCode = generateTransferCode();
        // 4. Save withdrawal record (status: pending) and return inserted row
        const { data: insertedWithdrawal, error: insertError } = await supabase.from("withdrawals")
            .insert([{
                user_id: userId,
                collection_id: collection_id,
                amount,
                status: "pending",
                destination_account: {
                    accountNumber,
                    bankCode,
                    accountName,
                    bank_name: userBankName
                },
                paystack_transfer_code: transferCode,
                paystack_recipient_code: recipientCode,
                wallet_id: wallet.id
            }])
            .select()
            .single();

        if (insertError || !insertedWithdrawal) {
            console.error('Withdrawal insert error', insertError);
            return res.status(500).json({ error: "Failed to create withdrawal record" });
        }

        // 5. Deduct from wallet.available_balance immediately
        const { error: walUpdateError } = await supabase
            .from("wallets")
            .update({
                available_balance: wallet.available_balance - amount
            })
            .eq("id", wallet.id);

        if (walUpdateError) {
            console.error('Wallet update error', walUpdateError);
            // continue — we still want to notify user/admin; but respond with failure
            return res.status(500).json({ error: "Failed to update wallet balance" });
        }

        // Fetch requester profile (name + email) for sending email
        const { data: profile } = await supabase
            .from("profiles")
            .select("full_name, email")
            .eq("id", userId)
            .single();

        // Prepare and send emails (user + admin). Do not block response on email errors.
        (async () => {
            try {
                // User email
                try {
                    const userHtml = withdrawalRequestTemplate({
                        userName: profile?.full_name || "User",
                        amount,
                        currency: "NGN",
                        withdrawalId: insertedWithdrawal.id,
                        status: "received",
                        accountName,
                        accountNumber,
                        bankName: userBankName,
                        submittedAt: insertedWithdrawal.created_at || new Date().toISOString()
                    });

                    await sendEmail({
                        to: profile?.email,
                        subject: `Withdrawal Request Received - Kolekto`,
                        html: userHtml,
                        text: `We received your withdrawal request of ${amount}. Withdrawal ID: ${insertedWithdrawal.id}`
                    });
                    console.log('✅ Withdrawal request email sent to requester');
                } catch (userMailErr) {
                    console.error('Failed to send withdrawal email to user:', userMailErr?.message || userMailErr);
                }

                // Admin email (notify approver)
                try {
                    const approveUrl = `${process.env.FRONTEND_URL || 'https://www.kolekto.com.ng'}/admin/withdrawals/approve?id=${insertedWithdrawal.id}`;
                    const declineUrl = `${process.env.FRONTEND_URL || 'https://www.kolekto.com.ng'}/admin/withdrawals/decline?id=${insertedWithdrawal.id}`;

                    const adminHtml = withdrawalApprovalRequestTemplate({
                        adminName: "Gazali",
                        userName: profile?.full_name || "User",
                        amount,
                        currency: "NGN",
                        withdrawalId: insertedWithdrawal.id,
                        accountName,
                        accountNumber,
                        bankName: userBankName,
                        submittedAt: insertedWithdrawal.created_at || new Date().toISOString(),
                        approveUrl,
                        declineUrl
                    });

                    await sendEmail({
                        to: "abdullahimohammed3108@gmail.com",
                        subject: `Withdrawal Approval Required - ${profile?.full_name || 'Requester'}`,
                        html: adminHtml,
                        text: `A withdrawal request of ${amount} requires your approval. Withdrawal ID: ${insertedWithdrawal.id}`
                    });
                    console.log('✅ Withdrawal approval request sent to admin');
                } catch (adminMailErr) {
                    console.error('Failed to send withdrawal approval email to admin:', adminMailErr?.message || adminMailErr);
                }
            } catch (err) {
                console.error('Unexpected error sending withdrawal emails:', err?.message || err);
            }
        })();

        return res.status(200).json({ success: true, wallet, withdrawal: insertedWithdrawal });
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

    // 4. Update the withdrawal status and adjust the wallet
    const updatedWithdrawn = Number(wallet.withdrawn || 0) + Number(withdrawal.amount);
    const updatedLedgerBalance = Number(wallet.ledger_balance || 0) - Number(withdrawal.amount);

    const { error: updateError } = await supabase
        .from("wallets")
        .update({
            withdrawn: updatedWithdrawn,
            ledger_balance: updatedLedgerBalance
        })
        .eq("id", wallet.id);

    if (updateError) {
        return res.status(500).json({ error: "Failed to update wallet balances" });
    }

    await supabase
        .from("withdrawals")
        .update({ status: "success" })
        .eq("id", withdrawal.id);

    // Send notifications (fire-and-forget)
    (async () => {
        try {
            // fetch requester profile
            const { data: profile } = await supabase
                .from("profiles")
                .select("full_name, email")
                .eq("id", withdrawal.user_id)
                .single();

            // refresh wallet balances for email
            const { data: refreshedWallet } = await supabase
                .from("wallets")
                .select("ledger_balance, available_balance")
                .eq("id", wallet.id)
                .single();

            const destination = withdrawal.destination_account || {};
            const processedAt = new Date().toISOString();
            const reference = withdrawal.paystack_transfer_code || withdrawal.id;

            // user email
            try {
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
                    currentBalance: refreshedWallet?.ledger_balance || 0,
                    availableBalance: refreshedWallet?.available_balance || 0,
                    dashboardUrl: process.env.FRONTEND_URL,
                    supportEmail: process.env.SUPPORT_EMAIL || "support@kolekto.com.ng"
                });

                await sendEmail({
                    to: profile?.email,
                    subject: `Withdrawal Processed - ${reference}`,
                    html: userHtml,
                    text: `Your withdrawal of ${withdrawal.amount} ${withdrawal.currency || 'NGN'} has been processed. Reference: ${reference}`
                });
                console.log("✅ Withdrawal processed email sent to user");
            } catch (userMailErr) {
                console.error("Failed sending processed email to user:", userMailErr?.message || userMailErr);
            }

            // admin email
            try {
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
                    walletLink: `${process.env.FRONTEND_URL || 'https://www.kolekto.com.ng'}/admin/withdrawals/${withdrawal.id}`,
                    note: ""
                });

                await sendEmail({
                    to: process.env.ADMIN_EMAIL || "abdullahimohammed3108@gmail.com",
                    subject: `Withdrawal Processed - ${profile?.full_name || 'Requester'} - ${reference}`,
                    html: adminHtml,
                    text: `Withdrawal ${reference} of ${withdrawal.amount} ${withdrawal.currency || 'NGN'} has been processed for ${profile?.full_name || 'user'}.`
                });
                console.log("✅ Withdrawal processed email sent to admin");
            } catch (adminMailErr) {
                console.error("Failed sending processed email to admin:", adminMailErr?.message || adminMailErr);
            }
        } catch (err) {
            console.error("Unexpected error sending withdrawal processed emails:", err?.message || err);
        }
    })();

    return res.status(200).json({ success: true, message: "Withdrawal approved and wallet updated successfully" });
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