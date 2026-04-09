import { supabase } from "../../utils/client.js";

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

        // Encrypt NIN with AES-256-CBC using the same key used for account numbers
        const ENCRYPTION_KEY = process.env.ACCOUNT_ENCRYPTION_KEY;
        const IV_LENGTH = 16;
        let ninCipher = null;
        if (ENCRYPTION_KEY) {
            const crypto = await import("node:crypto");
            const iv = crypto.randomBytes(IV_LENGTH);
            const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY), iv);
            let encrypted = cipher.update(nin);
            encrypted = Buffer.concat([encrypted, cipher.final()]);
            ninCipher = Buffer.concat([iv, encrypted]).toString('hex');
        }

        // Hash the NIN for lookup/comparison (SHA-256)
        const cryptoMod = await import("node:crypto");
        const ninHash = cryptoMod.createHash("sha256").update(nin).digest("hex");
        const ninLast4 = nin.slice(-4);

        // Upsert user_identity record
        const { error: upsertError } = await supabase
            .from("user_identity")
            .upsert({
                user_id: userId,
                nin_hash: ninHash,
                nin_last4: ninLast4,
                ...(ninCipher ? { nin_cipher: ninCipher } : {}),
                updated_at: new Date().toISOString(),
            }, { onConflict: "user_id" });

        if (upsertError) throw upsertError;

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