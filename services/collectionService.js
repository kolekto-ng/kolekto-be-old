// services/collectionService.js
//
// THE single authoritative implementation of collection creation.
// Business rules live here; database access is delegated to the injected
// repository. This is a faithful port of the LIVE behavior currently served by
// the Supabase Edge function `create-collection` (all 5 collection types, wallet
// row, and fundraising campaign/docs/images) — reproduced under the Express
// runtime so the API becomes the single write authority (Phase 1, Wave 1).
//
// Observability (Wave 1.2): every create emits correlated, structured log
// events (collection.create.started/succeeded/rejected/failed) carrying the
// request's correlation id, and thrown errors are tagged with `requestId` so a
// failure can be traced frontend -> controller -> service -> DB. The repository
// is kept intentionally pure (no logging) per the layering standard; the service
// logs around repo calls. See ../../kolekto-fe-old/KOLEKTO_ENGINEERING_STANDARDS.md.
//
// Deliberate parity note: this service does NOT populate `wallets.fee_breakdown`.
// Only the now-removed legacy Express controller ever wrote it; the live Edge
// path never did, so wizard-created collections already surface an empty
// `amountBreakdown`. Reproducing that keeps a future FE flip a behavioral no-op.
// (Open question tracked in KOLEKTO_PHASE1_ENGINEERING_AUDIT.md §1.)
import { collectionRepository } from "../repositories/collectionRepository.js";
import { log } from "../utils/logger.js";

/** Build a URL slug the same way the live Edge function does: base + random suffix. */
function defaultGenerateSlug(title) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

/** Map product collection_type → the legacy `type` value the DB trigger expects. */
export function resolveLegacyType(collectionType, ticketMode) {
  if (
    collectionType === "tiered" ||
    (collectionType === "ticket" && ticketMode === "tiered")
  ) {
    return "tiered";
  }
  if (collectionType === "open_pool" || collectionType === "fundraising") {
    return collectionType;
  }
  return "flat";
}

/** Case-insensitive social-link lookup used to populate campaign social columns. */
function findSocial(socialLinks, platforms) {
  const sl = Array.isArray(socialLinks) ? socialLinks : [];
  for (const link of sl) {
    const p = (link?.platform || "").toLowerCase().replace(/\s+/g, "");
    for (const target of platforms) {
      if (p.includes(target)) return link.url || null;
    }
  }
  return null;
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** Milliseconds elapsed since an hrtime.bigint() mark, rounded to 0.1ms. */
function durationMsSince(startedAt) {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
}

/**
 * Factory so callers (and tests) can inject a repository, slug generator, and
 * logger. Production wiring uses the real Supabase-backed repository and the
 * structured JSON logger.
 */
export function makeCollectionService({
  repo = collectionRepository,
  generateSlug = defaultGenerateSlug,
  logger = log,
} = {}) {
  /** KYC gate: unverified users may own at most one non-deleted collection. */
  async function assertCanCreate(userId) {
    const status = await repo.getKycStatus(userId);
    if (status !== "verified") {
      const count = await repo.countNonDeletedCollections(userId);
      if (count >= 1) {
        throw httpError(
          "Complete KYC verification to create more than one collection.",
          403
        );
      }
    }
  }

  /** Create the fundraising campaign + its documents/images (best-effort). */
  async function createCampaignArtifacts(collection, input, requestId) {
    const {
      title,
      campaign_summary,
      banner_url = null,
      story_images = [],
      target_amount,
      min_contribution = 0,
      is_open_ended = false,
      deadline,
      story,
      support_phone,
      campaign_country = "Nigeria",
      campaign_category,
      campaign_keywords,
      social_links,
      verification_documents = [],
    } = input;

    const { data: campaign, error: campError } = await repo.insertCampaign({
      id: collection.id,
      creator_id: collection.user_id,
      title: title.trim(),
      summary: campaign_summary || null,
      main_image_url: banner_url || story_images[0] || null,
      target_amount: target_amount || null,
      min_contribution: min_contribution || 0,
      currency: "NGN",
      is_open_ended: is_open_ended || false,
      deadline: deadline || null,
      story_for: story?.what || null,
      story_why: story?.why || null,
      story_achieve: story?.impact || null,
      phone_number: support_phone || null,
      country_code: "NG +234",
      country: campaign_country || "Nigeria",
      category: campaign_category || null,
      keywords: campaign_keywords
        ? typeof campaign_keywords === "string"
          ? campaign_keywords.split(",").map((k) => k.trim())
          : campaign_keywords
        : null,
      social_twitter: findSocial(social_links, ["twitter", "x"]),
      social_instagram: findSocial(social_links, ["instagram"]),
      social_facebook: findSocial(social_links, ["facebook"]),
      status: "pending_verification",
    });

    // Use collection.id as the reference for docs/images even if the campaign
    // insert failed — mirrors the live Edge behavior.
    const campaignId = campaign?.id || collection.id;
    if (campError) {
      logger.error("collection.campaign.insert_failed", {
        requestId,
        collectionId: collection.id,
        reason: campError.message,
      });
    }

    if (Array.isArray(verification_documents) && verification_documents.length > 0) {
      const docs = verification_documents.map((doc, idx) => {
        const docUrl = typeof doc === "string" ? doc : doc.url;
        const docName =
          typeof doc === "string"
            ? `Verification Document ${idx + 1}`
            : doc.name || `Verification Document ${idx + 1}`;
        return { campaign_id: campaignId, document_url: docUrl, document_name: docName };
      });
      const { error: docErr } = await repo.insertVerificationDocuments(docs);
      if (docErr) {
        logger.error("collection.campaign.docs_failed", {
          requestId,
          collectionId: collection.id,
          reason: docErr.message,
        });
      }
    }

    if (Array.isArray(story_images) && story_images.length > 0) {
      const images = story_images.map((url, idx) => ({
        campaign_id: campaignId,
        image_url: url,
        caption: null,
        display_order: idx,
      }));
      const { error: imgErr } = await repo.insertCampaignImages(images);
      if (imgErr) {
        logger.error("collection.campaign.images_failed", {
          requestId,
          collectionId: collection.id,
          reason: imgErr.message,
        });
      }
    }
  }

  /**
   * Create a collection.
   * @param {{ userId: string, input: object, requestId?: string }} args
   * @returns {Promise<object>} the created collection row.
   */
  async function create({ userId, input, requestId } = {}) {
    const startedAt = process.hrtime.bigint();
    const collectionType = input?.collection_type ?? "fixed";

    try {
      if (!userId) throw httpError("Unauthorized", 401);
      if (!input?.title?.trim()) throw httpError("Title is required", 400);

      await assertCanCreate(userId);

      const {
        title,
        description,
        amount,
        deadline,
        contributions_fields,
        price_tiers,
        max_contributions,
        fee_bearer = "contributor",
        code_prefix,
        unique_id_enabled = false,
        target_amount,
        min_contribution = 0,
        event_date,
        ticket_mode,
        allow_multiple_quantity = true,
        is_open_ended = false,
        auto_close = false,
        story,
        campaign_category,
        campaign_keywords,
        campaign_country = "Nigeria",
        social_links,
        support_phone,
        campaign_summary,
        story_images = [],
        banner_url = null,
      } = input;

      const status = collectionType === "fundraising" ? "pending_review" : "active";
      const legacyType = resolveLegacyType(collectionType, ticket_mode);

      let collection;
      try {
        collection = await repo.insertCollection({
          user_id: userId,
          title: title.trim(),
          description: description?.trim() || null,
          amount: amount ?? 0,
          deadline: deadline || null,
          contributions_fields: contributions_fields || [],
          price_tiers: price_tiers || [],
          max_contributions: max_contributions || null,
          fee_bearer,
          code_prefix: code_prefix || null,
          unique_id_enabled,
          target_amount: target_amount || null,
          min_contribution: min_contribution || 0,
          collection_type: collectionType,
          type: legacyType,
          event_date: event_date || null,
          ticket_mode: ticket_mode || null,
          allow_multiple_quantity,
          is_open_ended,
          auto_close,
          story: story || null,
          campaign_category: campaign_category || null,
          campaign_keywords: campaign_keywords || null,
          campaign_country,
          social_links: social_links || [],
          support_phone_number: support_phone || null,
          campaign_summary: campaign_summary || null,
          story_images,
          banner_url: banner_url || null,
          status,
          currency: "NGN",
          currency_symbol: "₦",
          slug: generateSlug(title),
        });
      } catch (err) {
        // Live Edge returns 400 with the DB message on insert failure.
        throw httpError(err.message || "Failed to create collection", err.statusCode || 400);
      }

      // Wallet creation is best-effort (a warning must not fail the request).
      const { error: walletError } = await repo.createWalletIfAbsent({
        collection_id: collection.id,
        available_balance: 0,
        ledger_balance: 0,
        gross_payment: 0,
        net_payment: 0,
        withdrawn: 0,
        pending_balance: 0,
        currency: "NGN",
        currency_symbol: "₦",
      });
      if (walletError) {
        logger.warn("collection.create.wallet_warning", {
          requestId,
          collectionId: collection.id,
          reason: walletError.message,
        });
      }

      if (collectionType === "fundraising") {
        await createCampaignArtifacts(collection, input, requestId);
      }

      logger.info("collection.create.succeeded", {
        requestId,
        userId,
        collectionId: collection.id,
        collectionType,
        duration_ms: durationMsSince(startedAt),
      });
      return collection;
    } catch (err) {
      if (requestId && !err.requestId) err.requestId = requestId;
      const status = err.statusCode || 500;
      const meta = {
        requestId,
        userId,
        collectionType,
        status,
        duration_ms: durationMsSince(startedAt),
      };
      if (status >= 500) {
        logger.error("collection.create.failed", { ...meta, err });
      } else {
        // Expected business rejections (401/400/403) — warn with the reason,
        // not a stack, to keep the signal clean.
        logger.warn("collection.create.rejected", { ...meta, reason: err.message });
      }
      throw err;
    }
  }

  return { create };
}

export const collectionService = makeCollectionService();
export default collectionService;
