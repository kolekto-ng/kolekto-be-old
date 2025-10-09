import { supabase } from "../../utils/client.js";

// GET /admin/kyc-documents
export const getAllKycDocuments = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("kyc_documents")
            .select(`
                id,
                user_id,
                document_type,
                verification_type,
                status,
                created_at,
                users (
                    full_name,
                    email,
                    phone
                )
            `)
            .order("created_at", { ascending: false });

        if (error) throw error;
        return res.json({ documents: data });
    } catch (err) {
        return res.status(500).json({ error: "Failed to fetch KYC documents", details: err.message });
    }
};

// GET /admin/kyc-documents/:userId
export const getUserKycDocuments = async (req, res) => {
    try {
        const { userId } = req.params;

        // Get all KYC documents for user
        const { data: documents, error: docError } = await supabase
            .from("kyc_documents")
            .select("id, document_type, verification_type, status, created_at")
            .eq("user_id", userId);

        if (docError) throw docError;

        if (!documents || documents.length === 0) {
            return res.json({ documents: [] });
        }

        // Get all files for these documents
        const documentIds = documents.map(d => d.id);
        const { data: files, error: fileError } = await supabase
            .from("kyc_files")
            .select("id, document_id, file_path, file_name, file_type, file_size, uploaded_at")
            .in("document_id", documentIds);

        if (fileError) throw fileError;

        // Attach files to their documents
        const result = documents.map(doc => ({
            ...doc,
            files: files.filter(f => f.document_id === doc.id)
        }));

        return res.json({ documents: result });
    } catch (err) {
        return res.status(500).json({ error: "Failed to fetch user KYC documents", details: err.message });
    }
};

// GET /admin/kyc-verifications
export const getKycVerifications = async (req, res) => {
    try {
        // 1. Fetch all KYC verifications
        const { data: kycs, error: kycError } = await supabase
            .from("kyc_verifications")
            .select("*")
            .order("updated_at", { ascending: false });

        if (kycError) throw kycError;

        // 2. Fetch all profiles for those user_ids
        const userIds = kycs.map(k => k.user_id);
        const { data: profiles, error: profileError } = await supabase
            .from("profiles")
            .select("id, full_name, email, phone_number, avatar_url, created_at")
            .in("id", userIds);

        if (profileError) throw profileError;

        // 3. Attach profile to each KYC verification
        const profilesMap = Object.fromEntries(profiles.map(p => [p.id, p]));
        const result = kycs.map(k => ({
            ...k,
            profile: profilesMap[k.user_id] || null
        }));

        return res.json({ kycs: result });
    } catch (err) {
        return res.status(500).json({ message: "Failed to fetch KYC verifications", details: err.message });
    }
};

// GET /admin/kyc-verifications/:id
// GET /admin/kyc-verifications/:id
export const getSingleKycVerification = async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Fetch the KYC verification record
        const { data: kyc, error: kycError } = await supabase
            .from("kyc_verifications")
            .select("*")
            .eq("id", id)
            .single();

        if (kycError || !kyc) {
            return res.status(404).json({ error: "KYC verification not found" });
        }

        // 2. Fetch the user's profile
        const { data: profile } = await supabase
            .from("profiles")
            .select("id, full_name, email, phone_number, avatar_url, created_at, date_of_birth, address")
            .eq("id", kyc.user_id)
            .single();

        // 3. Fetch KYC documents for this user
        const { data: documents } = await supabase
            .from("kyc_documents")
            .select("id, document_type, verification_type, status, uploaded_at")
            .eq("user_id", kyc.user_id);

        // 4. Fetch files for these documents
        const documentIds = documents?.map(d => d.id) || [];
        let files = [];
        console.log(documents, 'documents');


        if (documentIds.length > 0) {
            const { data: fileRows } = await supabase
                .from("kyc_files")
                .select("id, document_id, file_path, file_name, file_type, file_size, uploaded_at")
                .in("document_id", documentIds);

            // ✅ Generate signed URLs for all files
            if (fileRows?.length > 0) {
                const filesWithUrls = await Promise.all(
                    fileRows.map(async (file) => {
                        console.log(file)
                        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
                            .from("kyc-documents") // <-- replace with your actual storage bucket name
                            .createSignedUrl(file.file_path, 60 * 60); // 1 hour expiry
                        console.log(signedUrlData)
                        if (signedUrlError) {
                            console.error("Error generating signed URL:", signedUrlError);
                            return { ...file, signed_url: null };
                        }

                        return { ...file, signed_url: signedUrlData.signedUrl };
                    })
                );

                files = filesWithUrls;
            }
        }

        // 5. Organize documents by type
        const identityDocs = [];
        const addressDocs = [];

        for (const doc of documents || []) {
            const docFiles = files
                .filter(f => f.document_id === doc.id)
                .map(f => ({
                    type: doc.verification_type,
                    status: doc.status,
                    uploadedAt: f.uploaded_at,
                    fileUrl: f.signed_url || f.file_path, // Prefer signed URL if available
                    fileSize: f.file_size,
                    fileName: f.file_name
                }));

            if (doc.document_type === "identity") identityDocs.push(...docFiles);
            if (doc.document_type === "address") addressDocs.push(...docFiles);
        }

        // 6. Fetch bank verification
        const { data: bank } = await supabase
            .from("bank_verifications")
            .select("bank_name, account_number, account_name, bvn, status, verified_at")
            .eq("user_id", kyc.user_id)
            .single();

        // 7. Fetch verification history
        const { data: history } = await supabase
            .from("kyc_verification_history")
            .select("action, timestamp, admin_id, admin_name, notes")
            .eq("kyc_id", kyc.id);

        // 8. Compose response
        return res.json({
            id: kyc.id,
            user_id: kyc.user_id,
            status: kyc.status,
            overallRiskScore: kyc.overall_risk_score || null,
            profile: profile || null,
            identityVerification: {
                status: identityDocs.length > 0 ? identityDocs[0].status : "pending",
                documents: identityDocs
            },
            addressVerification: {
                status: addressDocs.length > 0 ? addressDocs[0].status : "pending",
                documents: addressDocs
            },
            bankVerification: bank
                ? {
                    bankName: bank.bank_name,
                    accountNumber: bank.account_number,
                    accountName: bank.account_name,
                    bvn: bank.bvn,
                    status: bank.status,
                    verifiedAt: bank.verified_at
                }
                : null,
            verificationHistory: history || []
        });

    } catch (err) {
        console.error("Error fetching KYC details:", err);
        return res.status(500).json({
            message: "Failed to fetch KYC details",
            details: err.message
        });
    }
};

export const getSingleKycVerifition = async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Fetch the KYC verification record
        const { data: kyc, error: kycError } = await supabase
            .from("kyc_verifications")
            .select("*")
            .eq("id", id)
            .single();

        if (kycError || !kyc) {
            return res.status(404).json({ error: "KYC verification not found" });
        }

        // 2. Fetch the user's profile
        const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("id, full_name, email, phone_number, avatar_url, created_at, date_of_birth, address")
            .eq("id", kyc.user_id)
            .single();

        // 3. Fetch KYC documents for this user
        const { data: documents, error: docError } = await supabase
            .from("kyc_documents")
            .select("id, document_type, verification_type, status, created_at")
            .eq("user_id", kyc.user_id);

        // 4. Fetch files for these documents
        const documentIds = documents?.map(d => d.id) || [];
        let files = [];
        if (documentIds.length > 0) {
            const { data: fileRows } = await supabase
                .from("kyc_files")
                .select("id, document_id, file_path, file_name, file_type, file_size, uploaded_at")
                .in("document_id", documentIds);

            files = fileRows || [];
        }

        // 5. Organize documents by type for identity and address
        const identityDocs = [];
        const addressDocs = [];
        for (const doc of documents || []) {
            const docFiles = files.filter(f => f.document_id === doc.id).map(f => ({
                type: doc.verification_type,
                status: doc.status,
                uploadedAt: f.uploaded_at,
                fileUrl: f.file_path, // You may want to generate a signed URL here
                fileSize: f.file_size,
                fileName: f.file_name
            }));
            if (doc.document_type === "identity") identityDocs.push(...docFiles);
            if (doc.document_type === "address") addressDocs.push(...docFiles);
        }

        // 6. Fetch bank verification (if you have a table for this)
        // Example: bank_verifications table with user_id
        const { data: bank, error: bankError } = await supabase
            .from("bank_verifications")
            .select("bank_name, account_number, account_name, bvn, status, verified_at")
            .eq("user_id", kyc.user_id)
            .single();

        // 7. Fetch BVN verification (if you have a table for this)
        // const { data: bvn, error: bvnError } = await supabase
        //     .from("bvn_verifications")
        //     .select("status, bvn, bvn_data, match_score, verified_at, has_discrepancies, discrepancies")
        //     .eq("user_id", kyc.user_id)
        //     .single();

        // 8. Fetch security data (if you have a table for this)
        // const { data: security, error: secError } = await supabase
        //     .from("user_security")
        //     .select("last_login, login_attempts")
        //     .eq("user_id", kyc.user_id)
        //     .single();

        // 9. Fetch verification history (if you have a table for this)
        const { data: history, error: histError } = await supabase
            .from("kyc_verification_history")
            .select("action, timestamp, admin_id, admin_name, notes")
            .eq("kyc_id", kyc.id);

        // 10. Compose response
        return res.json({
            id: kyc.id,
            user_id: kyc.user_id,
            status: kyc.status,
            overallRiskScore: kyc.overall_risk_score || null,
            profile: profile || null,
            // bvnVerification: bvn
            //     ? {
            //         status: bvn.status,
            //         bvn: bvn.bvn,
            //         bvnData: bvn.bvn_data,
            //         matchScore: bvn.match_score,
            //         verifiedAt: bvn.verified_at,
            //         hasDiscrepancies: bvn.has_discrepancies,
            //         discrepancies: bvn.discrepancies || []
            //     }
            //     : null,
            identityVerification: {
                status: identityDocs.length > 0 ? identityDocs[0].status : "pending",
                documents: identityDocs
            },
            addressVerification: {
                status: addressDocs.length > 0 ? addressDocs[0].status : "pending",
                documents: addressDocs
            },
            bankVerification: bank
                ? {
                    bankName: bank.bank_name,
                    accountNumber: bank.account_number,
                    accountName: bank.account_name,
                    bvn: bank.bvn,
                    status: bank.status,
                    verifiedAt: bank.verified_at
                }
                : null,
            // securityData: security
            //     ? {
            //         lastLogin: security.last_login,
            //         loginAttempts: security.login_attempts || []
            //     }
            //     : null,
            verificationHistory: history || []
        });
    } catch (err) {
        return res.status(500).json({ message: "Failed to fetch KYC details", details: err.message });
    }
};