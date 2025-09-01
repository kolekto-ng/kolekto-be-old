import { supabase } from "../../utils/client.js";

// assumes you're using something like multer for file uploads
export const uploadDocument = async (req, res, next) => {
    try {
        const { userId, documentType, verificationType } = req.body;
        const uploadedFiles = req.files; // array of files from multer

        if (!userId || !documentType || !verificationType) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        if (!uploadedFiles || uploadedFiles.length === 0) {
            return res.status(400).json({ error: "No files uploaded" });
        }

        // 1️⃣ Create a parent verification request in kyc_documents
        const { data: docRow, error: docError } = await supabase
            .from("kyc_documents")
            .insert([
                {
                    user_id: userId,
                    document_type: documentType,   // "identity" | "address" | "bvn" | "bank"
                    verification_type: verificationType, // e.g. "NIN", "Utility Bill"
                    status: "pending"
                }
            ])
            .select("id")
            .single();

        if (docError) throw docError;
        const documentId = docRow.id;

        // 2️⃣ Upload each file to Supabase Storage + record in kyc_files
        for (let i = 0; i < uploadedFiles.length; i++) {
            const file = uploadedFiles[i];
            const filePath = `${userId}/${Date.now()}-${file.originalname}`;

            // Upload to Supabase Storage
            const { error: storageError } = await supabase.storage
                .from("kyc-documents")
                .upload(filePath, file.buffer, {
                    cacheControl: "3600",
                    upsert: false,
                    contentType: file.mimetype,
                });

            if (storageError) throw storageError;

            // Insert file metadata into kyc_files
            const { error: fileError } = await supabase.from("kyc_files").insert([
                {
                    document_id: documentId,
                    file_path: filePath,
                    file_name: file.originalname,
                    file_size: file.size,
                    file_type: file.mimetype,
                },
            ]);

            if (fileError) throw fileError;
        }

        return res.json({ success: true, document_id: documentId });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Upload failed", details: err.message });
    }
};

export const getDocuments = async (req, res) => {
    try {
        const { userId } = req.params;

        // 1️⃣ Fetch KYC documents for user
        const { data: documents, error: docError } = await supabase
            .from("kyc_documents")
            .select("id, document_type, verification_type, status, created_at")
            .eq("user_id", userId);

        if (docError) throw docError;

        if (!documents || documents.length === 0) {
            return res.json({ documents: [] });
        }

        // 2️⃣ Fetch files for each document
        const documentIds = documents.map((d) => d.id);
        const { data: files, error: fileError } = await supabase
            .from("kyc_files")
            .select("id, document_id, file_path, file_name, file_type, file_size, uploaded_at")
            .in("document_id", documentIds);

        if (fileError) throw fileError;

        // 3️⃣ Attach signed URLs
        const filesWithUrls = await Promise.all(
            files.map(async (f) => {
                const { data: signedUrlData, error: urlError } = await supabase.storage
                    .from("kyc-documents")
                    .createSignedUrl(f.file_path, 60 * 10); // 10 min expiry

                if (urlError) throw urlError;

                return {
                    ...f,
                    signed_url: signedUrlData.signedUrl,
                };
            })
        );

        // 4️⃣ Merge docs + files
        const result = documents.map((doc) => ({
            ...doc,
            files: filesWithUrls.filter((f) => f.document_id === doc.id),
        }));

        return res.json({ documents: result });
    } catch (err) {
        console.error("Retrieve error:", err);
        return res.status(500).json({ error: "Failed to fetch documents", details: err.message });
    }
}