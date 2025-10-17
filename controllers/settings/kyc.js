import { supabase } from "../../utils/client.js";

// assumes you're using something like multer for file uploads
export const uploadDocument = async (req, res, next) => {
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
        const { data: existingKyc, error: kycError } = await supabase
            .from("kyc_verifications")
            .select("id, status")
            .eq("user_id", userId)
            .single();

        if (kycError && kycError.code !== "PGRST116") {
            // Not a "no rows found" error
            console.error("DB error (kyc_verifications):", kycError);
            return res.status(500).json({ error: "Failed to check KYC verification", details: kycError.message });
        }

        if (!existingKyc) {
            // Create new KYC verification record
            const { data: newKyc, error: newKycError } = await supabase
                .from("kyc_verifications")
                .insert([{ user_id: userId, status: "pending" }])
                .select("id")
                .single();
            if (newKycError) {
                console.error("DB error (create kyc_verifications):", newKycError);
                return res.status(500).json({ error: "Failed to create KYC verification", details: newKycError.message });
            }
            kycVerificationId = newKyc.id;
        } else {
            // Update existing KYC verification record to pending and update timestamp
            const { data: updatedKyc, error: updateKycError } = await supabase
                .from("kyc_verifications")
                .update({ status: "pending", updated_at: new Date().toISOString() })
                .eq("id", existingKyc.id)
                .select("id")
                .single();
            if (updateKycError) {
                console.error("DB error (update kyc_verifications):", updateKycError);
                return res.status(500).json({ error: "Failed to update KYC verification", details: updateKycError.message });
            }
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

        if (docError) {
            console.error("DB error (kyc_documents):", docError);
            return res.status(500).json({ error: "Failed to insert kyc_documents", details: docError.message });
        }
        const documentId = docRow.id;

        // 2️⃣ Upload each file to Supabase Storage + record in kyc_files
        for (let i = 0; i < uploadedFiles.length; i++) {
            const file = uploadedFiles[i];
            const filePath = `${userId}/${Date.now()}-${file.originalname}`;
            console.log("Uploading file:", file.size);

            // Upload to Supabase Storage
            const { error: storageError } = await supabase.storage
                .from("kyc-documents")
                .upload(filePath, file.buffer, {
                    // cacheControl: "3600",
                    upsert: false,
                    contentType: file.mimetype,
                });

            if (storageError) {
                console.error("Storage error (kyc-documents):", storageError);
                return res.status(500).json({ error: "Failed to upload to storage", details: storageError.message });
            }
            console.log("Uploaded to storage:", filePath);

            // Insert file metadata into kyc_files
            const { error: fileError } = await supabase.from("kyc_files").insert([{
                document_id: documentId,
                file_path: filePath,
                file_name: file.originalname,
                file_size: file.size,
                file_type: file.mimetype,
            }]);

            if (fileError) {
                console.error("DB error (kyc_files):", fileError);
                return res.status(500).json({ error: "Failed to insert kyc_files", details: fileError.message });
            }
        }

        return res.json({ success: true, document_id: documentId, kyc_verification_id: kycVerificationId });
    } catch (err) {
        console.error("General error (uploadDocument):", err);
        return res.status(500).json({ error: "Upload failed", details: err.message });
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