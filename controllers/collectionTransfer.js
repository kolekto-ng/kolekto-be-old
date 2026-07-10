import { supabase } from "../utils/client.js";
import { sendEmail } from "../services/emailService.js";
import { EMAIL_RE, randomOtp6, otpHash, randomToken, tokenHash } from "../utils/otp.js";
import { resolveUserEmail, findUserByEmail } from "../utils/userLookup.js";
import { getFrontendUrl } from "../utils/frontendUrl.js";
import { otpCodeTemplate, notificationTemplate } from "../templates/emailTemplates.js";

// Shared by request + accept: unverified recipients may hold at most one
// collection — same rule enforced at creation time in controllers/collection.js.
async function recipientBlockedByKycCap(userId) {
  const { data: kyc } = await supabase
    .from("kyc_verifications")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();

  if (kyc?.status === "verified") return false;

  const { count } = await supabase
    .from("collections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .neq("status", "deleted");

  return (count ?? 0) >= 1;
}

async function loadOwnedCollection(collectionId, userId) {
  const { data, error } = await supabase
    .from("collections")
    .select("id, title, user_id")
    .eq("id", collectionId)
    .maybeSingle();

  if (error || !data) return { error: "Collection not found", status: 404 };
  if (data.user_id !== userId) return { error: "Forbidden: you do not own this collection", status: 403 };
  return { collection: data };
}

// Step 1: owner requests a transfer to a recipient's email. Sends an OTP to
// the OWNER's current email to prove initiation intent before anything is
// sent to the recipient.
export const requestCollectionTransfer = async (req, res) => {
  const { id: collectionId } = req.params;
  const userId = req.user?.id;
  const recipientEmail = String(req.body?.recipientEmail || "").trim().toLowerCase();

  const { collection, error, status } = await loadOwnedCollection(collectionId, userId);
  if (error) return res.status(status).json({ error });

  const ownerEmail = await resolveUserEmail(userId, req.user?.email);
  if (!ownerEmail) return res.status(401).json({ error: "Unauthorized" });

  if (!EMAIL_RE.test(recipientEmail)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
  if (recipientEmail === ownerEmail.toLowerCase()) {
    return res.status(400).json({ error: "You can't transfer a collection to yourself" });
  }

  const recipient = await findUserByEmail(recipientEmail);
  if (!recipient) {
    return res.status(404).json({ error: "No Kolekto account found with that email" });
  }

  if (await recipientBlockedByKycCap(recipient.id)) {
    return res.status(403).json({
      error: "This recipient needs to complete KYC verification to receive more than one collection.",
    });
  }

  try {
    await supabase
      .from("collection_transfer_requests")
      .update({ status: "cancelled", used_at: new Date().toISOString() })
      .eq("collection_id", collectionId)
      .eq("status", "pending");

    const otp = randomOtp6();
    console.log("[TEMP DEBUG OTP] collection transfer OTP:", otp); // TODO: remove after testing
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const { error: insertErr } = await supabase.from("collection_transfer_requests").insert([
      {
        collection_id: collectionId,
        from_user_id: userId,
        to_email: recipientEmail,
        to_user_id: recipient.id,
        otp_hash: otpHash(userId, otp),
        otp_expires_at: otpExpiresAt.toISOString(),
      },
    ]);

    if (insertErr) {
      console.error("collection_transfer_requests insert error:", insertErr);
      return res.status(500).json({ error: "Failed to create transfer request", details: insertErr.message });
    }

    const html = otpCodeTemplate(
      "there",
      "Collection Transfer Code",
      `Use this code to confirm you want to transfer <strong>${collection.title}</strong> to <strong>${recipientEmail}</strong>.`,
      otp,
      10
    );

    await sendEmail({
      to: ownerEmail,
      subject: "Your Kolekto collection transfer code",
      html,
      text: `Your Kolekto collection transfer code is ${otp}. It expires in 10 minutes.`,
    });

    return res.status(200).json({ success: true, email: ownerEmail, recipientEmail });
  } catch (err) {
    console.error("requestCollectionTransfer error:", err);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
};

// Step 2: verify the owner's OTP, then email an accept/decline link to the
// RECIPIENT. Ownership never changes here — only on accept.
export const verifyCollectionTransferOtp = async (req, res) => {
  const { id: collectionId } = req.params;
  const userId = req.user?.id;
  const otp = String(req.body?.otp || "").trim();

  const { error, status } = await loadOwnedCollection(collectionId, userId);
  if (error) return res.status(status).json({ error });

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: "OTP must be 6 digits" });
  }

  try {
    const { data: rows, error: fetchErr } = await supabase
      .from("collection_transfer_requests")
      .select("id, to_email, otp_hash, otp_expires_at, status, created_at")
      .eq("collection_id", collectionId)
      .eq("from_user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1);

    if (fetchErr) {
      console.error("collection_transfer_requests fetch error:", fetchErr);
      return res.status(500).json({ error: "Failed to verify OTP" });
    }

    const record = rows?.[0];
    if (!record) {
      return res.status(400).json({ error: "No active transfer request found. Please start again." });
    }

    if (new Date(record.otp_expires_at).getTime() < Date.now()) {
      await supabase.from("collection_transfer_requests").update({ status: "expired" }).eq("id", record.id);
      return res.status(400).json({ error: "OTP expired. Please start again." });
    }

    if (record.otp_hash !== otpHash(userId, otp)) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    const token = randomToken();
    // Longer window than other OTP-confirm flows: the recipient may need
    // real time to notice the invite and, if unverified, complete KYC.
    const confirmExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const { error: updateErr } = await supabase
      .from("collection_transfer_requests")
      .update({
        otp_verified_at: new Date().toISOString(),
        confirm_token_hash: tokenHash(token),
        confirm_expires_at: confirmExpiresAt.toISOString(),
      })
      .eq("id", record.id);

    if (updateErr) {
      console.error("collection_transfer_requests update error:", updateErr);
      return res.status(500).json({ error: "Failed to proceed to confirmation" });
    }

    const respondUrl = `${getFrontendUrl()}/collection-transfer?token=${token}`;
    const html = notificationTemplate(
      "there",
      "You've Been Offered a Kolekto Collection",
      "Someone wants to transfer ownership of their collection to you. This link expires in 7 days — if you weren't expecting this, you can safely ignore it.",
      respondUrl,
      "Review Transfer"
    );

    await sendEmail({
      to: record.to_email,
      subject: "You've been offered a Kolekto collection",
      html,
      text: `Review a collection transfer offer: ${respondUrl} (expires in 7 days)`,
    });

    return res.status(200).json({ success: true, recipientEmail: record.to_email });
  } catch (err) {
    console.error("verifyCollectionTransferOtp error:", err);
    return res.status(500).json({ error: "Failed to verify OTP" });
  }
};

// Step 3: the recipient accepts or declines. Requires the caller to be
// logged in AS the resolved recipient — this moves a financial asset to a
// specific account, so (unlike the email-change confirm step) the token
// alone isn't treated as sufficient authorization.
export const respondToCollectionTransfer = async (req, res) => {
  const userId = req.user?.id;
  const token = String(req.body?.token || "").trim();
  const action = String(req.body?.action || "").trim();

  if (!token) return res.status(400).json({ error: "Missing confirmation token" });
  if (!["accept", "decline"].includes(action)) {
    return res.status(400).json({ error: "Action must be 'accept' or 'decline'" });
  }

  try {
    const { data: rows, error: fetchErr } = await supabase
      .from("collection_transfer_requests")
      .select("id, collection_id, from_user_id, to_user_id, to_email, otp_verified_at, confirm_expires_at, status")
      .eq("confirm_token_hash", tokenHash(token))
      .limit(1);

    if (fetchErr) {
      console.error("respondToCollectionTransfer fetch error:", fetchErr);
      return res.status(500).json({ error: "Failed to load transfer request" });
    }

    const record = rows?.[0];
    if (!record || !record.otp_verified_at || record.status !== "pending") {
      return res.status(400).json({ error: "Invalid or already-resolved transfer link" });
    }

    if (!record.confirm_expires_at || new Date(record.confirm_expires_at).getTime() < Date.now()) {
      await supabase.from("collection_transfer_requests").update({ status: "expired" }).eq("id", record.id);
      return res.status(400).json({ error: "This transfer link has expired." });
    }

    if (record.to_user_id !== userId) {
      return res.status(403).json({ error: "Please log in as the invited account to respond to this transfer." });
    }

    if (action === "decline") {
      await supabase
        .from("collection_transfer_requests")
        .update({ status: "declined", used_at: new Date().toISOString() })
        .eq("id", record.id);
      return res.status(200).json({ success: true, status: "declined" });
    }

    // Re-check the KYC cap at accept time — the recipient's state may have
    // changed since the request was sent. Leave the row pending so they can
    // retry after completing KYC rather than losing the invite.
    if (await recipientBlockedByKycCap(userId)) {
      return res.status(403).json({
        error: "Complete KYC verification to accept this transfer — you already own a collection as an unverified user.",
      });
    }

    const { error: updateCollectionErr } = await supabase
      .from("collections")
      .update({ user_id: userId, updated_at: new Date().toISOString() })
      .eq("id", record.collection_id);

    if (updateCollectionErr) {
      console.error("respondToCollectionTransfer collection update error:", updateCollectionErr);
      return res.status(500).json({ error: "Failed to transfer collection" });
    }

    await supabase
      .from("collection_transfer_requests")
      .update({ status: "accepted", used_at: new Date().toISOString() })
      .eq("id", record.id);

    const [fromEmail, toEmail] = await Promise.all([
      resolveUserEmail(record.from_user_id),
      resolveUserEmail(record.to_user_id, record.to_email),
    ]);

    if (fromEmail) {
      await sendEmail({
        to: fromEmail,
        subject: "Your collection transfer was accepted",
        html: notificationTemplate(
          "there",
          "Collection Transfer Accepted",
          "Your collection has been transferred and is no longer in your account."
        ),
        text: "Your collection has been transferred and is no longer in your account.",
      }).catch((err) => console.error("transfer notify (from) failed:", err));
    }
    if (toEmail) {
      await sendEmail({
        to: toEmail,
        subject: "You now own a Kolekto collection",
        html: notificationTemplate(
          "there",
          "You Now Own a Kolekto Collection",
          "You've accepted a collection transfer. It now appears in your dashboard."
        ),
        text: "You've accepted a collection transfer. It now appears in your dashboard.",
      }).catch((err) => console.error("transfer notify (to) failed:", err));
    }

    return res.status(200).json({ success: true, status: "accepted" });
  } catch (err) {
    console.error("respondToCollectionTransfer error:", err);
    return res.status(500).json({ error: "Failed to respond to transfer" });
  }
};

// Lets an owner back out of a pending invite instead of leaving it dangling.
export const cancelCollectionTransfer = async (req, res) => {
  const { id: collectionId } = req.params;
  const userId = req.user?.id;

  const { error, status } = await loadOwnedCollection(collectionId, userId);
  if (error) return res.status(status).json({ error });

  try {
    await supabase
      .from("collection_transfer_requests")
      .update({ status: "cancelled", used_at: new Date().toISOString() })
      .eq("collection_id", collectionId)
      .eq("from_user_id", userId)
      .eq("status", "pending");

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("cancelCollectionTransfer error:", err);
    return res.status(500).json({ error: "Failed to cancel transfer" });
  }
};

// Lets the owner's UI show "transfer pending to x@y.com" instead of
// re-offering the entry form.
export const getCollectionTransferStatus = async (req, res) => {
  const { id: collectionId } = req.params;
  const userId = req.user?.id;

  const { error, status } = await loadOwnedCollection(collectionId, userId);
  if (error) return res.status(status).json({ error });

  try {
    const { data: rows, error: fetchErr } = await supabase
      .from("collection_transfer_requests")
      .select("to_email, status, created_at")
      .eq("collection_id", collectionId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1);

    if (fetchErr) {
      console.error("getCollectionTransferStatus fetch error:", fetchErr);
      return res.status(500).json({ error: "Failed to load transfer status" });
    }

    return res.status(200).json({ pending: rows?.[0] || null });
  } catch (err) {
    console.error("getCollectionTransferStatus error:", err);
    return res.status(500).json({ error: "Failed to load transfer status" });
  }
};
