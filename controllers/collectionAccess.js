import { supabase } from "../utils/client.js";
import { sendEmail } from "../services/emailService.js";
import { EMAIL_RE, randomOtp6, otpHash, randomToken, tokenHash } from "../utils/otp.js";
import { resolveUserEmail } from "../utils/userLookup.js";
import { normalizeContributions, computeWalletBalances } from "../utils/financial.js";
import { getFrontendUrl } from "../utils/frontendUrl.js";
import { normalizeContributorRows } from "../utils/contributionNormalize.js";
import { otpCodeTemplate, notificationTemplate } from "../templates/emailTemplates.js";

async function loadOwnedCollections(collectionIds, userId) {
  const { data, error } = await supabase
    .from("collections")
    .select("id, title, user_id")
    .in("id", collectionIds);

  if (error) return { error: "Failed to load collections", status: 500 };
  if (!data || data.length !== collectionIds.length) {
    return { error: "One or more collections were not found", status: 404 };
  }
  if (data.some((c) => c.user_id !== userId)) {
    return { error: "Forbidden: you do not own one or more of these collections", status: 403 };
  }
  return { collections: data };
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

// Step 1: owner requests access for a recipient's email across one or more
// of their own collections. OTP proves initiation intent before the invite
// goes out.
export const requestCollectionAccess = async (req, res) => {
  const userId = req.user?.id;
  const recipientEmail = String(req.body?.recipientEmail || "").trim().toLowerCase();
  const collectionIds = Array.isArray(req.body?.collectionIds) ? req.body.collectionIds : [];
  const canViewEarnings = Boolean(req.body?.canViewEarnings);
  const canViewContributors = Boolean(req.body?.canViewContributors);

  if (collectionIds.length === 0) {
    return res.status(400).json({ error: "Select at least one collection" });
  }

  const { error: ownErr, status: ownStatus } = await loadOwnedCollections(collectionIds, userId);
  if (ownErr) return res.status(ownStatus).json({ error: ownErr });

  const ownerEmail = await resolveUserEmail(userId, req.user?.email);
  if (!ownerEmail) return res.status(401).json({ error: "Unauthorized" });

  if (!EMAIL_RE.test(recipientEmail)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
  if (recipientEmail === ownerEmail.toLowerCase()) {
    return res.status(400).json({ error: "You can't grant access to yourself" });
  }

  try {
    // Cancel any prior pending invite from this owner to this email before
    // starting a new one — otherwise an abandoned invite (owner requested
    // an OTP but never entered it) sits as "pending" forever and piles up
    // alongside every subsequent invite attempt.
    await supabase
      .from("collection_access_invites")
      .update({ status: "cancelled", used_at: new Date().toISOString() })
      .eq("owner_user_id", userId)
      .eq("to_email", recipientEmail)
      .eq("status", "pending");

    const otp = randomOtp6();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const { data: invite, error: insertErr } = await supabase
      .from("collection_access_invites")
      .insert([
        {
          owner_user_id: userId,
          to_email: recipientEmail,
          can_view_earnings: canViewEarnings,
          can_view_contributors: canViewContributors,
          otp_hash: otpHash(userId, otp),
          otp_expires_at: otpExpiresAt.toISOString(),
        },
      ])
      .select()
      .single();

    if (insertErr) {
      console.error("collection_access_invites insert error:", insertErr);
      return res.status(500).json({ error: "Failed to create access request", details: insertErr.message });
    }

    const itemRows = collectionIds.map((collectionId) => ({ invite_id: invite.id, collection_id: collectionId }));
    const { error: itemsErr } = await supabase.from("collection_access_invite_items").insert(itemRows);
    if (itemsErr) {
      console.error("collection_access_invite_items insert error:", itemsErr);
      await supabase.from("collection_access_invites").delete().eq("id", invite.id);
      return res.status(500).json({ error: "Failed to save selected collections" });
    }

    const html = otpCodeTemplate(
      "there",
      "Access Grant Code",
      `Use this code to confirm you want to give <strong>${recipientEmail}</strong> access to view ${collectionIds.length} collection${collectionIds.length === 1 ? "" : "s"}.`,
      otp,
      10
    );

    await sendEmail({
      to: ownerEmail,
      subject: "Your Kolekto access grant code",
      html,
      text: `Your Kolekto access grant code is ${otp}. It expires in 10 minutes.`,
    });

    return res.status(200).json({ success: true, inviteId: invite.id, email: ownerEmail, recipientEmail });
  } catch (err) {
    console.error("requestCollectionAccess error:", err);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
};

// Step 2: verify the owner's OTP, then email an accept/decline link to the
// recipient. No permission is granted here — only on accept.
export const verifyCollectionAccessOtp = async (req, res) => {
  const userId = req.user?.id;
  const inviteId = String(req.body?.inviteId || "");
  const otp = String(req.body?.otp || "").trim();

  if (!inviteId) return res.status(400).json({ error: "Missing invite id" });
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: "OTP must be 6 digits" });
  }

  try {
    const { data: record, error: fetchErr } = await supabase
      .from("collection_access_invites")
      .select("id, owner_user_id, to_email, otp_hash, otp_expires_at, status")
      .eq("id", inviteId)
      .maybeSingle();

    if (fetchErr) {
      console.error("collection_access_invites fetch error:", fetchErr);
      return res.status(500).json({ error: "Failed to verify OTP" });
    }
    if (!record || record.owner_user_id !== userId || record.status !== "pending") {
      return res.status(400).json({ error: "No active access request found. Please start again." });
    }

    if (new Date(record.otp_expires_at).getTime() < Date.now()) {
      await supabase.from("collection_access_invites").update({ status: "expired" }).eq("id", record.id);
      return res.status(400).json({ error: "OTP expired. Please start again." });
    }

    if (record.otp_hash !== otpHash(userId, otp)) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    const token = randomToken();
    // Longer window than other OTP-confirm flows: the invited email may not
    // have a Kolekto account yet and could need time to sign up.
    const confirmExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const { error: updateErr } = await supabase
      .from("collection_access_invites")
      .update({
        otp_verified_at: new Date().toISOString(),
        confirm_token_hash: tokenHash(token),
        confirm_expires_at: confirmExpiresAt.toISOString(),
      })
      .eq("id", record.id);

    if (updateErr) {
      console.error("collection_access_invites update error:", updateErr);
      return res.status(500).json({ error: "Failed to proceed to confirmation" });
    }

    const respondUrl = `${getFrontendUrl()}/collection-access?token=${token}`;
    const html = notificationTemplate(
      "there",
      "You've Been Given Access to a Kolekto Collection",
      "Someone wants to share limited, read-only access with you. This link expires in 7 days — if you don't have a Kolekto account yet, you'll be asked to sign up with this email first.",
      respondUrl,
      "Review Access Invite"
    );

    await sendEmail({
      to: record.to_email,
      subject: "You've been given access to a Kolekto collection",
      html,
      text: `Review your access invite: ${respondUrl} (expires in 7 days)`,
    });

    return res.status(200).json({ success: true, recipientEmail: record.to_email });
  } catch (err) {
    console.error("verifyCollectionAccessOtp error:", err);
    return res.status(500).json({ error: "Failed to verify OTP" });
  }
};

// Step 3: the invited person accepts or declines. Identity is resolved by
// matching the CALLER's current email to the invite's `to_email` — not a
// stored user id — since the invited email may not have had an account at
// invite time.
export const respondToCollectionAccess = async (req, res) => {
  const userId = req.user?.id;
  const callerEmail = String(req.user?.email || "").toLowerCase();
  const token = String(req.body?.token || "").trim();
  const action = String(req.body?.action || "").trim();

  if (!token) return res.status(400).json({ error: "Missing confirmation token" });
  if (!["accept", "decline"].includes(action)) {
    return res.status(400).json({ error: "Action must be 'accept' or 'decline'" });
  }

  try {
    const { data: record, error: fetchErr } = await supabase
      .from("collection_access_invites")
      .select("id, owner_user_id, to_email, can_view_earnings, can_view_contributors, otp_verified_at, confirm_expires_at, status")
      .eq("confirm_token_hash", tokenHash(token))
      .maybeSingle();

    if (fetchErr) {
      console.error("respondToCollectionAccess fetch error:", fetchErr);
      return res.status(500).json({ error: "Failed to load access invite" });
    }
    if (!record || !record.otp_verified_at || record.status !== "pending") {
      return res.status(400).json({ error: "Invalid or already-resolved access invite" });
    }
    if (!record.confirm_expires_at || new Date(record.confirm_expires_at).getTime() < Date.now()) {
      await supabase.from("collection_access_invites").update({ status: "expired" }).eq("id", record.id);
      return res.status(400).json({ error: "This invite has expired." });
    }
    if (record.to_email.toLowerCase() !== callerEmail) {
      return res.status(403).json({ error: "Please log in with the invited email to respond to this invite." });
    }

    if (action === "decline") {
      await supabase
        .from("collection_access_invites")
        .update({ status: "declined", used_at: new Date().toISOString() })
        .eq("id", record.id);
      return res.status(200).json({ success: true, status: "declined" });
    }

    const { data: items, error: itemsErr } = await supabase
      .from("collection_access_invite_items")
      .select("collection_id")
      .eq("invite_id", record.id);

    if (itemsErr || !items || items.length === 0) {
      console.error("collection_access_invite_items fetch error:", itemsErr);
      return res.status(500).json({ error: "Failed to load invited collections" });
    }

    // The same person can be invited to the same collection more than once
    // over time (e.g. contributors granted first, earnings granted later in
    // a separate invite). Merge into any existing active grant rather than
    // blindly inserting a new row — otherwise the collaborator ends up with
    // two active grants for the same collection, and every other query that
    // expects at most one row for a (collection, collaborator) pair breaks.
    const grantErrors = await Promise.all(
      items.map(async ({ collection_id }) => {
        const { data: existing, error: existingErr } = await supabase
          .from("collection_access_grants")
          .select("id, can_view_earnings, can_view_contributors")
          .eq("collection_id", collection_id)
          .eq("collaborator_user_id", userId)
          .is("revoked_at", null)
          .maybeSingle();

        if (existingErr) return existingErr;

        if (existing) {
          const { error: updateErr } = await supabase
            .from("collection_access_grants")
            .update({
              can_view_earnings: existing.can_view_earnings || record.can_view_earnings,
              can_view_contributors: existing.can_view_contributors || record.can_view_contributors,
              invite_id: record.id,
            })
            .eq("id", existing.id);
          return updateErr;
        }

        const { error: insertErr } = await supabase.from("collection_access_grants").insert([
          {
            collection_id,
            collaborator_user_id: userId,
            granted_by_user_id: record.owner_user_id,
            can_view_earnings: record.can_view_earnings,
            can_view_contributors: record.can_view_contributors,
            invite_id: record.id,
          },
        ]);
        return insertErr;
      })
    );

    const grantErr = grantErrors.find(Boolean);
    if (grantErr) {
      console.error("collection_access_grants upsert error:", grantErr);
      return res.status(500).json({ error: "Failed to grant access" });
    }

    await supabase
      .from("collection_access_invites")
      .update({ status: "accepted", used_at: new Date().toISOString() })
      .eq("id", record.id);

    const ownerEmail = await resolveUserEmail(record.owner_user_id);
    if (ownerEmail) {
      await sendEmail({
        to: ownerEmail,
        subject: "Your access invite was accepted",
        html: notificationTemplate(
          "there",
          "Access Invite Accepted",
          `${callerEmail} accepted your access invite and can now view the collection(s) you shared.`
        ),
        text: `${callerEmail} accepted your access invite.`,
      }).catch((err) => console.error("access notify (owner) failed:", err));
    }

    return res.status(200).json({ success: true, status: "accepted" });
  } catch (err) {
    console.error("respondToCollectionAccess error:", err);
    return res.status(500).json({ error: "Failed to respond to invite" });
  }
};

// Owner revokes a previously-granted access.
export const revokeCollectionAccess = async (req, res) => {
  const { grantId } = req.params;
  const userId = req.user?.id;

  try {
    const { data: grant, error: fetchErr } = await supabase
      .from("collection_access_grants")
      .select("id, collection_id, revoked_at")
      .eq("id", grantId)
      .maybeSingle();

    if (fetchErr || !grant) return res.status(404).json({ error: "Grant not found" });

    const { error: ownErr, status: ownStatus } = await loadOwnedCollection(grant.collection_id, userId);
    if (ownErr) return res.status(ownStatus).json({ error: ownErr });

    if (!grant.revoked_at) {
      await supabase
        .from("collection_access_grants")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", grantId);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("revokeCollectionAccess error:", err);
    return res.status(500).json({ error: "Failed to revoke access" });
  }
};

// Owner cancels a still-pending invite before it's been accepted.
export const cancelCollectionAccessInvite = async (req, res) => {
  const { inviteId } = req.params;
  const userId = req.user?.id;

  try {
    const { data: invite, error: fetchErr } = await supabase
      .from("collection_access_invites")
      .select("id, owner_user_id, status")
      .eq("id", inviteId)
      .maybeSingle();

    if (fetchErr || !invite) return res.status(404).json({ error: "Invite not found" });
    if (invite.owner_user_id !== userId) {
      return res.status(403).json({ error: "Forbidden: you did not create this invite" });
    }

    if (invite.status === "pending") {
      await supabase
        .from("collection_access_invites")
        .update({ status: "cancelled", used_at: new Date().toISOString() })
        .eq("id", inviteId);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("cancelCollectionAccessInvite error:", err);
    return res.status(500).json({ error: "Failed to cancel invite" });
  }
};

// Owner-facing: active grants + pending invites for one collection, for the
// "Manage Access" UI.
export const getCollectionAccessList = async (req, res) => {
  const { id: collectionId } = req.params;
  const userId = req.user?.id;

  const { error, status } = await loadOwnedCollection(collectionId, userId);
  if (error) return res.status(status).json({ error });

  try {
    const [{ data: grants, error: grantsErr }, { data: itemRows, error: itemsErr }] = await Promise.all([
      supabase
        .from("collection_access_grants")
        .select("id, collaborator_user_id, can_view_earnings, can_view_contributors, created_at")
        .eq("collection_id", collectionId)
        .is("revoked_at", null),
      supabase
        .from("collection_access_invite_items")
        .select("invite_id")
        .eq("collection_id", collectionId),
    ]);

    if (grantsErr || itemsErr) {
      console.error("getCollectionAccessList error:", grantsErr || itemsErr);
      return res.status(500).json({ error: "Failed to load access list" });
    }

    let pendingInvites = [];
    const inviteIds = (itemRows || []).map((r) => r.invite_id);
    if (inviteIds.length > 0) {
      const { data: invites, error: invitesErr } = await supabase
        .from("collection_access_invites")
        .select("id, to_email, can_view_earnings, can_view_contributors, status, otp_verified_at, otp_expires_at, confirm_expires_at, created_at")
        .in("id", inviteIds)
        .eq("status", "pending");

      if (invitesErr) {
        console.error("getCollectionAccessList invites error:", invitesErr);
        return res.status(500).json({ error: "Failed to load access list" });
      }

      // An invite the owner never finished (requested an OTP but never
      // entered it) is only actionable within its own short OTP window —
      // past that it's dead and shouldn't linger in the list forever. One
      // where the recipient link was already sent stays relevant until
      // that longer confirm window lapses instead.
      const now = Date.now();
      pendingInvites = (invites || []).filter((inv) => {
        if (inv.otp_verified_at) {
          return !inv.confirm_expires_at || new Date(inv.confirm_expires_at).getTime() > now;
        }
        return Boolean(inv.otp_expires_at) && new Date(inv.otp_expires_at).getTime() > now;
      });
    }

    const collaboratorIds = (grants || []).map((g) => g.collaborator_user_id);
    let collaboratorEmails = {};
    if (collaboratorIds.length > 0) {
      const { data: profiles } = await supabase.from("profiles").select("id, email").in("id", collaboratorIds);
      collaboratorEmails = Object.fromEntries((profiles || []).map((p) => [p.id, p.email]));
    }

    const activeGrants = (grants || []).map((g) => ({
      ...g,
      collaborator_email: collaboratorEmails[g.collaborator_user_id] || null,
    }));

    return res.status(200).json({ activeGrants, pendingInvites });
  } catch (err) {
    console.error("getCollectionAccessList error:", err);
    return res.status(500).json({ error: "Failed to load access list" });
  }
};

// Collaborator-facing: collections shared with the current user.
export const getSharedCollections = async (req, res) => {
  const userId = req.user?.id;

  try {
    const { data: grants, error: grantsErr } = await supabase
      .from("collection_access_grants")
      .select("id, collection_id, can_view_earnings, can_view_contributors")
      .eq("collaborator_user_id", userId)
      .is("revoked_at", null);

    if (grantsErr) {
      console.error("getSharedCollections grants error:", grantsErr);
      return res.status(500).json({ error: "Failed to load shared collections" });
    }
    if (!grants || grants.length === 0) {
      return res.status(200).json({ collections: [] });
    }

    const collectionIds = grants.map((g) => g.collection_id);
    const { data: collections, error: collErr } = await supabase
      .from("collections")
      .select("id, title, status, deadline, collection_type, type, created_at")
      .in("id", collectionIds);

    if (collErr) {
      console.error("getSharedCollections collections error:", collErr);
      return res.status(500).json({ error: "Failed to load shared collections" });
    }

    // A collection can have more than one active grant row for this
    // collaborator (e.g. separate invites for earnings vs contributors) —
    // combine them per collection rather than keeping only the last one,
    // which would silently drop whichever permission that row didn't have.
    const grantsByCollection = new Map();
    for (const g of grants) {
      const existing = grantsByCollection.get(g.collection_id);
      grantsByCollection.set(g.collection_id, {
        can_view_earnings: Boolean(existing?.can_view_earnings) || Boolean(g.can_view_earnings),
        can_view_contributors: Boolean(existing?.can_view_contributors) || Boolean(g.can_view_contributors),
      });
    }
    const merged = (collections || []).map((c) => ({
      ...c,
      can_view_earnings: Boolean(grantsByCollection.get(c.id)?.can_view_earnings),
      can_view_contributors: Boolean(grantsByCollection.get(c.id)?.can_view_contributors),
    }));

    return res.status(200).json({ collections: merged });
  } catch (err) {
    console.error("getSharedCollections error:", err);
    return res.status(500).json({ error: "Failed to load shared collections" });
  }
};

// Collaborator-facing: detail view for one shared collection. Gating lives
// entirely here — the response simply omits `earnings`/`contributors` when
// the grant doesn't include them, rather than the frontend deciding.
export const getSharedCollectionDetail = async (req, res) => {
  const { id: collectionId } = req.params;
  const userId = req.user?.id;

  try {
    // A collaborator can end up with more than one active grant row for the
    // same collection — e.g. invited once for contributors, then invited
    // again separately for earnings. Both invites are legitimate and each
    // produces its own grant row, so this must aggregate rather than assume
    // a single row (`.maybeSingle()` would throw once a second grant exists).
    const { data: grants, error: grantErr } = await supabase
      .from("collection_access_grants")
      .select("can_view_earnings, can_view_contributors")
      .eq("collection_id", collectionId)
      .eq("collaborator_user_id", userId)
      .is("revoked_at", null);

    if (grantErr) {
      console.error("getSharedCollectionDetail grant error:", grantErr);
      return res.status(500).json({ error: "Failed to load access" });
    }
    if (!grants || grants.length === 0) {
      return res.status(403).json({ error: "You don't have access to this collection" });
    }
    const grant = {
      can_view_earnings: grants.some((g) => g.can_view_earnings),
      can_view_contributors: grants.some((g) => g.can_view_contributors),
    };

    const { data: collection, error: collErr } = await supabase
      .from("collections")
      .select("id, title, description, status, deadline, collection_type, type, fee_bearer, created_at")
      .eq("id", collectionId)
      .maybeSingle();

    if (collErr || !collection) return res.status(404).json({ error: "Collection not found" });

    const response = { collection };

    if (grant.can_view_earnings) {
      const { data: contributions, error: contribErr } = await supabase
        .from("contributions")
        .select("amount, gross_amount, created_at")
        .eq("collection_id", collectionId)
        .eq("status", "paid");
      const { data: withdrawals, error: withdrawErr } = await supabase
        .from("withdrawals")
        .select("amount, status")
        .eq("collection_id", collectionId);

      if (!contribErr && !withdrawErr) {
        const normalized = normalizeContributions(
          contributions || [],
          collection.fee_bearer || "organizer",
          collection.collection_type || "fixed",
        );
        const balances = computeWalletBalances(normalized, withdrawals || []);
        response.earnings = {
          totalRaised: balances.netPayment,
          availableBalance: balances.availableBalance,
          withdrawn: balances.completedWithdrawals,
        };
      }
    }

    if (grant.can_view_contributors) {
      const { data: contributions, error: contribErr } = await supabase
        .from("contributions")
        .select("*")
        .eq("collection_id", collectionId)
        .order("created_at", { ascending: false });

      // Contributor name/email/phone often live inside a JSON blob
      // (contributor_information/contact_info) rather than the flat
      // columns — normalize the same way /api/contributions already does
      // for the owner's view, so a real submitted name actually surfaces.
      if (!contribErr) {
        response.contributors = normalizeContributorRows(contributions || []);
      }
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error("getSharedCollectionDetail error:", err);
    return res.status(500).json({ error: "Failed to load shared collection" });
  }
};
