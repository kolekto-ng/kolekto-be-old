import crypto from "crypto";
import { supabase } from "../../utils/client.js";
import { sendEmail } from "../../services/emailService.js";
import util from "util";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function randomOtp6() {
  // 000000-999999, padded to 6 digits
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function otpPepper() {
  // Use something stable server-side; service role key is available in env and is secret.
  return (
    process.env.OTP_PEPPER ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.ACCOUNT_ENCRYPTION_KEY ||
    "kolekto-otp"
  );
}

function otpHash(userId, otp) {
  return sha256(`${userId}:${otp}:${otpPepper()}`);
}

export const requestPasswordChangeOtp = async (req, res) => {
  const userId = req.user?.id;
  const email = req.user?.email;

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
  const email = req.user?.email;
  const otp = String(req.body?.otp || "").trim();
  const newPassword = String(req.body?.newPassword || "");
  const confirmPassword = String(req.body?.confirmPassword || "");

  if (!userId || !email) {
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

    const { data: updateRes, error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (updateErr) {
      console.error("supabase updateUserById error:", updateErr);
      return res.status(500).json({ error: "Failed to update password" });
    }

    await supabase.from("password_change_otps").update({ used_at: new Date().toISOString() }).eq("id", record.id);

    return res.status(200).json({ success: true, userId: updateRes?.user?.id || userId });
  } catch (err) {
    console.error("verifyOtpAndChangePassword error:", err);
    return res.status(500).json({ error: "Failed to change password" });
  }
};
