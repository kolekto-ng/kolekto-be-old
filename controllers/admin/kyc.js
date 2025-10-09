import { supabase } from "../../utils/client.js";

// POST /api/admin/kyc-verifications/:id/approve
export const approveKyc = async (req, res) => {
  try {
    const { id } = req.params;
    const adminUserId = req.user?.id;
    const { notes } = req.body || {};

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

    if (kyc.status === "approved") {
      return res.status(409).json({ error: "KYC is already approved" });
    }

    if (kyc.status === "rejected") {
      return res.status(409).json({ error: "KYC has been rejected and cannot be approved" });
    }

    // 2) Approve the KYC verification
    const { data: updatedKyc, error: updateError } = await supabase
      .from("kyc_verifications")
      .update({ status: "approved", updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();

    if (updateError) {
      return res.status(500).json({ error: "Failed to approve KYC", details: updateError.message });
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

    // 4) Write verification history
    const historyPayload = {
      kyc_id: updatedKyc.id,
      action: "approved",
      timestamp: new Date().toISOString(),
      admin_id: adminUserId || null,
      admin_name: adminName,
      notes: notes || null,
    };

    const { error: histError } = await supabase
      .from("kyc_verification_history")
      .insert([historyPayload]);

    if (histError) {
      // Do not fail approval if history logging fails; surface warning.
      return res.status(200).json({
        message: "KYC approved, but failed to log history",
        kyc: updatedKyc,
        historyError: histError.message,
      });
    }

    return res.status(200).json({ message: "KYC approved successfully", kyc: updatedKyc });
  } catch (err) {
    return res.status(500).json({ error: "Unexpected error approving KYC", details: err.message });
  }
};

export default {
  approveKyc,
};
