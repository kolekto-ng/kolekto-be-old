import { supabase } from "../../utils/client.js";
import crypto from "crypto";

function getKeyBuffer() {
    const raw = process.env.ACCOUNT_ENCRYPTION_KEY;
    if (!raw) return null;
    // Allow either:
    // - a 32-byte raw string
    // - a 64-char hex string (32 bytes)
    // - any passphrase (we derive a 32-byte key via SHA-256)
    let buf = Buffer.from(raw, "utf8");
    if (buf.length !== 32 && /^[0-9a-fA-F]{64}$/.test(raw)) {
        buf = Buffer.from(raw, "hex");
    }
    if (buf.length === 32) return buf;
    return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function encryptSensitive(value, keyBuffer) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", keyBuffer, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, encrypted]).toString("base64");
}

function sha256(value) {
    return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

// assumes you're using something like multer for file uploads
export const uploadDocument = async (req, res, next) => {
    const insertedDocs = [];
    const uploadedPaths = [];

    try {
        const userId = req.user.id;
        const { documentType, verificationType } = req.body;
        const uploadedFiles = req.files;
        console.log("Files received:", uploadedFiles, userId, documentType, verificationType);

        if (!userId || !documentType || !verificationType) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        if (!uploadedFiles || uploadedFiles.length === 0) {
            return res.status(400).json({ error: "No files uploaded" });
        }

        // 0️⃣ Ensure KYC verification record exists and is pending
        let kycVerificationId;
        let previousKycStatus = null;

        const { data: existingKyc, error: kycError } = await supabase
            .from("kyc_verifications")
            .select("id, status")
            .eq("user_id", userId)
            .single();

        if (kycError && kycError.code !== "PGRST116") {
            console.error("DB error (kyc_verifications):", kycError);
            throw new Error("Failed to check KYC verification");
        }

        if (!existingKyc) {
            const { data: newKyc, error: newKycError } = await supabase
                .from("kyc_verifications")
                .insert([{ user_id: userId, status: "pending" }])
                .select("id")
                .single();

            if (newKycError) throw new Error(`Failed to create KYC verification: ${newKycError.message}`);
            kycVerificationId = newKyc.id;
            insertedDocs.push({ table: "kyc_verifications", id: kycVerificationId });
        } else {
            previousKycStatus = existingKyc.status;
            const { data: updatedKyc, error: updateKycError } = await supabase
                .from("kyc_verifications")
                .update({ status: "pending", updated_at: new Date().toISOString() })
                .eq("id", existingKyc.id)
                .select("id")
                .single();

            if (updateKycError) throw new Error(`Failed to update KYC verification: ${updateKycError.message}`);
            kycVerificationId = updatedKyc.id;
        }

        // 1️⃣ Create parent verification request (kyc_documents)
        const { data: docRow, error: docError } = await supabase
            .from("kyc_documents")
            .insert([{
                user_id: userId,
                document_type: documentType,
                verification_type: verificationType,
                status: "pending"
            }])
            .select("id")
            .single();

        if (docError) throw new Error(`Failed to insert kyc_documents: ${docError.message}`);
        const documentId = docRow.id;
        insertedDocs.push({ table: "kyc_documents", id: documentId });

        // 2️⃣ Upload each file to Supabase Storage + record in kyc_files
        for (let i = 0; i < uploadedFiles.length; i++) {
            const file = uploadedFiles[i];
            const filePath = `${userId}/${Date.now()}-${file.originalname}`;
            console.log("Uploading file:", file.size);

            const { error: storageError } = await supabase.storage
                .from("kyc-documents")
                .upload(filePath, file.buffer, {
                    upsert: false,
                    contentType: file.mimetype,
                });

            if (storageError) throw new Error(`Failed to upload to storage: ${storageError.message}`);
            uploadedPaths.push(filePath);
            console.log("Uploaded to storage:", filePath);

            const { error: fileError } = await supabase.from("kyc_files").insert([{
                document_id: documentId,
                file_path: filePath,
                file_name: file.originalname,
                file_size: file.size,
                file_type: file.mimetype,
            }]);

            if (fileError) throw new Error(`Failed to insert kyc_files: ${fileError.message}`);
        }

        return res.json({
            success: true,
            document_id: documentId,
            kyc_verification_id: kycVerificationId
        });

    } catch (err) {
        console.error("General error (uploadDocument):", err);

        // 🔄 Rollback uploaded files
        if (uploadedPaths.length > 0) {
            try {
                await supabase.storage.from("kyc-documents").remove(uploadedPaths);
                console.log("Rolled back uploaded files:", uploadedPaths);
            } catch (rollbackErr) {
                console.error("Rollback failed (storage):", rollbackErr.message);
            }
        }

        // 🔄 Rollback inserted records (reverse order)
        for (const record of insertedDocs.reverse()) {
            try {
                await supabase.from(record.table).delete().eq("id", record.id);
                console.log(`Rolled back ${record.table}: ${record.id}`);
            } catch (rollbackErr) {
                console.error(`Rollback failed (${record.table}):`, rollbackErr.message);
            }
        }

        // 🔄 Restore old KYC status if needed
        if (previousKycStatus) {
            try {
                await supabase
                    .from("kyc_verifications")
                    .update({ status: previousKycStatus, updated_at: new Date().toISOString() })
                    .eq("user_id", req.user.id);
                console.log(`Restored previous KYC status: ${previousKycStatus}`);
            } catch (restoreErr) {
                console.error("Failed to restore previous KYC status:", restoreErr.message);
            }
        }

        return res.status(500).json({ error: "Upload failed", details: err.message });
    }
};


export const saveNIN = async (req, res) => {
    try {
        const userId = req.user.id;
        const { nin } = req.body;

        if (!nin || !/^\d{11}$/.test(nin)) {
            return res.status(400).json({ error: "NIN must be exactly 11 digits" });
        }

        // Encrypt NIN with AES-256-CBC using the same key used for account numbers.
        // AES-256 requires exactly 32 bytes — derive a stable 32-byte key via SHA-256
        // so any length of ACCOUNT_ENCRYPTION_KEY works without throwing "Invalid key length".
        const ENCRYPTION_KEY = process.env.ACCOUNT_ENCRYPTION_KEY;
        const IV_LENGTH = 16;
        let ninCipher = null;
        if (ENCRYPTION_KEY) {
            const crypto = await import("node:crypto");
            // SHA-256 digest is always 32 bytes — safe to use as AES-256 key
            const aesKey = crypto.createHash("sha256").update(ENCRYPTION_KEY).digest();
            const iv = crypto.randomBytes(IV_LENGTH);
            const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
            let encrypted = cipher.update(nin);
            encrypted = Buffer.concat([encrypted, cipher.final()]);
            ninCipher = Buffer.concat([iv, encrypted]).toString('hex');
        }

        // Hash the NIN for lookup/comparison (SHA-256)
        const cryptoMod = await import("node:crypto");
        const ninHash = cryptoMod.createHash("sha256").update(nin).digest("hex");
        const ninLast4 = nin.slice(-4);

        // Ensure a KYC verification row exists so admin approval can toggle
        // nin_verified and the frontend subscription has a record to watch.
        const { data: existingKyc, error: kycLookupError } = await supabase
            .from("kyc_verifications")
            .select("id, status")
            .eq("user_id", userId)
            .maybeSingle();

        if (kycLookupError) throw kycLookupError;

        if (existingKyc?.id) {
            if (existingKyc.status === "not_started") {
                const { error: kycUpdateError } = await supabase
                    .from("kyc_verifications")
                    .update({
                        status: "pending",
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", existingKyc.id);

                if (kycUpdateError) throw kycUpdateError;
            }
        } else {
            const { error: kycInsertError } = await supabase
                .from("kyc_verifications")
                .insert({
                    user_id: userId,
                    status: "pending",
                    nin_verified: false,
                    identity_verified: false,
                    address_verified: false,
                });

            if (kycInsertError) throw kycInsertError;
        }

        const identityPayload = {
            user_id: userId,
            nin_hash: ninHash,
            nin_last4: ninLast4,
            ...(ninCipher ? { nin_cipher: ninCipher } : {}),
            updated_at: new Date().toISOString(),
        };

        // Avoid fragile upsert(onConflict: "user_id") behavior when the database
        // does not have the exact UNIQUE constraint shape Supabase expects.
        const { data: existingIdentity, error: lookupError } = await supabase
            .from("user_identity")
            .select("id")
            .eq("user_id", userId)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();

        if (lookupError) throw lookupError;

        if (existingIdentity?.id) {
            const { error: updateError } = await supabase
                .from("user_identity")
                .update(identityPayload)
                .eq("id", existingIdentity.id);

            if (updateError) throw updateError;
        } else {
            // Some deployments define BVN fields as required on insert even when BVN
            // has not been captured yet. Seed them with safe placeholders so NIN can
            // still be stored and later replaced by the real BVN values.
            const { error: insertError } = await supabase
                .from("user_identity")
                .insert({
                    ...identityPayload,
                    bvn_hash: "",
                    bvn_last4: "",
                    bvn_cipher: "",
                });

            if (insertError) throw insertError;
        }

        return res.json({ success: true, message: "NIN saved successfully" });
    } catch (err) {
        console.error("saveNIN error:", err);
        return res.status(500).json({ error: "Failed to save NIN", details: err.message });
    }
};

export const getDocuments = async (req, res) => {
    try {
        const userId = req.user.id;

        // 1️⃣ Fetch KYC documents for user
        const { data: documents, error: docError } = await supabase
            .from("kyc_documents")
            .select("id, document_type, verification_type, status, uploaded_at")
            .eq("user_id", userId);

        if (docError) {
            console.error("DB error (kyc_documents):", docError);
            return res.status(500).json({ error: "Failed to fetch kyc_documents", details: docError.message });
        }

        if (!documents || documents.length === 0) {
            return res.json({ documents: [] });
        }

        // 2️⃣ Fetch files for each document
        const documentIds = documents.map((d) => d.id);
        const { data: files, error: fileError } = await supabase
            .from("kyc_files")
            .select("id, document_id, file_path, file_name, file_type, file_size, uploaded_at")
            .in("document_id", documentIds);

        if (fileError) {
            console.error("DB error (kyc_files):", fileError);
            return res.status(500).json({ error: "Failed to fetch kyc_files", details: fileError.message });
        }

        // 3️⃣ Attach signed URLs
        const filesWithUrls = await Promise.all(
            files.map(async (f) => {
                try {
                    const { data: signedUrlData, error: urlError } = await supabase.storage
                        .from("kyc-documents")
                        .createSignedUrl(f.file_path, 60 * 10); // 10 min expiry

                    if (urlError || !signedUrlData) {
                        console.warn(`Storage error (kyc-documents): File not found or cannot create signed URL for path: ${f.file_path}`, urlError);
                        return {
                            ...f,
                            signed_url: null,
                            signed_url_error: urlError ? urlError.message : "File not found"
                        };
                    }

                    return {
                        ...f,
                        signed_url: signedUrlData.signedUrl,
                    };
                } catch (storageErr) {
                    console.error(`Exception during signed URL creation for file_path: ${f.file_path}`, storageErr);
                    return {
                        ...f,
                        signed_url: null,
                        signed_url_error: storageErr.message
                    };
                }
            })
        );

        // 4️⃣ Merge docs + files
        const result = documents.map((doc) => ({
            ...doc,
            files: filesWithUrls.filter((f) => f.document_id === doc.id),
        }));

        return res.json({ documents: result });
    } catch (err) {
        console.error("General error (getDocuments):", err);
        return res.status(500).json({ error: "Failed to fetch documents", details: err.message });
    }
}

export const saveNIN = async (req, res) => {
    const userId = req.user?.id;
    const nin = String(req.body?.nin || "").trim();

    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    if (!/^\d{11}$/.test(nin)) {
        return res.status(400).json({ error: "NIN must be 11 digits" });
    }

    const keyBuffer = getKeyBuffer();
    if (!keyBuffer) {
        return res.status(500).json({ error: "Server misconfigured: missing ACCOUNT_ENCRYPTION_KEY" });
    }

    const nin_last4 = nin.slice(-4);
    const nin_hash = sha256(nin);
    const nin_cipher = encryptSensitive(nin, keyBuffer);

    try {
        // `user_identity` has required BVN columns in the current schema.
        // So we must:
        // - update NIN columns if the row exists
        // - otherwise insert a row with BVN placeholders (empty strings) and later overwrite them when BVN is submitted
        const { data: existingIdentity, error: identityFetchErr } = await supabase
            .from("user_identity")
            .select("id, bvn_cipher, bvn_hash, bvn_last4")
            .eq("user_id", userId)
            .maybeSingle();

        if (identityFetchErr) {
            console.error("user_identity fetch error:", identityFetchErr);
            return res.status(500).json({ error: "Failed to save NIN", details: identityFetchErr.message });
        }

        let identityErr = null;
        if (existingIdentity?.id) {
            const { error } = await supabase
                .from("user_identity")
                .update({
                    nin_cipher,
                    nin_hash,
                    nin_last4,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", existingIdentity.id);
            identityErr = error;
        } else {
            const { error } = await supabase.from("user_identity").insert([
                {
                    user_id: userId,
                    // BVN placeholders (schema requires these as non-null strings and `bvn_hash` is UNIQUE).
                    // We generate per-user unique placeholders so NIN can be saved before BVN is submitted,
                    // without violating the unique constraint.
                    bvn_cipher: encryptSensitive(`__BVN_PENDING__:${userId}`, keyBuffer),
                    bvn_hash: sha256(`__BVN_PENDING__:${userId}`),
                    bvn_last4: "0000",
                    nin_cipher,
                    nin_hash,
                    nin_last4,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                },
            ]);
            identityErr = error;
        }

        if (identityErr) {
            console.error("user_identity write error:", identityErr);
            return res.status(500).json({ error: "Failed to save NIN", details: identityErr.message });
        }

        // Ensure a KYC verification record exists for admin workflow.
        const { data: existingKyc, error: kycFetchErr } = await supabase
            .from("kyc_verifications")
            .select("id")
            .eq("user_id", userId)
            .maybeSingle();

        if (kycFetchErr) {
            console.error("kyc_verifications fetch error:", kycFetchErr);
            return res.status(500).json({ error: "Failed to update KYC status" });
        }

        if (!existingKyc) {
            const { error: kycInsertErr } = await supabase
                .from("kyc_verifications")
                .insert([{ user_id: userId, status: "pending", nin_verified: false }]);
            if (kycInsertErr) {
                console.error("kyc_verifications insert error:", kycInsertErr);
                return res.status(500).json({ error: "Failed to create KYC verification record" });
            }
        } else {
            const { error: kycUpdateErr } = await supabase
                .from("kyc_verifications")
                .update({ status: "pending", nin_verified: false, updated_at: new Date().toISOString() })
                .eq("id", existingKyc.id);
            if (kycUpdateErr) {
                console.error("kyc_verifications update error:", kycUpdateErr);
                return res.status(500).json({ error: "Failed to update KYC verification record" });
            }
        }

        return res.status(200).json({ success: true, nin_last4 });
    } catch (err) {
        console.error("saveNIN error:", err);
        return res.status(500).json({ error: err?.message || "Failed to save NIN" });
    }
};
