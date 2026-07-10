import crypto from "crypto";

// Shared crypto primitives for the app's OTP + confirm-link account-change
// flows (password change, email change, collection transfer, ...). Keeping
// these in one place avoids re-implementing the same hashing/expiry logic
// with each new flow.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function randomOtp6() {
  // 000000-999999, padded to 6 digits
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function otpPepper() {
  // Use something stable server-side; service role key is available in env and is secret.
  return (
    process.env.OTP_PEPPER ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.ACCOUNT_ENCRYPTION_KEY ||
    "kolekto-otp"
  );
}

export function otpHash(userId, otp) {
  return sha256(`${userId}:${otp}:${otpPepper()}`);
}

export function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function tokenHash(token) {
  return sha256(`${token}:${otpPepper()}`);
}
