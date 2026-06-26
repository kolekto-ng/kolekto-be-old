import { supabase } from "../../utils/client.js";
import { notifyKycApproved, notifyKycRejected } from "../../utils/pushNotifications.js";

// Helper function to update overall KYC status
const updateKycOverallStatus = async (userId) => {
    try {
        const { data: kyc, error: fetchError } = await supabase
            .from("kyc_verifications")
            .select("*")
            .eq("user_id", userId)
            .single();

        if (fetchError || !kyc) {
            return { error: "KYC verification not found" };
        }

        const { identity_verified, address_verified, nin_verified } = kyc;

        // Account is verified only when NIN, identity, and address are all approved.
        const allVerified = Boolean(identity_verified && address_verified && nin_verified);

        let newStatus = kyc.status;
        let completedAt = kyc.completed_at;

        if (allVerified && kyc.status !== 'verified') {
            newStatus = 'verified';
            completedAt = new Date().toISOString();
        } else if (!allVerified && kyc.status === 'verified') {
            newStatus = 'pending'; // Reset to pending if any verification is removed
            completedAt = null;
        }

        // Update the status if it changed
        if (newStatus !== kyc.status) {
            const { data: updatedKyc, error: updateError } = await supabase
                .from("kyc_verifications")
                .update({
                    status: newStatus,
                    completed_at: completedAt,
                    updated_at: new Date().toISOString()
                })
                .eq("user_id", userId)
                .select("*")
                .single();

            if (updateError) {
                return { error: updateError.message };
            }

            // Mirror verification status onto the profiles table so the frontend
            // can read it from a single source without joining kyc_verifications.
            // Silently ignore if the column doesn't exist in this deployment.
            try {
                await supabase
                    .from("profiles")
                    .update({
                        is_verified: newStatus === 'verified',
                        verification_status: newStatus,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", userId);
            } catch (_profileErr) {
                // profiles.is_verified column is optional — don't block the response
            }

            return { success: true, kyc: updatedKyc };
        }

        return { success: true, kyc: kyc };
    } catch (err) {
        return { error: err.message };
    }
};

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
        console.log(kycs)
        if (kycError) throw kycError;

        // 2. Fetch all profiles for those user_ids
        const userIds = kycs.map(k => k.user_id);
        const { data: profiles, error: profileError } = await supabase
            .from("profiles")
            .select("id, full_name, email, phone_number, avatar_url, created_at")
            .in("id", userIds);

        if (profileError) throw profileError;

        // 3. Attach profile to each KYC verification and calculate verification status
        const profilesMap = Object.fromEntries(profiles.map(p => [p.id, p]));
        const result = kycs.map(k => {
            // Calculate what's verified
            const verificationStatus = {
                bvn_verified: k.bvn_verified || false,
                bank_verified: k.bank_verified || false,
                identity_verified: k.identity_verified || false,
                address_verified: k.address_verified || false,
                selfie_verified: k.selfie_verified || false,
            };

            // Count verified items
            const verifiedCount = Object.values(verificationStatus).filter(Boolean).length;
            const totalRequired = 4; // BVN, Bank, Identity, Address
            const verificationProgress = `${verifiedCount}/${totalRequired}`;

            return {
                ...k,
                profile: profilesMap[k.user_id] || null,
                verificationStatus,
                verificationProgress,
                allVerified: verifiedCount === totalRequired
            };
        });

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
                        // Generate a public URL as fallback
                        const { data: publicUrlData } = supabase.storage
                            .from("kyc-documents")
                            .getPublicUrl(file.file_path);
                        
                        const publicUrl = publicUrlData?.publicUrl || null;

                        try {
                            const { data: signedUrlData, error: signedUrlError } = await supabase.storage
                                .from("kyc-documents")
                                .createSignedUrl(file.file_path, 60 * 60); // 1 hour expiry

                            if (signedUrlError) {
                                console.error(`Error generating signed URL for ${file.file_path}:`, signedUrlError);
                                return { ...file, signed_url: null, public_url: publicUrl };
                            }

                            return { ...file, signed_url: signedUrlData?.signedUrl || null, public_url: publicUrl };
                        } catch (err) {
                            console.error(`Exception generating signed URL for ${file.file_path}:`, err);
                            return { ...file, signed_url: null, public_url: publicUrl };
                        }
                    })
                );

                files = filesWithUrls;
            }
        }

        // 5. Organize documents by type with proper status
        const identityDocs = [];
        const addressDocs = [];
        const bankDocs = [];
        const bvnDocs = [];
        const selfieDocs = [];

        for (const doc of documents || []) {
            const docFiles = files
                .filter(f => f.document_id === doc.id)
                .map(f => ({
                    uploadedAt: f.uploaded_at,
                    fileUrl: f.signed_url || f.public_url || f.file_path, // Fallback chain
                    fileSize: f.file_size,
                    fileName: f.file_name,
                    fileType: f.file_type
                }));

            const documentGroup = {
                id: doc.id,
                type: doc.verification_type,
                documentType: doc.document_type,
                status: doc.status,
                rejectionReason: doc.rejection_reason,
                verifiedBy: doc.verified_by,
                verifiedAt: doc.verified_at,
                uploadedAt: docFiles.length > 0 ? docFiles[0].uploadedAt : null,
                files: docFiles
            };

            // Group by document type
            switch (doc.document_type) {
                case "identity":
                    identityDocs.push(documentGroup);
                    break;
                case "address":
                    addressDocs.push(documentGroup);
                    break;
                case "bank":
                    bankDocs.push(documentGroup);
                    break;
                case "bvn":
                    bvnDocs.push(documentGroup);
                    break;
                case "selfie":
                    selfieDocs.push(documentGroup);
                    break;
            }
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

        // 8. Compose response with verification status
        const verificationStatus = {
            bvn_verified: kyc.bvn_verified || false,
            bank_verified: kyc.bank_verified || false,
            identity_verified: kyc.identity_verified || false,
            address_verified: kyc.address_verified || false,
            selfie_verified: kyc.selfie_verified || false,
        };

        const verifiedCount = Object.values(verificationStatus).filter(Boolean).length;
        const totalRequired = 4;
        const verificationProgress = `${verifiedCount}/${totalRequired}`;

        return res.json({
            id: kyc.id,
            user_id: kyc.user_id,
            status: kyc.status,
            completed_at: kyc.completed_at,
            overallRiskScore: kyc.overall_risk_score || null,
            profile: profile || null,
            verificationStatus,
            verificationProgress,
            allVerified: verifiedCount === totalRequired,
            identityVerification: {
                status: kyc.identity_verified ? "verified" : (identityDocs.length > 0 ? identityDocs[0].status : "pending"),
                verified: kyc.identity_verified,
                documents: identityDocs
            },
            addressVerification: {
                status: kyc.address_verified ? "verified" : (addressDocs.length > 0 ? addressDocs[0].status : "pending"),
                verified: kyc.address_verified,
                documents: addressDocs
            },
            bankVerification: {
                status: kyc.bank_verified ? "verified" : (bankDocs.length > 0 ? bankDocs[0].status : "pending"),
                verified: kyc.bank_verified,
                documents: bankDocs,
                // Legacy bank data (if you still use bank_verifications table)
                legacyData: bank ? {
                    bankName: bank.bank_name,
                    accountNumber: bank.account_number,
                    accountName: bank.account_name,
                    bvn: bank.bvn,
                    status: bank.status,
                    verifiedAt: bank.verified_at
                } : null
            },
            bvnVerification: {
                status: kyc.bvn_verified ? "verified" : (bvnDocs.length > 0 ? bvnDocs[0].status : "pending"),
                verified: kyc.bvn_verified,
                documents: bvnDocs
            },
            selfieVerification: {
                status: kyc.selfie_verified ? "verified" : (selfieDocs.length > 0 ? selfieDocs[0].status : "pending"),
                verified: kyc.selfie_verified,
                documents: selfieDocs
            },
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

// POST /api/admin/kyc-verifications/:id/approve
export const approveKyc = async (req, res) => {
    try {
        const { id } = req.params;
        const adminUserId = req.user?.id;
        const { notes, verification_type } = req.body || {};

        if (!id) {
            return res.status(400).json({ error: "KYC verification id is required" });
        }

        // 1) Load KYC verification
        const { data: kyc, error: kycError } = await supabase
            .from("kyc_verifications")
            .select("*")
            .eq("id", id)
            .single();

        if (kycError || !kyc) {
            return res.status(404).json({ error: "KYC verification not found" });
        }

        // 2) Determine what to update based on verification_type
        let updateData = { updated_at: new Date().toISOString() };
        let actionMessage = "KYC approved successfully";

        if (verification_type) {
            // Approve specific verification type
            switch (verification_type.toLowerCase()) {
                case 'bvn':
                    updateData.bvn_verified = true;
                    actionMessage = "BVN verification approved";
                    break;
                case 'bank':
                    updateData.bank_verified = true;
                    actionMessage = "Bank verification approved";
                    break;
                case 'identity':
                    updateData.identity_verified = true;
                    actionMessage = "Identity verification approved";
                    break;
                case 'address':
                    updateData.address_verified = true;
                    actionMessage = "Address verification approved";
                    break;
                case 'selfie':
                    updateData.selfie_verified = true;
                    actionMessage = "Selfie verification approved";
                    break;
                default:
                    return res.status(400).json({ error: "Invalid verification type. Must be: bvn, bank, identity, address, or selfie" });
            }
        } else {
            // Approve all verifications
            updateData.status = "verified";
            updateData.bvn_verified = true;
            updateData.bank_verified = true;
            updateData.identity_verified = true;
            updateData.address_verified = true;
            updateData.selfie_verified = true;
            actionMessage = "All KYC verifications approved";
        }

        // 3) Update the KYC verification
        const { data: updatedKyc, error: updateError } = await supabase
            .from("kyc_verifications")
            .update(updateData)
            .eq("id", id)
            .select("*")
            .single();

        if (updateError) {
            return res.status(500).json({ error: "Failed to approve KYC", details: updateError.message });
        }

        // 4) Update overall status if all verifications are complete
        const statusUpdate = await updateKycOverallStatus(updatedKyc.user_id);
        if (statusUpdate.error) {
            console.error("Failed to update overall status:", statusUpdate.error);
        }

        // 5) Fetch admin profile to log admin_name
        let adminName = null;
        if (adminUserId) {
            const { data: adminProfile } = await supabase
                .from("profiles")
                .select("full_name, email")
                .eq("id", adminUserId)
                .single();

            adminName = adminProfile?.full_name || adminProfile?.email || null;
        }

        // 6) Write verification history
        const historyPayload = {
            kyc_id: updatedKyc.id,
            action: verification_type ? `approved_${verification_type}` : "approved_all",
            timestamp: new Date().toISOString(),
            admin_id: adminUserId || null,
            admin_name: adminName,
            notes: notes || null,
            verification_type: verification_type || 'all'
        };

        const { error: histError } = await supabase
            .from("kyc_verification_history")
            .insert([historyPayload]);

        if (histError) {
            console.error("Failed to log history:", histError);
        }

        await notifyKycApproved({
            userId: updatedKyc.user_id,
            verificationType: verification_type || "all",
            kycId: updatedKyc.id,
        });

        return res.status(200).json({
            message: actionMessage,
            kyc: updatedKyc,
            verification_type: verification_type || 'all'
        });
    } catch (err) {
        return res.status(500).json({ error: "Unexpected error approving KYC", details: err.message });
    }
};

// POST /api/admin/kyc-verifications/:id/reject
export const rejectKyc = async (req, res) => {
    try {
        const { id } = req.params;
        const adminUserId = req.user?.id;
        const { notes, reason, verification_type } = req.body || {};

        if (!id) {
            return res.status(400).json({ error: "KYC verification id is required" });
        }

        // 1) Load KYC verification
        const { data: kyc, error: kycError } = await supabase
            .from("kyc_verifications")
            .select("*")
            .eq("id", id)
            .single();

        if (kycError || !kyc) {
            return res.status(404).json({ error: "KYC verification not found" });
        }

        // 2) Determine what to update based on verification_type
        let updateData = {
            updated_at: new Date().toISOString(),
            status: "rejected" // Always set status to rejected for any rejection
        };
        let actionMessage = "KYC rejected successfully";

        if (verification_type) {
            // Reject specific verification type
            switch (verification_type.toLowerCase()) {
                case 'bvn':
                    updateData.bvn_verified = false;
                    actionMessage = "BVN verification rejected";
                    break;
                case 'bank':
                    updateData.bank_verified = false;
                    actionMessage = "Bank verification rejected";
                    break;
                case 'identity':
                    updateData.identity_verified = false;
                    actionMessage = "Identity verification rejected";
                    break;
                case 'address':
                    updateData.address_verified = false;
                    actionMessage = "Address verification rejected";
                    break;
                case 'selfie':
                    updateData.selfie_verified = false;
                    actionMessage = "Selfie verification rejected";
                    break;
                default:
                    return res.status(400).json({ error: "Invalid verification type. Must be: bvn, bank, identity, address, or selfie" });
            }
        } else {
            // Reject all verifications
            updateData.bvn_verified = false;
            updateData.bank_verified = false;
            updateData.identity_verified = false;
            updateData.address_verified = false;
            updateData.selfie_verified = false;
            updateData.completed_at = null; // Clear completion date
            actionMessage = "All KYC verifications rejected";
        }

        // Add rejection reason
        if (reason || notes) {
            updateData.rejection_reason = reason || notes;
        }

        // 3) Update the KYC verification
        const { data: updatedKyc, error: updateError } = await supabase
            .from("kyc_verifications")
            .update(updateData)
            .eq("id", id)
            .select("*")
            .single();

        if (updateError) {
            return res.status(500).json({ error: "Failed to reject KYC", details: updateError.message });
        }

        // 4) Update overall status
        const statusUpdate = await updateKycOverallStatus(updatedKyc.user_id);
        if (statusUpdate.error) {
            console.error("Failed to update overall status:", statusUpdate.error);
        }

        // 5) Fetch admin profile to log admin_name
        let adminName = null;
        if (adminUserId) {
            const { data: adminProfile } = await supabase
                .from("profiles")
                .select("full_name, email")
                .eq("id", adminUserId)
                .single();

            adminName = adminProfile?.full_name || adminProfile?.email || null;
        }

        // 6) Write verification history
        const historyPayload = {
            kyc_id: updatedKyc.id,
            action: verification_type ? `rejected_${verification_type}` : "rejected_all",
            timestamp: new Date().toISOString(),
            admin_id: adminUserId || null,
            admin_name: adminName,
            notes: notes || null,
            rejection_reason: reason || null,
            verification_type: verification_type || 'all'
        };

        const { error: histError } = await supabase
            .from("kyc_verification_history")
            .insert([historyPayload]);

        if (histError) {
            console.error("Failed to log history:", histError);
        }

        await notifyKycRejected({
            userId: updatedKyc.user_id,
            verificationType: verification_type || "all",
            kycId: updatedKyc.id,
        });

        return res.status(200).json({
            message: actionMessage,
            kyc: updatedKyc,
            verification_type: verification_type || 'all'
        });
    } catch (err) {
        return res.status(500).json({ error: "Unexpected error rejecting KYC", details: err.message });
    }
};

// POST /api/admin/kyc-documents/:documentId/approve
export const approveDocument = async (req, res) => {
    try {
        const { documentId } = req.params;
        const adminUserId = req.user?.id;
        const { notes, documentType, verification_type } = req.body || {};

        if (!documentId) {
            return res.status(400).json({ error: "Document ID is required" });
        }
        console.log(adminUserId, 'documentId', typeof documentId);
        // 1) Load the document
        const { data: document, error: docError } = await supabase
            .from("kyc_documents")
            .select("*")
            .eq("id", documentId)
            .single();

        if (docError || !document) {
            return res.status(404).json({ error: "Document not found" });
        }

        if (document.status === "verified") {
            return res.status(409).json({ error: "Document is already verified" });
        }

        // 2) Approve the document
        const { data: updatedDocument, error: updateError } = await supabase
            .from("kyc_documents")
            .update({
                status: "verified",
                verified_by: adminUserId,
                verified_at: new Date().toISOString(),
                rejection_reason: null, // Clear any previous rejection reason
            })
            .eq("id", documentId)
            .select("*")
            .single();

        if (updateError) {
            return res.status(500).json({ error: "Failed to approve document", details: updateError.message });
        }

        // 3) Fetch admin profile to log admin_name
        let adminName = null;
        if (adminUserId) {
            const { data: adminProfile } = await supabase
                .from("profiles")
                .select("full_name, email")
                .eq("id", adminUserId)
                .single();

            adminName = adminProfile?.full_name || adminProfile?.email || null;
        }

        // 4) Get the KYC verification record to log history properly
        const { data: kycRecord } = await supabase
            .from("kyc_verifications")
            .select("id")
            .eq("user_id", document.user_id)
            .single();

        // 5) Write verification history
        const historyPayload = {
            kyc_id: kycRecord?.id || document.user_id,
            action: `approved_${document.document_type}_document`,
            timestamp: new Date().toISOString(),
            admin_id: adminUserId || null,
            admin_name: adminName,
            notes: notes || null,
            verification_type: document.document_type,
            document_id: documentId
        };

        const { error: histError } = await supabase
            .from("kyc_verification_history")
            .insert([historyPayload]);

        if (histError) {
            console.error("Failed to log history:", histError);
        }

    // 6) Manually update kyc_verifications table based on document approval
    // Check if all documents of this type are now verified
    const { data: allDocumentsOfType, error: docsError } = await supabase
      .from("kyc_documents")
      .select("id, status")
      .eq("user_id", document.user_id)
      .eq("document_type", document.document_type);

    if (!docsError && allDocumentsOfType && allDocumentsOfType.length > 0) {
      // Check if all documents of this type are verified
      const allVerified = allDocumentsOfType.every(doc => doc.status === "verified");
      
      // Map document_type to verification flag
      const verificationFlagMap = {
        'identity': 'identity_verified',
        'address': 'address_verified',
        'bank': 'bank_verified',
        'bvn': 'bvn_verified',
        'selfie': 'selfie_verified'
      };

      const flagName = verificationFlagMap[document.document_type];
      
      if (flagName) {
        // Update the verification flag in kyc_verifications
        const { error: updateKycError } = await supabase
          .from("kyc_verifications")
          .update({ 
            [flagName]: allVerified,
            updated_at: new Date().toISOString()
          })
          .eq("user_id", document.user_id);

        if (updateKycError) {
          console.error("Failed to update KYC verification flag:", updateKycError);
        } else {
          // Update overall status
          await updateKycOverallStatus(document.user_id);
        }
      }
    }

    return res.status(200).json({ 
      message: `${document.document_type} document approved successfully`, 
      document: updatedDocument,
      document_type: document.document_type
    });
  } catch (err) {
    console.error("Error approving document:", err);
    return res.status(500).json({ error: "Unexpected error approving document", details: err.message });
  }
};

// POST /api/admin/kyc-documents/:documentId/reject
export const rejectDocument = async (req, res) => {
    try {
        const { documentId } = req.params;
        const adminUserId = req.user?.id;
        const { notes, reason, documentType, verification_type } = req.body || {};

        if (!documentId) {
            return res.status(400).json({ error: "Document ID is required" });
        }

        // 1) Load the document
        const { data: document, error: docError } = await supabase
            .from("kyc_documents")
            .select("*")
            .eq("id", documentId)
            .single();

        if (docError || !document) {
            return res.status(404).json({ error: "Document not found" });
        }

        if (document.status === "rejected") {
            return res.status(409).json({ error: "Document is already rejected" });
        }

        // 2) Reject the document
        const { data: updatedDocument, error: updateError } = await supabase
            .from("kyc_documents")
            .update({
                status: "rejected",
                rejection_reason: reason || notes || null,
                verified_by: null,
                verified_at: null,
                updated_at: new Date().toISOString()
            })
            .eq("id", documentId)
            .select("*")
            .single();

        if (updateError) {
            return res.status(500).json({ error: "Failed to reject document", details: updateError.message });
        }

        // 3) Fetch admin profile to log admin_name
        let adminName = null;
        if (adminUserId) {
            const { data: adminProfile } = await supabase
                .from("profiles")
                .select("full_name, email")
                .eq("id", adminUserId)
                .single();

            adminName = adminProfile?.full_name || adminProfile?.email || null;
        }

        // 4) Get the KYC verification record to log history properly
        const { data: kycRecord } = await supabase
            .from("kyc_verifications")
            .select("id")
            .eq("user_id", document.user_id)
            .single();

        // 5) Write verification history
        const historyPayload = {
            kyc_id: kycRecord?.id || document.user_id,
            action: `rejected_${document.document_type}_document`,
            timestamp: new Date().toISOString(),
            admin_id: adminUserId || null,
            admin_name: adminName,
            notes: notes || null,
            rejection_reason: reason || notes || null,
            verification_type: document.document_type,
            document_id: documentId
        };

        const { error: histError } = await supabase
            .from("kyc_verification_history")
            .insert([historyPayload]);

        if (histError) {
            console.error("Failed to log history:", histError);
        }

    // 6) Manually update kyc_verifications table based on document rejection
    // Check if all documents of this type are still verified
    const { data: allDocumentsOfType, error: docsError } = await supabase
      .from("kyc_documents")
      .select("id, status")
      .eq("user_id", document.user_id)
      .eq("document_type", document.document_type);

    if (!docsError && allDocumentsOfType && allDocumentsOfType.length > 0) {
      // Check if all documents of this type are verified
      const allVerified = allDocumentsOfType.every(doc => doc.status === "verified");
      
      // Map document_type to verification flag
      const verificationFlagMap = {
        'identity': 'identity_verified',
        'address': 'address_verified',
        'bank': 'bank_verified',
        'bvn': 'bvn_verified',
        'selfie': 'selfie_verified'
      };

      const flagName = verificationFlagMap[document.document_type];
      
      if (flagName) {
        // Update the verification flag in kyc_verifications
        const { error: updateKycError } = await supabase
          .from("kyc_verifications")
          .update({ 
            [flagName]: allVerified,
            updated_at: new Date().toISOString()
          })
          .eq("user_id", document.user_id);

        if (updateKycError) {
          console.error("Failed to update KYC verification flag:", updateKycError);
        } else {
          // Update overall status
          await updateKycOverallStatus(document.user_id);
        }
      }
    }

    return res.status(200).json({ 
      message: `${document.document_type} document rejected`, 
      document: updatedDocument,
      document_type: document.document_type
    });
  } catch (err) {
    console.error("Error rejecting document:", err);
    return res.status(500).json({ error: "Unexpected error rejecting document", details: err.message });
  }
};

// POST /api/admin/kyc-verifications/:id/add-note
export const addNote = async (req, res) => {
    try {
        const { id } = req.params;
        const adminUserId = req.user?.id;
        const { notes } = req.body || {};

        if (!id) {
            return res.status(400).json({ error: "KYC verification ID is required" });
        }

        if (!notes || notes.trim() === '') {
            return res.status(400).json({ error: "Notes are required" });
        }

        // 1) Verify the KYC verification exists
        const { data: kyc, error: kycError } = await supabase
            .from("kyc_verifications")
            .select("*")
            .eq("id", id)
            .single();

        if (kycError || !kyc) {
            return res.status(404).json({ error: "KYC verification not found" });
        }

        // 2) Fetch admin profile to log admin_name
        let adminName = null;
        if (adminUserId) {
            const { data: adminProfile } = await supabase
                .from("profiles")
                .select("full_name, email")
                .eq("id", adminUserId)
                .single();

            adminName = adminProfile?.full_name || adminProfile?.email || null;
        }

        // 3) Write verification history for the note
        const historyPayload = {
            kyc_id: kyc.id,
            action: "admin_note_added",
            timestamp: new Date().toISOString(),
            admin_id: adminUserId || null,
            admin_name: adminName,
            notes: notes.trim(),
            verification_type: 'general'
        };

        const { error: histError } = await supabase
            .from("kyc_verification_history")
            .insert([historyPayload]);

        if (histError) {
            console.error("Failed to log note:", histError);
            return res.status(500).json({ error: "Failed to save note", details: histError.message });
        }

        return res.status(200).json({
            message: "Note added successfully",
            note: {
                action: "admin_note_added",
                timestamp: new Date().toISOString(),
                admin_name: adminName,
                notes: notes.trim()
            }
        });
    } catch (err) {
        console.error("Error adding note:", err);
        return res.status(500).json({ error: "Unexpected error adding note", details: err.message });
    }
};
