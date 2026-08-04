import { supabase } from "./client.js";

// Resolves a user's current email, preferring the value already on the
// authenticated request (req.user.email) and falling back to Supabase Auth
// then the profiles table. Shared by any flow that needs to email the
// currently-authenticated user (OTP delivery, notifications, ...).
export async function resolveUserEmail(userId, fallbackEmail) {
  if (fallbackEmail) return fallbackEmail;

  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (!error && data?.user?.email) {
      return data.user.email;
    }
  } catch (err) {
    console.error("resolveUserEmail auth lookup error:", err);
  }

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .maybeSingle();
    if (!error && data?.email) {
      return data.email;
    }
  } catch (err) {
    console.error("resolveUserEmail profile lookup error:", err);
  }

  return null;
}

// Resolves a plain email address to exactly one registered user's profile
// (id + email). Returns null if there's no match or more than one — an
// ambiguous match is treated the same as "not found" rather than guessing.
export async function findUserByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email")
    .ilike("email", normalized)
    .limit(2);

  if (error || !data || data.length !== 1) {
    return null;
  }

  return data[0];
}
