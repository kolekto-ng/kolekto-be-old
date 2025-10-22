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
        res.json(banks);
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
import crypto from "crypto";
import stringSimilarity from "string-similarity";

const ENCRYPTION_KEY = process.env.ACCOUNT_ENCRYPTION_KEY; // 32 chars for AES-256
const IV_LENGTH = 16; // AES block size

// AES-256-CBC encryption
function encryptAccountNumber(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return Buffer.concat([iv, encrypted]); // store IV + ciphertext
}

export const saveAccount = async (req, res) => {
    const {
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
        // i need to end this function if the user is yet to verify their identity

        // 2️⃣ Verify account with provider
        const { account_name } = await verifyAccount(account_number, bank_code, provider);

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

        // 4️⃣ Create recipient code via provider
        const { recipient_code } = await createRecipient(account_number, bank_code, account_name, provider);

        // 5️⃣ Encrypt account number & get last 4 digits
        const encryptedAccount = encryptAccountNumber(account_number);
        const last4 = account_number.slice(-4);

        // 6️⃣ Check if user already has payout accounts
        const { data: existingAccounts, error: existingErr } = await supabase
            .from("payout_accounts")
            .select("id")
            .eq("user_id", user_id);

        if (existingErr) throw existingErr;

        const is_default = existingAccounts.length === 0; // first account becomes default

        // i also want to confirm the bank they are adding account name corresponds with their profile name


        // 7️⃣ Insert payout account
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
                is_default
            }])
            .select()
            .single();

        if (error) throw error;

        res.status(201).json(data);
    } catch (err) {
        console.error("Save Account Error:", err);
        res.status(500).json({ error: err.message });
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

        res.status(200).json({ data, message: 'sucessfully retrieved payout accounts' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Set default account
export const setDefaultAccount = async (req, res) => {
    const { user_id, account_id } = req.body;

    try {
        // clear all defaults
        const { error: clearErr } = await supabase
            .from("payout_accounts")
            .update({ is_default: false })
            .eq("user_id", user_id);

        if (clearErr) throw clearErr;

        // set chosen default
        const { data, error } = await supabase
            .from("payout_accounts")
            .update({ is_default: true })
            .eq("id", account_id)
            .eq("user_id", user_id)
            .select()
            .single();

        if (error) throw error;

        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};