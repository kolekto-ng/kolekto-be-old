import fs from "fs";
import path from "path";
import { supabase } from "../../utils/client.js";
import { createRecipient, getBanks, verifyAccount } from "../../utils/paystack.js";


export const getProfile = async (req, res, next) => {

    const userId = req.user.id
    console.log(userId);

    const { data: profile, error: profileError } = await supabase
        .from('profiles') // Replace 'profiles' with your actual profile table name
        .select('*') // Select the fields you want to return
        .eq('id', userId) // Assuming profile id matches user id
        .single();

    const { data: userIdentity, error: userIdentityError } = await supabase
        .from('kyc_verifications') // Replace 'profiles' with your actual profile table name
        .select('*') // Select the fields you want to return
        .eq('user_id', userId) // Assuming profile id matches user id
        .single();

    if (profileError) {
        console.log('Profile fetch error:', profileError);
        // You might want to continue without profile data or return an error
        // For now, we'll continue without profile data
    }

    res.status(200).json({ data: { ...profile, ...userIdentity } })
}

export const uploadAvatar = async (req, res, next) => {
    try {
        const userId = req.user.id;
        console.log('Uploading avatar for user:', userId, req.file);

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const file = req.file;
        const fileExt = path.extname(file.originalname).substring(1);
        const fileName = `${userId}.${fileExt}`;
        const filePath = `${userId}/${fileName}`;

        // Read file from disk
        const fileData = fs.readFileSync(file.path);

        // Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
            .from('avatars')
            .upload(filePath, fileData, {
                contentType: file.mimetype,
                upsert: true
            });

        if (uploadError) {
            console.error('Upload error:', uploadError);
            throw uploadError;
        }

        // Get public URL
        const { data: urlData } = supabase.storage
            .from('avatars')
            .getPublicUrl(filePath);

        const publicUrl = urlData.publicUrl;
        console.log('Avatar URL:', publicUrl);

        // Update profile using the authenticated user's session
        const { error: updateError } = await supabase
            .from('profiles')
            .update({
                avatar_url: publicUrl,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        if (updateError) {
            console.error('Update error:', updateError);
            throw updateError;
        }

        // Delete temporary file
        fs.unlinkSync(file.path);

        return res.status(200).json({
            success: true,
            avatarUrl: publicUrl
        });

    } catch (error) {
        // Clean up temp file if error occurred
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        console.error('Avatar upload error:', error);
        next(error);
    }
};


// Get list of banks (via Paystack)
export const fetchBanks = async (req, res) => {
    try {
        const banks = await getBanks();
        const seenCodes = new Set();
        const uniqueBanks = (banks || []).filter((bank) => {
            const code = String(bank?.code || "").trim();
            if (!code || seenCodes.has(code)) return false;
            seenCodes.add(code);
            return true;
        });
        res.json(uniqueBanks);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Verify bank account (via Paystack)
export const verifyBankAccount = async (req, res) => {
    const { account_number, bank_code } = req.body;
    if (!account_number || !bank_code) {
        return res.status(400).json({ error: "Missing fields" });
    }

    try {
        const account = await verifyAccount(account_number, bank_code);
        res.json(account);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Save account into Supabase
import stringSimilarity from "string-similarity";
import {
    encryptAccountNumber,
    isAccountCipherDecryptable,
} from "../../utils/accountEncryption.js";

export const saveAccount = async (req, res) => {
    const {
        payoutAccountId: payout_account_id,
        bankCode: bank_code,
        bankName: bank_name,
        accountNumber: account_number,
        provider = "paystack"
    } = req.body;
    const user_id = req.user.id;

    if (!["paystack", "opay"].includes(provider)) {
        return res.status(400).json({ error: "Invalid provider" });
    }


    try {
        // 1️⃣ Fetch user profile
        const { data: profile, error: profileErr } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("id", user_id)
            .single();
        if (profileErr) throw profileErr;
        if (!profile) return res.status(404).json({ error: "User profile not found" });
        if (!profile.full_name || !profile.full_name.trim()) {
            return res.status(400).json({
                error: "Add your full name to your profile before linking a bank account",
            });
        }
        // i need to end this function if the user is yet to verify their identity

        // 2️⃣ Verify account with provider. Paystack network/5xx errors are
        // surfaced as 502 so the frontend can prompt the user to retry rather
        // than seeing a generic "Internal server error".
        let account_name;
        try {
            const result = await verifyAccount(account_number, bank_code, provider);
            account_name = result?.account_name;
        } catch (verifyErr) {
            const status = verifyErr?.response?.status;
            const message =
                verifyErr?.response?.data?.message ||
                verifyErr?.message ||
                "Bank verification failed. Please try again.";
            // Paystack itself or upstream connectivity issue → 502 (gateway).
            // Anything 4xx from Paystack is mapped through as a 400 to the user.
            const httpStatus = status && status >= 400 && status < 500 ? 400 : 502;
            return res.status(httpStatus).json({
                error: message,
                code: "BANK_VERIFICATION_FAILED",
            });
        }

        if (!account_name) {
            return res.status(400).json({
                error: "Could not resolve account name from bank. Please double-check the details and try again.",
                code: "BANK_VERIFICATION_FAILED",
            });
        }

        // 3️⃣ Fuzzy match profile name with bank account name
        const similarity = stringSimilarity.compareTwoStrings(
            profile.full_name.toLowerCase().trim(),
            account_name.toLowerCase().trim()
        );

        if (similarity < 0.7) {
            return res.status(400).json({
                message: "Bank account name does not sufficiently match profile name",
                data: { profileName: profile.full_name, bankAccountName: account_name, similarityScore: similarity.toFixed(2) }
            });
        }

        // 4️⃣ Create recipient code via provider. Wrap so a Paystack outage
        // here is reported as 502 instead of a generic 500.
        let recipient_code;
        try {
            const recipient = await createRecipient(account_number, bank_code, account_name, provider);
            recipient_code = recipient?.recipient_code;
        } catch (recipientErr) {
            const status = recipientErr?.response?.status;
            const message =
                recipientErr?.response?.data?.message ||
                recipientErr?.message ||
                "Could not register payout recipient. Please try again.";
            const httpStatus = status && status >= 400 && status < 500 ? 400 : 502;
            return res.status(httpStatus).json({
                error: message,
                code: "RECIPIENT_CREATION_FAILED",
            });
        }

        if (!recipient_code) {
            return res.status(502).json({
                error: "Payout recipient was not created. Please try again.",
                code: "RECIPIENT_CREATION_FAILED",
            });
        }

        // 5️⃣ Encrypt account number & get last 4 digits.
        // encryptAccountNumber now returns a base64 string so the value
        // serialises cleanly into the payout_accounts column via PostgREST.
        let encryptedAccount;
        try {
            encryptedAccount = encryptAccountNumber(account_number);
        } catch (encryptErr) {
            console.error("Save Account: encrypt error:", encryptErr?.message || encryptErr);
            return res.status(500).json({
                error: "Server misconfiguration: account encryption unavailable.",
                code: "ENCRYPTION_UNAVAILABLE",
            });
        }
        const last4 = account_number.slice(-4);

        // 6️⃣ Check if user already has payout accounts
        const { data: existingAccounts, error: existingErr } = await supabase
            .from("payout_accounts")
            .select("id, is_default, account_number_cipher")
            .eq("user_id", user_id);

        if (existingErr) throw existingErr;

        // First account ever becomes default. Otherwise, self-heal: if the
        // user's current default is a legacy row that can no longer be
        // decrypted with today's ACCOUNT_ENCRYPTION_KEY, promote this
        // save (new or repaired account) to default instead of leaving
        // withdrawals stuck pointing at a dead row. Without this, "save
        // works, withdrawal still fails" repeats forever — the saved
        // account is fine, it's just never the one withdrawal picks.
        const currentDefault = existingAccounts.find((a) => a.is_default);
        const currentDefaultBroken =
            !!currentDefault && !isAccountCipherDecryptable(currentDefault.account_number_cipher);
        const shouldBeDefault = existingAccounts.length === 0 || currentDefaultBroken;

        // 7️⃣ Safe repair path: update existing account when the same account is being re-verified.
        // This prevents duplicate rows and refreshes legacy ciphertext/recipient metadata.
        let accountToUpdate = null;

        if (payout_account_id) {
            const { data: targetedAccount, error: targetedError } = await supabase
                .from("payout_accounts")
                .select("id, user_id")
                .eq("id", payout_account_id)
                .eq("user_id", user_id)
                .maybeSingle();

            if (targetedError) throw targetedError;
            accountToUpdate = targetedAccount || null;
        }

        if (!accountToUpdate) {
            const { data: matchedAccount, error: matchedError } = await supabase
                .from("payout_accounts")
                .select("id, user_id")
                .eq("user_id", user_id)
                .eq("bank_code", bank_code)
                .eq("account_last4", last4)
                .eq("account_name", account_name)
                .order("updated_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (matchedError) throw matchedError;
            accountToUpdate = matchedAccount || null;
        }

        // Clear any other default for this user before assigning the new
        // one, excluding the row we're about to touch (so repairing the
        // account that's already the default doesn't unset itself).
        if (shouldBeDefault) {
            let clearQuery = supabase
                .from("payout_accounts")
                .update({ is_default: false })
                .eq("user_id", user_id)
                .eq("is_default", true);
            if (accountToUpdate) clearQuery = clearQuery.neq("id", accountToUpdate.id);
            const { error: clearDefaultErr } = await clearQuery;
            if (clearDefaultErr) throw clearDefaultErr;
        }

        if (accountToUpdate) {
            const { data: updatedAccount, error: updateError } = await supabase
                .from("payout_accounts")
                .update({
                    provider,
                    recipient_code,
                    account_number_cipher: encryptedAccount,
                    account_last4: last4,
                    bank_code,
                    bank_name,
                    account_name,
                    ...(shouldBeDefault ? { is_default: true } : {}),
                    updated_at: new Date().toISOString()
                })
                .eq("id", accountToUpdate.id)
                .eq("user_id", user_id)
                .select()
                .single();

            if (updateError) throw updateError;

            return res.status(200).json({
                ...updatedAccount,
                repaired: true
            });
        }

        // 8️⃣ Insert new payout account
        const { data, error } = await supabase
            .from("payout_accounts")
            .insert([{
                user_id,
                provider,
                recipient_code,
                account_number_cipher: encryptedAccount,
                account_last4: last4,
                bank_code,
                bank_name,
                account_name,
                is_default: shouldBeDefault
            }])
            .select()
            .single();

        if (error) throw error;

        res.status(201).json({
            ...data,
            repaired: false
        });
    } catch (err) {
        // Log structured detail server-side (without leaking the cipher) and
        // return a stable error code the frontend can show meaningfully.
        console.error("Save Account Error:", {
            message: err?.message,
            code: err?.code,
            details: err?.details,
            hint: err?.hint,
        });
        return res.status(500).json({
            error: err?.message || "Failed to save bank account.",
            code: err?.code || "SAVE_ACCOUNT_FAILED",
            details: err?.details || null,
        });
    }
};


// Get all accounts for a user
export const getAccounts = async (req, res) => {
    const user_id = req.user.id;
    try {
        const { data, error } = await supabase
            .from("payout_accounts")
            .select("*")
            .eq("user_id", user_id)
            .order("created_at", { ascending: true });

        if (error) throw error;

        // Never return the cipher or plaintext to the client — only a
        // boolean the FE can use to avoid auto-selecting a default account
        // that withdrawal would just reject anyway, and to prompt deletion.
        const annotated = (data || []).map(({ account_number_cipher, ...rest }) => ({
            ...rest,
            is_decryptable: isAccountCipherDecryptable(account_number_cipher),
        }));

        res.status(200).json({ data: annotated, message: 'sucessfully retrieved payout accounts' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Delete a saved payout account. Ownership-checked. If the deleted account
// was the user's default, promote the most-recently-created remaining
// decryptable account so withdrawal isn't left without a usable default.
export const deletePayoutAccount = async (req, res) => {
    const user_id = req.user?.id;
    const account_id = req.params?.id || req.body?.account_id;

    if (!user_id) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    if (!account_id) {
        return res.status(400).json({ error: "account_id is required" });
    }

    try {
        const { data: target, error: lookupErr } = await supabase
            .from("payout_accounts")
            .select("id, user_id, is_default")
            .eq("id", account_id)
            .eq("user_id", user_id)
            .maybeSingle();

        if (lookupErr) throw lookupErr;
        if (!target) {
            return res.status(404).json({
                error: "Account not found or does not belong to you.",
                code: "PAYOUT_NOT_FOUND",
            });
        }

        const { error: deleteErr } = await supabase
            .from("payout_accounts")
            .delete()
            .eq("id", account_id)
            .eq("user_id", user_id);
        if (deleteErr) throw deleteErr;

        if (target.is_default) {
            const { data: remaining, error: remainingErr } = await supabase
                .from("payout_accounts")
                .select("id, account_number_cipher, created_at")
                .eq("user_id", user_id)
                .order("created_at", { ascending: false });
            if (remainingErr) throw remainingErr;

            const nextDefault = (remaining || []).find((a) =>
                isAccountCipherDecryptable(a.account_number_cipher)
            );
            if (nextDefault) {
                const { error: promoteErr } = await supabase
                    .from("payout_accounts")
                    .update({ is_default: true })
                    .eq("id", nextDefault.id)
                    .eq("user_id", user_id);
                if (promoteErr) throw promoteErr;
            }
        }

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error("deletePayoutAccount error:", {
            message: err?.message,
            code: err?.code,
        });
        return res.status(500).json({
            error: err?.message || "Failed to delete account",
            code: err?.code || "DELETE_ACCOUNT_FAILED",
        });
    }
};

// Set default account.
//
// SECURITY (B-5): Previously this route read `user_id` from the request
// body and used it to clear/set defaults — meaning an attacker could pass
// another user's `user_id` and flip the victim's default payout account.
// We now ALWAYS use `req.user.id` (set by verifyToken) and ignore any
// `user_id` the client sends.
export const setDefaultAccount = async (req, res) => {
    const user_id = req.user?.id;
    const { account_id } = req.body || {};

    if (!user_id) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    if (!account_id) {
        return res.status(400).json({ error: "account_id is required" });
    }

    try {
        // Verify ownership of the target account BEFORE any mutation.
        // Avoids accidentally clearing a user's defaults via an invalid id.
        const { data: target, error: lookupErr } = await supabase
            .from("payout_accounts")
            .select("id, user_id")
            .eq("id", account_id)
            .eq("user_id", user_id)
            .maybeSingle();

        if (lookupErr) throw lookupErr;
        if (!target) {
            return res.status(404).json({
                error: "Account not found or does not belong to you.",
                code: "PAYOUT_NOT_FOUND",
            });
        }

        // Clear all of THIS user's defaults (never anyone else's).
        const { error: clearErr } = await supabase
            .from("payout_accounts")
            .update({ is_default: false })
            .eq("user_id", user_id);
        if (clearErr) throw clearErr;

        // Set the chosen default.
        const { data, error } = await supabase
            .from("payout_accounts")
            .update({ is_default: true })
            .eq("id", account_id)
            .eq("user_id", user_id) // double-guard
            .select()
            .single();
        if (error) throw error;

        return res.json(data);
    } catch (err) {
        console.error("setDefaultAccount error:", {
            message: err?.message,
            code: err?.code,
        });
        return res.status(500).json({
            error: err?.message || "Failed to set default account",
            code: err?.code || "SET_DEFAULT_FAILED",
        });
    }
};
