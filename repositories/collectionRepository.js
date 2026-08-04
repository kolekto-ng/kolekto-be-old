// repositories/collectionRepository.js
//
// The ONLY place database access for the Collections aggregate lives.
// No business rules here — see services/collectionService.js for those.
// (Phase 1, Wave 1 — business-logic consolidation. See
// ../../kolekto-fe-old/KOLEKTO_ENGINEERING_STANDARDS.md §2.)
import { supabase } from "../utils/client.js";

export const collectionRepository = {
  /** @returns {Promise<string|null>} the user's KYC status, or null if none. */
  async getKycStatus(userId) {
    const { data, error } = await supabase
      .from("kyc_verifications")
      .select("status")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return data?.status ?? null;
  },

  /** @returns {Promise<number>} count of the user's non-deleted collections. */
  async countNonDeletedCollections(userId) {
    const { count, error } = await supabase
      .from("collections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .neq("status", "deleted");
    if (error) throw error;
    return count ?? 0;
  },

  /** Insert a collection row and return the created row. Throws on error. */
  async insertCollection(row) {
    const { data, error } = await supabase
      .from("collections")
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Create the collection's wallet row. Idempotent (ignores duplicates).
   * Best-effort: returns { error } instead of throwing, mirroring the live
   * behavior where a wallet warning does not fail collection creation.
   */
  async createWalletIfAbsent(wallet) {
    const { error } = await supabase
      .from("wallets")
      .upsert(wallet, { onConflict: "collection_id", ignoreDuplicates: true });
    return { error };
  },

  /** Insert a campaign row (fundraising). Non-throwing: returns { data, error }. */
  async insertCampaign(row) {
    const { data, error } = await supabase
      .from("campaigns")
      .insert(row)
      .select()
      .single();
    return { data, error };
  },

  /** Insert campaign verification documents. Non-throwing: returns { error }. */
  async insertVerificationDocuments(rows) {
    const { error } = await supabase.from("verification_documents").insert(rows);
    return { error };
  },

  /** Insert campaign story images. Non-throwing: returns { error }. */
  async insertCampaignImages(rows) {
    const { error } = await supabase.from("campaign_images").insert(rows);
    return { error };
  },
};

export default collectionRepository;
