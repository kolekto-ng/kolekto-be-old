import axios from "axios";
import crypto from "crypto";
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

// ─── Payout-account decryption helpers ──────────────────────────────────────
// Mirrors the logic in scripts/auditPayoutAccounts.js so we accept every
// historical ciphertext shape: base64 string (current), `\x...` hex, raw
// Buffer, or the `{type:"Buffer",data:[...]}` JSON form Supabase-JS
// produced before the encryption fix.
function getAccountEncryptionKey() {
    const raw = process.env.ACCOUNT_ENCRYPTION_KEY;
    if (!raw) return null;
    let buf = Buffer.from(raw, "utf8");
    if (buf.length !== 32 && /^[0-9a-fA-F]{64}$/.test(raw)) {
        buf = Buffer.from(raw, "hex");
    }
    if (buf.length === 32) return buf;
    return crypto.createHash("sha256").update(raw, "utf8").digest();
}

// Try to unwrap the legacy bug-shape: the original encryptAccountNumber
// returned a Node Buffer, which Supabase-JS serialised to JSON as
//   {"type":"Buffer","data":[1,2,...]}
// If the underlying column was text, that literal JSON string is what got
// persisted. If the column was bytea, PostgREST hex-encoded those JSON bytes
// — we need to undo both layers here.
function tryUnwrapBufferJson(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && parsed.type === "Buffer" && Array.isArray(parsed.data)) {
            return Buffer.from(parsed.data);
        }
    } catch {
        /* not JSON — fall through */
    }
    return null;
}

function cipherToBuffer(cipherValue) {
    if (cipherValue == null) return null;
    if (Buffer.isBuffer(cipherValue)) return cipherValue;
    if (cipherValue instanceof Uint8Array) return Buffer.from(cipherValue);
    if (
        typeof cipherValue === "object" &&
        cipherValue.type === "Buffer" &&
        Array.isArray(cipherValue.data)
    ) {
        return Buffer.from(cipherValue.data);
    }
    if (typeof cipherValue === "string") {
        // Legacy text-column corruption: literal JSON-serialised Buffer.
        const fromJson = tryUnwrapBufferJson(cipherValue);
        if (fromJson) return fromJson;

        if (cipherValue.startsWith("\\x") || cipherValue.startsWith("0x")) {
            const hex = cipherValue.startsWith("\\x") ? cipherValue.slice(2) : cipherValue.slice(2);
            const hexBuf = Buffer.from(hex, "hex");
            // Legacy bytea-column corruption: hex-encoded JSON-serialised Buffer.
            // Detect by checking whether the decoded bytes are themselves a
            // JSON string starting with '{'.
            if (hexBuf.length > 0 && hexBuf[0] === 0x7b /* '{' */) {
                const unwrapped = tryUnwrapBufferJson(hexBuf.toString("utf8"));
                if (unwrapped) return unwrapped;
            }
            return hexBuf;
        }
        return Buffer.from(cipherValue, "base64");
    }
    return null;
}

function tryDecryptWithBuffer(encryptedBuffer, keyBuffer) {
    if (!encryptedBuffer || encryptedBuffer.length <= 16) return null;
    try {
        const iv = encryptedBuffer.subarray(0, 16);
        const cipherText = encryptedBuffer.subarray(16);
        const decipher = crypto.createDecipheriv("aes-256-cbc", keyBuffer, iv);
        const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
        const plain = decrypted.toString("utf8").trim();
        return plain || null;
    } catch {
        return null;
    }
}

function decryptAccountNumber(cipherValue) {
    const keyBuffer = getAccountEncryptionKey();
    if (!keyBuffer) return null;

    // Primary path: use whatever cipherToBuffer figures out.
    const primary = cipherToBuffer(cipherValue);
    const fromPrimary = tryDecryptWithBuffer(primary, keyBuffer);
    if (fromPrimary) return fromPrimary;

    // Secondary path: if the primary buffer was actually a JSON string in
    // disguise (e.g. base64-decoded garbage), parse it manually and retry.
    if (typeof cipherValue === "string") {
        const trimmed = cipherValue.trim();
        // Try treating the string as JSON directly.
        const fromJson = tryUnwrapBufferJson(trimmed);
        const fromJsonResult = tryDecryptWithBuffer(fromJson, keyBuffer);
        if (fromJsonResult) return fromJsonResult;

        // Try hex.
        if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
            const hexBuf = Buffer.from(trimmed, "hex");
            const fromHex = tryDecryptWithBuffer(hexBuf, keyBuffer);
            if (fromHex) return fromHex;
        }
    }

    return null;
}

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
    // ── Use the authenticated user's ID — never trust the body ───────────────
    const userId = req.user?.id;

    let {
        collection_id,
        amount,
        account_number: accountNumber,
        account_name: accountName,
        bank_name: userBankName,
        bank_code: providedBankCode,
        payout_account_id: payoutAccountId,
        payoutAccountId: payoutAccountIdCamel,
    } = req.body;

    // Accept either snake_case or camelCase from the FE.
    payoutAccountId = payoutAccountId || payoutAccountIdCamel || null;

    // ── Hydrate missing bank details from the saved payout account ──────────
    // The host frontend can't include `account_number` directly because the
    // full PAN is stored encrypted (account_number_cipher) in payout_accounts
    // — only the last-4 is plaintext. When the user picks a saved account in
    // the WithdrawForm, the FE sends `payout_account_id` and we look up +
    // decrypt the full number here so the admin can read it for the manual
    // payout.
    if (payoutAccountId && (!accountNumber || !accountName || !userBankName)) {
        const { data: payoutAccount, error: payoutErr } = await supabase
            .from("payout_accounts")
            .select("id, user_id, bank_code, bank_name, account_name, account_number_cipher")
            .eq("id", payoutAccountId)
            .eq("user_id", userId)  // ownership check
            .maybeSingle();

        if (payoutErr) {
            console.error("Withdrawal: payout account lookup error:", payoutErr);
            return res.status(500).json({
                error: "Could not load saved bank account.",
                code: "PAYOUT_LOOKUP_FAILED",
                details: payoutErr.message,
            });
        }
        if (!payoutAccount) {
            return res.status(404).json({
                error: "Saved bank account not found or does not belong to you.",
                code: "PAYOUT_NOT_FOUND",
            });
        }

        // Fill in any missing fields from the saved account.
        accountName = accountName || payoutAccount.account_name || null;
        userBankName = userBankName || payoutAccount.bank_name || null;
        providedBankCode = providedBankCode || payoutAccount.bank_code || null;

        if (!accountNumber) {
            const decrypted = decryptAccountNumber(payoutAccount.account_number_cipher);
            if (decrypted) {
                accountNumber = decrypted;
            } else {
                // Legacy unrecoverable ciphertext from the original Buffer-
                // serialisation bug. We log the cipher shape (without the
                // value itself) so we can tell which corruption form this
                // user's row landed in, then return a clear actionable
                // message: delete and re-add the bank.
                const cipher = payoutAccount.account_number_cipher;
                console.error("Withdrawal: unrecoverable account_number_cipher", {
                    payout_account_id: payoutAccountId,
                    type: typeof cipher,
                    isBuffer: Buffer.isBuffer(cipher),
                    isObjectWithBufferType:
                        typeof cipher === "object" &&
                        cipher !== null &&
                        cipher.type === "Buffer",
                    stringPrefix:
                        typeof cipher === "string"
                            ? cipher.slice(0, 6)
                            : null,
                    length:
                        typeof cipher === "string"
                            ? cipher.length
                            : Buffer.isBuffer(cipher)
                            ? cipher.length
                            : null,
                });
                return res.status(409).json({
                    error:
                        "This saved bank account is from an older format and can no longer be decrypted. Please delete it in your bank settings and add it again, then retry the withdrawal.",
                    code: "PAYOUT_LEGACY_UNRECOVERABLE",
                    payout_account_id: payoutAccountId,
                });
            }
        }
    }

    if (!userId || !collection_id || !amount || !accountNumber || !accountName || !userBankName) {
        return res.status(400).json({
            error: "Missing required withdrawal fields",
            // Help the FE / debugger see which one was missing without
            // leaking the values themselves.
            missing: {
                userId: !userId,
                collection_id: !collection_id,
                amount: !amount,
                account_number: !accountNumber,
                account_name: !accountName,
                bank_name: !userBankName,
            },
        });
    }

    // ── Verify the requesting user owns this collection ──────────────────────
    const { data: collection, error: collectionErr } = await supabase
        .from('collections')
        .select('user_id')
        .eq('id', collection_id)
        .single();

    if (collectionErr || !collection) {
        return res.status(404).json({ error: 'Collection not found' });
    }
    if (collection.user_id !== userId) {
        return res.status(403).json({ error: 'Forbidden: you do not own this collection' });
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
        // ── MANUAL WITHDRAWAL FLOW ─────────────────────────────────────────
        // Paystack transfers are NOT used for withdrawals. The admin team
        // processes payouts manually. We previously called Paystack's
        // /transferrecipient endpoint here, which would fail intermittently
        // (live-mode account verification, rate limits, missing transfer
        // permissions on the account) and 500 the whole request — meaning
        // hosts couldn't even SUBMIT a withdrawal.
        //
        // We now skip the Paystack call entirely and persist the bank
        // details in plain readable form on the withdrawal row so the admin
        // panel can display them for manual processing. Bank details are
        // already encrypted at rest in payout_accounts; this row is the
        // operational record the admin reads.
        //
        // bank_code is optional — used only if/when we re-enable automated
        // transfers. We still keep the column for forward compatibility.
        const bankCode = providedBankCode || null;

        // Try to register a Paystack recipient as a best-effort background
        // task so re-enabling automated transfers later is one switch away.
        // Critically: failure here MUST NOT block the withdrawal request.
        let recipientCode = null;
        try {
            if (PAYSTACK_SECRET_KEY && bankCode) {
                const { data: existingRecipient } = await supabase
                    .from("transfer_recipients")
                    .select("recipient_code")
                    .eq("user_id", userId)
                    .eq("account_number", accountNumber)
                    .eq("bank_code", bankCode)
                    .maybeSingle();
                if (existingRecipient?.recipient_code) {
                    recipientCode = existingRecipient.recipient_code;
                }
            }
        } catch (recipientLookupErr) {
            // Non-fatal — just continue without a recipient code.
            console.warn(
                "Withdrawal: recipient lookup failed (non-fatal):",
                recipientLookupErr?.message || recipientLookupErr
            );
        }

        // Insert withdrawal record (status: pending) with readable bank
        // details for the admin. Field shape preserved exactly so the
        // admin panel and any other consumer continue to work:
        //   destination_account.{ accountNumber, bankCode, accountName, bank_name, bank_code }
        const destination_account = {
            accountNumber,
            accountName,
            bank_name: userBankName,
            // Both bank_code and bankCode for backward compat with code that
            // reads either name. Old admin code reads `bank_name || bank_code`.
            bankCode: bankCode || null,
            bank_code: bankCode || null,
        };

        // Local placeholder references. Both `paystack_transfer_code` and
        // `paystack_recipient_code` historically came from Paystack and the
        // columns are NOT NULL in the production schema. We populate both
        // with a clearly-non-Paystack prefix so there's no confusion with
        // real Paystack codes if/when we re-enable automated transfers.
        const uniqueSuffix =
            Date.now().toString(36).toUpperCase() +
            "_" +
            Math.random().toString(36).slice(2, 8).toUpperCase();
        const manualTransferRef = "MAN_" + uniqueSuffix;
        const manualRecipientRef = recipientCode || "RCP_MANUAL_" + uniqueSuffix;

        const insertPayload = {
            user_id: userId,
            collection_id,
            amount: withdrawalAmount,
            status: "pending",
            destination_account,
            paystack_transfer_code: manualTransferRef,
            paystack_recipient_code: manualRecipientRef,
            wallet_id: wallet.id,
        };

        const { data: insertedWithdrawal, error: insertError } = await supabase
            .from("withdrawals")
            .insert([insertPayload])
            .select()
            .single();

        if (insertError || !insertedWithdrawal) {
            // Surface the actual Supabase error so we can diagnose schema
            // mismatches (NOT NULL violations, FK violations, etc.) instead
            // of always returning a generic message.
            console.error("Withdrawal insert error:", {
                message: insertError?.message,
                code: insertError?.code,
                details: insertError?.details,
                hint: insertError?.hint,
            });
            return res.status(500).json({
                error: insertError?.message || "Failed to create withdrawal record",
                code: insertError?.code || "WITHDRAWAL_INSERT_FAILED",
                details: insertError?.details || null,
                hint: insertError?.hint || null,
            });
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
                const displayAccountNumber =
                    accountNumber ||
                    insertedWithdrawal?.destination_account?.accountNumber ||
                    insertedWithdrawal?.destination_account?.account_number ||
                    "";

                // User email
                try {
                    const userHtml = withdrawalRequestTemplate({
                        userName: profile?.full_name || "User",
                        amount,
                        currency: "NGN",
                        withdrawalId: insertedWithdrawal.id,
                        status: "received",
                        accountName,
                        accountNumber: displayAccountNumber,
                        bankName: userBankName,
                        submittedAt: insertedWithdrawal.created_at || new Date().toISOString()
                    });

                    await sendEmail({
                        to: profile?.email,
                        subject: `Withdrawal Request Received - Kolekto`,
                        html: userHtml,
                        text: `We received your withdrawal request of ${amount}. Withdrawal ID: ${insertedWithdrawal.id}. Account Number: ${displayAccountNumber || "N/A"}`
                    });
                    console.log('✅ Withdrawal request email sent to requester');
                } catch (userMailErr) {
                    console.error('Failed to send withdrawal email to user:', userMailErr?.message || userMailErr);
                }

                // Admin email (notify approver). Reads ADMIN_EMAILS / ADMIN_EMAIL
                // from env instead of hardcoded values so non-Gazali admins
                // receive the notification in deployments that override it.
                try {
                    const adminEmailRaw = (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || "").trim();
                    const adminRecipients = adminEmailRaw
                        .split(",")
                        .map((e) => e.trim())
                        .filter(Boolean);
                    const primaryAdmin = adminRecipients[0] || "gazalianfellow@gmail.com";
                    const adminDisplayName = process.env.ADMIN_NAME || "Admin";

                    const approveUrl = `${process.env.FRONTEND_URL || 'https://www.kolekto.com.ng'}/admin/withdrawals/approve?id=${insertedWithdrawal.id}`;
                    const declineUrl = `${process.env.FRONTEND_URL || 'https://www.kolekto.com.ng'}/admin/withdrawals/decline?id=${insertedWithdrawal.id}`;

                    const adminHtml = withdrawalApprovalRequestTemplate({
                        adminName: adminDisplayName,
                        userName: profile?.full_name || "User",
                        amount,
                        currency: "NGN",
                        withdrawalId: insertedWithdrawal.id,
                        accountName,
                        accountNumber: displayAccountNumber,
                        bankName: userBankName,
                        submittedAt: insertedWithdrawal.created_at || new Date().toISOString(),
                        approveUrl,
                        declineUrl
                    });

                    await sendEmail({
                        to: primaryAdmin,
                        cc: adminRecipients.slice(1).length ? adminRecipients.slice(1) : undefined,
                        subject: `Withdrawal Approval Required - ${profile?.full_name || 'Requester'}`,
                        html: adminHtml,
                        text: `A withdrawal request of ${amount} requires your approval. Withdrawal ID: ${insertedWithdrawal.id}.`,
                    });
                    console.log('✅ Withdrawal approval request sent to admin');
                } catch (adminMailErr) {
                    console.error('Failed to send withdrawal approval email to admin:', adminMailErr?.message || adminMailErr);
                }
            } catch (err) {
                console.error("Failed to send withdrawal email to user:", err?.message || err);
            }
            // NOTE: a second, duplicate admin-email block used to live here.
            // It was sending the same approval email twice with identical
            // subject lines. Removed — keep only the single send above.
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

    // Mark withdrawal as approved. The admin panel writes "approved" via
    // direct Supabase update for the manual-payout flow; using the same
    // status here keeps the two paths consistent. Legacy rows with
    // status="success" still count as completed in computeWalletBalances.
    await supabase
        .from("withdrawals")
        .update({ status: "approved", updated_at: new Date().toISOString() })
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

    return res.status(200).json({ success: true, message: "Withdrawal rejected and available balance refunded successfully" });
};
