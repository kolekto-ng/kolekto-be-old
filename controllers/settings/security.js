import { supabase } from "../../utils/client.js";
import { sendEmail } from "../../services/emailService.js";
import util from "util";
import { EMAIL_RE, sha256, randomOtp6, otpHash, randomToken, tokenHash } from "../../utils/otp.js";
import { resolveUserEmail } from "../../utils/userLookup.js";
import { getFrontendUrl } from "../../utils/frontendUrl.js";

export const requestPasswordChangeOtp = async (req, res) => {
  const userId = req.user?.id;
  const email = await resolveUserEmail(req.user?.id, req.user?.email);

  if (!userId || !email) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Quick sanity check: if the table isn't present (or PostgREST can't access it),
    // fail with an actionable message. This avoids "empty error object" confusion.
    try {
      const probe = await supabase
        .from("password_change_otps")
        .select("id")
        .limit(1);
      if (probe.error) {
        console.error("password_change_otps probe error:", util.inspect(probe.error, { showHidden: true, depth: 6 }));
        return res.status(500).json({
          error: "Password change OTP storage is not configured",
          details:
            probe.error.message ||
            "Ensure `password_change_otps` table exists (run kolekto-backend/models/password_change_otps.sql) and the backend can reach Supabase.",
        });
      }
    } catch (probeErr) {
      console.error("password_change_otps probe exception:", probeErr);
      return res.status(500).json({
        error: "Password change OTP storage probe failed",
        details: probeErr?.message || String(probeErr),
      });
    }

    const otp = randomOtp6();
    console.log("[TEMP DEBUG OTP] password change OTP:", otp); // TODO: remove after testing
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Invalidate any previous unused OTPs for this user (defensive).
    await supabase
      .from("password_change_otps")
      .update({ used_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("used_at", null);

    let insertRes;
    try {
      insertRes = await supabase.from("password_change_otps").insert([
        {
          user_id: userId,
          otp_hash: otpHash(userId, otp),
          expires_at: expiresAt.toISOString(),
        },
      ]);
    } catch (insertThrown) {
      console.error("password_change_otps insert exception:", insertThrown);
      return res.status(500).json({
        error: "Failed to create OTP",
        details: insertThrown?.message || String(insertThrown),
      });
    }
    const insertErr = insertRes.error;

    if (insertErr) {
      // Supabase errors often don't stringify well (can show as `{}`), so log key fields.
      console.error("password_change_otps insert error:", {
        message: insertErr.message,
        code: insertErr.code,
        details: insertErr.details,
        hint: insertErr.hint,
        // Helpful when the error is not a PostgREST error shape.
        type: typeof insertErr,
        name: insertErr?.name,
        toString: typeof insertErr?.toString === "function" ? insertErr.toString() : null,
        keys: insertErr && typeof insertErr === "object" ? Object.keys(insertErr) : null,
        ownProps:
          insertErr && typeof insertErr === "object"
            ? Object.getOwnPropertyNames(insertErr)
            : null,
      });
      console.error(
        "password_change_otps insert error (inspect):",
        util.inspect(insertErr, { showHidden: true, depth: 6 })
      );
      return res.status(500).json({
        error: "Failed to create OTP",
        details:
          insertErr.message ||
          (typeof insertErr === "string" ? insertErr : null) ||
          "Unknown insert error",
      });
    }

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.4">
        <h2 style="margin:0 0 12px">Kolekto Password Change Code</h2>
        <p style="margin:0 0 12px">Use this code to change your password:</p>
        <div style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${otp}</div>
        <p style="margin:0;color:#555">This code expires in 10 minutes. If you didn’t request this, you can ignore this email.</p>
      </div>
    `;

    await sendEmail({
      to: email,
      subject: "Your Kolekto password change code",
      html,
      text: `Your Kolekto password change code is ${otp}. It expires in 10 minutes.`,
    });

    return res.status(200).json({ success: true, email });
  } catch (err) {
    console.error("requestPasswordChangeOtp error:", err);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
};

export const verifyOtpAndChangePassword = async (req, res) => {
  const userId = req.user?.id;
  const otp = String(req.body?.otp || "").trim();
  const newPassword = String(req.body?.newPassword || "");
  const confirmPassword = String(req.body?.confirmPassword || "");

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: "OTP must be 6 digits" });
  }

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: "Passwords do not match" });
  }

  try {
    const { data: rows, error: fetchErr } = await supabase
      .from("password_change_otps")
      .select("id, otp_hash, expires_at, used_at, created_at")
      .eq("user_id", userId)
      .is("used_at", null)
      .order("created_at", { ascending: false })
      .limit(1);

    if (fetchErr) {
      console.error("password_change_otps fetch error:", {
        message: fetchErr.message,
        code: fetchErr.code,
        details: fetchErr.details,
        hint: fetchErr.hint,
      });
      return res.status(500).json({ error: "Failed to verify OTP" });
    }

    const record = rows?.[0];
    if (!record) {
      return res.status(400).json({ error: "No active OTP found. Please request a new one." });
    }

    if (new Date(record.expires_at).getTime() < Date.now()) {
      await supabase.from("password_change_otps").update({ used_at: new Date().toISOString() }).eq("id", record.id);
      return res.status(400).json({ error: "OTP expired. Please request a new one." });
    }

    if (record.otp_hash !== otpHash(userId, otp)) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    // Update the password using the Supabase Admin API.
    //
    // Previous attempt used a per-request anon-key client with the user's
    // JWT in `global.headers.Authorization` and called `auth.updateUser`.
    // That fails with "Auth session missing!" because supabase-js's
    // `updateUser` reads from the client's internal session state (set via
    // `setSession`) — it does NOT honour `global.headers` for the session
    // lookup. Since we don't have the user's refresh_token on the server,
    // we can't call `setSession` either.
    //
    // The admin API (updateUserById) is the correct path and only requires
    // SUPABASE_SERVICE_ROLE_KEY in the backend env. The shared client in
    // utils/client.js picks that up automatically.
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error(
        "verifyOtpAndChangePassword: SUPABASE_SERVICE_ROLE_KEY is not configured — admin password update will fail. Set this env var in the backend."
      );
      return res.status(500).json({
        error: "Password change is temporarily unavailable. Please contact support.",
        code: "ADMIN_KEY_MISSING",
      });
    }

    const { data: updateRes, error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (updateErr) {
      // Log structured detail; surface a useful (but sanitised) message.
      console.error("supabase updateUser error:", {
        message: updateErr.message,
        status: updateErr.status,
        name: updateErr.name,
      });
      const raw = String(updateErr.message || "").toLowerCase();
      let userMessage = updateErr.message || "Failed to update password";
      let httpStatus = 500;
      if (raw.includes("password") && (raw.includes("weak") || raw.includes("short") || raw.includes("requirements"))) {
        userMessage = "Password does not meet the required strength. Use at least 8 characters with a mix of letters and numbers.";
        httpStatus = 400;
      } else if (raw.includes("rate") || raw.includes("too many")) {
        userMessage = "Too many attempts. Please wait a moment and try again.";
        httpStatus = 429;
      } else if (raw.includes("invalid") && raw.includes("jwt")) {
        userMessage = "Your session has expired. Please sign in again and retry.";
        httpStatus = 401;
      } else if (raw.includes("not allowed") || raw.includes("insufficient") || raw.includes("forbidden")) {
        userMessage = "Password change is temporarily unavailable. Please contact support.";
        httpStatus = 500;
      }
      return res.status(httpStatus).json({
        error: userMessage,
        code: updateErr.name || "PASSWORD_UPDATE_FAILED",
      });
    }

    await supabase.from("password_change_otps").update({ used_at: new Date().toISOString() }).eq("id", record.id);

    // Supabase invalidates the user's active sessions on password change.
    // Signal this to the frontend so it can prompt for a fresh login instead
    // of letting the user discover it via the next 401.
    return res.status(200).json({
      success: true,
      userId: updateRes?.user?.id || userId,
      sessionInvalidated: true,
    });
  } catch (err) {
    console.error("verifyOtpAndChangePassword error:", {
      message: err?.message,
      name: err?.name,
    });
    return res.status(500).json({
      error: err?.message || "Failed to change password",
      code: "PASSWORD_CHANGE_UNEXPECTED",
    });
  }
};

// Step 1: send an OTP to the CURRENT email to prove account ownership before
// any change is made to the new email is attempted.
export const requestEmailChangeOtp = async (req, res) => {
  const userId = req.user?.id;
  const currentEmail = await resolveUserEmail(req.user?.id, req.user?.email);
  const newEmail = String(req.body?.newEmail || "").trim().toLowerCase();

  if (!userId || !currentEmail) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!EMAIL_RE.test(newEmail)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }

  if (newEmail === currentEmail.toLowerCase()) {
    return res.status(400).json({ error: "That's already your current email" });
  }

  try {
    const { data: existing, error: existingErr } = await supabase
      .from("profiles")
      .select("id")
      .ilike("email", newEmail)
      .maybeSingle();
    if (existingErr) {
      console.error("email_change_requests uniqueness check error:", existingErr);
      return res.status(500).json({ error: "Could not validate that email. Please try again." });
    }
    if (existing) {
      return res.status(409).json({ error: "That email is already in use" });
    }

    const otp = randomOtp6();
    console.log("[TEMP DEBUG OTP] email change OTP:", otp); // TODO: remove after testing
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Invalidate any previous unused requests for this user.
    await supabase
      .from("email_change_requests")
      .update({ used_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("used_at", null);

    const { error: insertErr } = await supabase.from("email_change_requests").insert([
      {
        user_id: userId,
        new_email: newEmail,
        otp_hash: otpHash(userId, otp),
        otp_expires_at: expiresAt.toISOString(),
      },
    ]);

    if (insertErr) {
      console.error("email_change_requests insert error:", insertErr);
      return res.status(500).json({ error: "Failed to create request", details: insertErr.message });
    }

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.4">
        <h2 style="margin:0 0 12px">Kolekto Email Change Code</h2>
        <p style="margin:0 0 12px">Use this code to confirm you want to change your account email to <strong>${newEmail}</strong>:</p>
        <div style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${otp}</div>
        <p style="margin:0;color:#555">This code expires in 10 minutes. If you didn’t request this, you can ignore this email — your account email will not change.</p>
      </div>
    `;

    await sendEmail({
      to: currentEmail,
      subject: "Your Kolekto email change code",
      html,
      text: `Your Kolekto email change code is ${otp}. It expires in 10 minutes.`,
    });

    return res.status(200).json({ success: true, email: currentEmail });
  } catch (err) {
    console.error("requestEmailChangeOtp error:", err);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
};

// Step 2: verify the OTP sent to the current email, then send a confirmation
// link to the NEW email. The change only applies once that link is clicked
// (see confirmEmailChange) — this step never touches auth.users/profiles.
export const verifyEmailChangeOtp = async (req, res) => {
  const userId = req.user?.id;
  const otp = String(req.body?.otp || "").trim();

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: "OTP must be 6 digits" });
  }

  try {
    const { data: rows, error: fetchErr } = await supabase
      .from("email_change_requests")
      .select("id, new_email, otp_hash, otp_expires_at, used_at, created_at")
      .eq("user_id", userId)
      .is("used_at", null)
      .order("created_at", { ascending: false })
      .limit(1);

    if (fetchErr) {
      console.error("email_change_requests fetch error:", fetchErr);
      return res.status(500).json({ error: "Failed to verify OTP" });
    }

    const record = rows?.[0];
    if (!record) {
      return res.status(400).json({ error: "No active request found. Please start again." });
    }

    if (new Date(record.otp_expires_at).getTime() < Date.now()) {
      await supabase.from("email_change_requests").update({ used_at: new Date().toISOString() }).eq("id", record.id);
      return res.status(400).json({ error: "OTP expired. Please start again." });
    }

    if (record.otp_hash !== otpHash(userId, otp)) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    const token = randomToken();
    const confirmExpiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    const { error: updateErr } = await supabase
      .from("email_change_requests")
      .update({
        otp_verified_at: new Date().toISOString(),
        confirm_token_hash: tokenHash(token),
        confirm_expires_at: confirmExpiresAt.toISOString(),
      })
      .eq("id", record.id);

    if (updateErr) {
      console.error("email_change_requests update error:", updateErr);
      return res.status(500).json({ error: "Failed to proceed to confirmation" });
    }

    const confirmUrl = `${getFrontendUrl()}/confirm-email-change?token=${token}`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.4">
        <h2 style="margin:0 0 12px">Confirm your new Kolekto email</h2>
        <p style="margin:0 0 12px">Click the link below to finish changing your account email to this address:</p>
        <p style="margin:0 0 12px"><a href="${confirmUrl}" style="color:#1B5E20;font-weight:600">Confirm email change</a></p>
        <p style="margin:0;color:#555">This link expires in 30 minutes. If you didn’t request this, you can ignore this email.</p>
      </div>
    `;

    await sendEmail({
      to: record.new_email,
      subject: "Confirm your new Kolekto email",
      html,
      text: `Confirm your new Kolekto email: ${confirmUrl} (expires in 30 minutes)`,
    });

    return res.status(200).json({ success: true, newEmail: record.new_email });
  } catch (err) {
    console.error("verifyEmailChangeOtp error:", err);
    return res.status(500).json({ error: "Failed to verify OTP" });
  }
};

// Step 3: the confirmation link the user clicks from their NEW inbox. No
// verifyToken here — the token itself is the credential, since the user may
// click this from a different device/session than the one that started the
// request (same pattern as Supabase's own password-reset-via-link).
export const confirmEmailChange = async (req, res) => {
  const token = String(req.body?.token || "").trim();

  if (!token) {
    return res.status(400).json({ error: "Missing confirmation token" });
  }

  try {
    const { data: rows, error: fetchErr } = await supabase
      .from("email_change_requests")
      .select("id, user_id, new_email, otp_verified_at, confirm_expires_at, used_at")
      .eq("confirm_token_hash", tokenHash(token))
      .is("used_at", null)
      .limit(1);

    if (fetchErr) {
      console.error("confirmEmailChange fetch error:", fetchErr);
      return res.status(500).json({ error: "Failed to confirm email change" });
    }

    const record = rows?.[0];
    if (!record || !record.otp_verified_at) {
      return res.status(400).json({ error: "Invalid or already-used confirmation link" });
    }

    if (!record.confirm_expires_at || new Date(record.confirm_expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "This confirmation link has expired. Please start again." });
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error("confirmEmailChange: SUPABASE_SERVICE_ROLE_KEY is not configured.");
      return res.status(500).json({
        error: "Email change is temporarily unavailable. Please contact support.",
        code: "ADMIN_KEY_MISSING",
      });
    }

    const { error: authErr } = await supabase.auth.admin.updateUserById(record.user_id, {
      email: record.new_email,
      email_confirm: true,
    });

    if (authErr) {
      console.error("confirmEmailChange auth update error:", authErr);
      const raw = String(authErr.message || "").toLowerCase();
      const message = raw.includes("already") || raw.includes("registered")
        ? "That email is already in use by another account."
        : authErr.message || "Failed to update email";
      return res.status(400).json({ error: message });
    }

    const { error: profileErr } = await supabase
      .from("profiles")
      .update({ email: record.new_email, updated_at: new Date().toISOString() })
      .eq("id", record.user_id);

    if (profileErr) {
      // Auth email already changed at this point — log loudly so it can be
      // reconciled manually rather than silently drifting from auth.users.
      console.error("confirmEmailChange profiles sync error (auth already updated):", profileErr);
    }

    await supabase.from("email_change_requests").update({ used_at: new Date().toISOString() }).eq("id", record.id);

    return res.status(200).json({ success: true, email: record.new_email });
  } catch (err) {
    console.error("confirmEmailChange error:", err);
    return res.status(500).json({ error: "Failed to confirm email change" });
  }
};
