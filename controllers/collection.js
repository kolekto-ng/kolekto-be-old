import { supabase } from '../utils/client.js';
import { calculateFees } from '../utils/financial.js';
import { notifyCollectionStatusChanged } from '../utils/pushNotifications.js';

// Helper function to generate slug from title
const generateSlug = (title) => {
    return title
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
        .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
};

// Helper function to ensure unique slug
const ensureUniqueSlug = async (baseSlug) => {
    let slug = baseSlug;
    let counter = 1;

    while (true) {
        const { data, error } = await supabase
            .from('collections')
            .select('id')
            .eq('slug', slug)
            .single();

        // If no record found, slug is unique
        if (error && error.code === 'PGRST116') {
            return slug;
        }

        // If record exists, append counter
        slug = `${baseSlug}-${counter}`;
        counter++;

        // Safety check to prevent infinite loop
        if (counter > 1000) {
            return `${baseSlug}-${Date.now()}`;
        }
    }
};

// controllers/collections.js
export const createCollection = async (req, res) => {
    let {
        title,
        description,
        amount,
        fundraising_target_amount: target_amount,
        collection_type,
        deadline,
        max_contributions,
        contributions_fields,
        status,
        fee_bearer,
        currency,
        currency_symbol,
        code_prefix,
        unique_id_enabled,
        support,
        price_tiers, // <-- array of tiers if tiered
    } = req.body;

    // ------------------------
    // 1. Basic validations
    // ------------------------
    let collectionType = "fixed"; // default
    let parsedAmount = null;

    if (collection_type && !["fixed", "tiered", "fundraising"].includes(collection_type)) {
        return res.status(400).json({ message: "Collection type must be either 'fixed' or 'tiered'" });
    }

    // if (collection_type === "fundraising" && (!target_amount || isNaN(parseFloat(target_amount)) || parseFloat(target_amount) <= 0)) {
    //     return res.status(400).json({ message: "Target amount must be a positive number for fundraising collections" });
    // }
    let amountBreakdown = {};

    if (collection_type === "fundraising") {
        if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 100) {
            return res.status(400).json({ message: "Amount must be greater than ₦100 for fundraising collections" });
        }
        collectionType = "fundraising"; // fundraising uses fixed amount per contribution
        fee_bearer = "contributor"; // force fee bearer to contributor for fundraising
        amountBreakdown = {
            type: "fundraising",
            amount: parsedAmount,
            fee_bearer: "contributor",
            platformFee: 0.01,
            paymentGatewayFee: 0.015,
            totalFees: 0.025,
        };

    }


    if (!title) {
        return res.status(400).json({ message: "Title is required" });
    }

    if (collection_type !== "fundraising") {
        if (!deadline || isNaN(Date.parse(deadline)) || new Date(deadline) <= new Date()) {
            return res.status(400).json({ message: "Deadline must be a valid future date" });
        }
    }



    const user_id = req.user.id;

    // ------------------------
    // 2. Determine collection type
    // ------------------------


    if (price_tiers && Array.isArray(price_tiers) && price_tiers.length > 0) {
        collectionType = "tiered";

        // Validate each pricing tier
        for (let tier of price_tiers) {
            if (!tier.name || !tier.price) {
                return res.status(400).json({ error: "Each tier must have a name and a price" });
            }

            const parsedPrice = parseFloat(tier.price);
            if (isNaN(parsedPrice) || parsedPrice <= 100) {
                return res.status(400).json({ error: `Tier "${tier.name}" must have a price greater than ₦100` });
            }

            // If quantity not specified → unlimited
            if (tier.quantity === undefined || tier.quantity === null) {
                tier.quantity = null;
            }
        }

        // For tiered collections, overall "amount" = 0
        parsedAmount = 0;
    } else {
        // fixed collection
        if (!amount) {
            return res.status(400).json({ message: "Amount is required for fixed collections" });
        }

        parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 100) {
            return res.status(400).json({ message: "Amount must be greater than ₦100" });
        }
    }

    // ------------------------
    // 3. Fee Breakdown
    // ------------------------

    // B-13: Fee math goes through the canonical calculateFees() helper.
    // We preserve the OUTPUT shape exactly (including the legacy field name
    // `paymentGatewayFee`) so the host frontend, admin panel, and any other
    // consumer continue to see the same payload they did before.
    const resolvedFeeBearer = fee_bearer || "organizer";

    if (collectionType === "fixed" && !isNaN(parsedAmount)) {
        const { platformFee, gatewayFee, totalFees, totalPayable } =
            calculateFees(parsedAmount, "fixed", resolvedFeeBearer);
        amountBreakdown = {
            type: "fixed",
            amount: parsedAmount,
            fee_bearer: resolvedFeeBearer,
            platformFee,
            paymentGatewayFee: gatewayFee,
            totalFees,
            totalPayable,
        };
    } else if (collectionType === "tiered") {
        amountBreakdown = {
            type: "tiered",
            tiers: price_tiers.map((tier) => {
                const tierPriceNum = Number(tier.price);
                const { platformFee, gatewayFee, totalFees, totalPayable } =
                    calculateFees(tierPriceNum, "tiered", resolvedFeeBearer);
                return {
                    name: tier.name,
                    price: tier.price,
                    quantity: tier.quantity, // null = unlimited
                    fee_bearer: resolvedFeeBearer,
                    platformFee,
                    paymentGatewayFee: gatewayFee,
                    totalFees,
                    totalPayable,
                };
            }),
        };
    }

    // The fundraising branch above (around line 76) already validates `amount`
    // and seeds `amountBreakdown`. A duplicate block lived here that re-ran
    // the same logic but with `parsedAmount` (which is `null` until further
    // down for the fundraising path) — producing a half-populated breakdown
    // that overrode the correct one. Removed.

    try {
        // ------------------------
        // 4. Generate slug if not provided
        // ------------------------
        let finalSlug = req.body.slug;
        if (!finalSlug && title) {
            const baseSlug = generateSlug(title);
            finalSlug = await ensureUniqueSlug(baseSlug);
        }

        // ------------------------
        // 5. Insert collection
        // ------------------------
        const { data: collection, error } = await supabase
            .from("collections")
            .insert([
                {
                    user_id,
                    title,
                    description,
                    amount: parsedAmount, // 0 if tiered
                    type: collectionType, // "normal" or "tiered"
                    deadline,
                    code_prefix: code_prefix || null,
                    unique_id_enabled: Boolean(unique_id_enabled),
                    max_contributions,
                    contributions_fields: contributions_fields || [],
                    // Fundraising campaigns require admin approval before contributors
                    // can see or donate. Force pending_review regardless of what the
                    // frontend sends so the collection is never accidentally made active.
                    status: collectionType === "fundraising" ? "pending_review" : (status || "active"),
                    fee_bearer: fee_bearer || "organizer",
                    currency: currency || "NGN",
                    currency_symbol: currency_symbol || "₦",
                    total_contributions: 0,
                    support_phone_number: support,
                    slug: finalSlug, // Add slug to collection
                    price_tiers:
                        collectionType === "tiered"
                            ? price_tiers.map((tier) => ({
                                name: tier.name,
                                description: tier.description || "",
                                price: parseFloat(tier.price),
                                quantity: tier.quantity ?? null, // null = unlimited
                            }))
                            : [],
                    target_amount: collectionType === "fundraising" ? parseFloat(target_amount) : null,
                },

            ])
            .select()
            .single();

        if (error) {
            return res.status(500).json({ message: error.message });
        }

        // ------------------------
        // 5. Create wallet (with fee breakdown)
        // ------------------------
        const { error: walletError } = await supabase
            .from("wallets")
            .insert([
                {
                    collection_id: collection.id,
                    available_balance: 0,
                    ledger_balance: 0,
                    withdrawn: 0,
                    fee_breakdown: amountBreakdown,
                    currency: collection.currency,
                    currency_symbol: collection.currency_symbol,
                },
            ]);

        if (walletError) {
            // Rollback collection if wallet creation fails
            await supabase.from("collections").delete().eq("id", collection.id);
            return res.status(500).json({
                message:
                    "Collection created but wallet creation failed: " +
                    walletError.message,
            });
        }

        return res.status(201).json({ collection });
    } catch (error) {
        console.error("Error creating collection:", error);
        return res
            .status(500)
            .json({ message: "Unexpected server error: " + error.message });
    }
};

export const getUserCollections = async (req, res) => {
    const user_id = req.user.id;

    try {
        const { data, error } = await supabase
            .from('collections')
            .select(`
                *,
                wallets (
                    id,
                    available_balance,
                    pending_balance,
                    ledger_balance,
                    gross_payment,
                    net_payment,
                    withdrawn,
                    fee_breakdown,
                    currency,
                    currency_symbol
                )
            `)
            .eq('user_id', user_id)
            .neq('status', 'deleted');

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        // Format response
        const formatted = data.map(collection => ({
            ...collection,
            price_tiers: collection.type === "tiered"
                ? collection.pricing_tiers || []
                : [],
            amountBreakdown: collection.type === "fixed"
                ? collection.wallets?.fee_breakdown || {}
                : null
        }));

        return res.status(200).json({ ...formatted, data });
    } catch (err) {
        console.error("Error fetching user collections:", err);
        return res.status(500).json({ error: "Unexpected server error" });
    }
};

export const getSingleCollection = async (req, res) => {
    const { id } = req.params;
    const user_id = req.user.id;

    try {
        const { data, error } = await supabase
            .from('collections')
            .select(`
                *,
                wallets (
                    id,
                    available_balance,
                    ledger_balance,
                    gross_payment,
                    net_payment,
                    withdrawn,
                    fee_breakdown,
                    currency,
                    currency_symbol
                )
            `)
            .eq('id', id)
            .eq('user_id', user_id)
            .single();

        if (error) {
            return res.status(404).json({ error: error.message });
        }

        const collection = {
            ...data,
            price_tiers: data.type === "tiered"
                ? data.pricing_tiers || []
                : [],
            amountBreakdown: data.type === "fixed"
                ? data.wallets?.fee_breakdown || {}
                : null
        };

        return res.status(200).json({ collection });
    } catch (err) {
        console.error("Error fetching collection:", err);
        return res.status(500).json({ error: "Unexpected server error" });
    }
};

export const editCollection = async (req, res) => {
    const { id } = req.params;
    const requestingUserId = req.user?.id;

    // ── Ownership check ──────────────────────────────────────────────────────
    const { data: existing, error: ownerErr } = await supabase
        .from('collections')
        .select('user_id, price_tiers')
        .eq('id', id)
        .single();

    if (ownerErr || !existing) {
        return res.status(404).json({ error: 'Collection not found' });
    }
    if (existing.user_id !== requestingUserId) {
        return res.status(403).json({ error: 'Forbidden: you do not own this collection' });
    }

    const {
        title,
        description,
        deadline,
        max_contributions,
        contributions_fields,
        price_tiers,
        collectionType
    } = req.body;

    // price_tiers carries two kinds of fields: ones the host edits (name,
    // price, quantity, description, prefix) and ones only the payment
    // verifier computes (sold_quantity, remaining_quantity — see
    // refreshCollectionAndWallets in verify-paystack-payment/index.ts). The
    // edit form only ever sends the host-editable ones, so a raw overwrite
    // here wipes the sold/remaining counts back to absent on every save.
    // Re-attach them from the currently-persisted tier (matched by id, then
    // name) so editing a collection never resets its sold-ticket counters.
    const mergeTierComputedFields = (incomingTiers, existingTiers) => {
        if (!Array.isArray(incomingTiers)) return incomingTiers;
        const existingByKey = new Map();
        for (const t of Array.isArray(existingTiers) ? existingTiers : []) {
            const key = String(t?.id ?? t?.name ?? '');
            if (key) existingByKey.set(key, t);
        }
        return incomingTiers.map((tier) => {
            const key = String(tier?.id ?? tier?.name ?? '');
            const match = existingByKey.get(key);
            return {
                ...tier,
                sold_quantity: match?.sold_quantity ?? tier?.sold_quantity ?? 0,
                remaining_quantity: match?.remaining_quantity ?? tier?.remaining_quantity ?? null,
            };
        });
    };

    // Prepare update data
    const isTieredOrTicket = collectionType === 'tiered' || collectionType === 'ticket';
    const updateData = {
        title,
        description,
        deadline,
        max_contributions: collectionType === 'fixed' ? (max_contributions || null) : null,
        contributions_fields: Array.isArray(contributions_fields) && contributions_fields.length > 0 ? contributions_fields : null,
        price_tiers: isTieredOrTicket
            ? mergeTierComputedFields(price_tiers, existing.price_tiers)
            : null,
        updated_at: new Date().toISOString()
    };



    // Remove undefined/null fields for clean update
    Object.keys(updateData).forEach(key => {
        if (updateData[key] === undefined) delete updateData[key];
    });

    console.log(updateData, "<< This is the update data");


    try {
        const { data, error } = await supabase
            .from("collections")
            .update(updateData)
            .eq("id", id)
            .select()
            .single();

        if (error) {
            return res.status(400).json({ error: error.message });
        }

        return res.status(200).json({ collection: data });
    } catch (err) {
        console.error("Error editing collection:", err);
        return res.status(500).json({ error: "Unexpected server error" });
    }
};

export const updateCollectionStatus = async (req, res) => {
    const { id: collectionId } = req.params;
    const { newStatus } = req.body;
    const requestingUserId = req.user?.id;

    if (!collectionId || !newStatus) {
        return res.status(400).json({ error: "Collection ID and new status are required." });
    }

    // ── Ownership check ──────────────────────────────────────────────────────
    const { data: existing, error: ownerErr } = await supabase
        .from('collections')
        .select('user_id, title, collection_type')
        .eq('id', collectionId)
        .single();

    if (ownerErr || !existing) {
        return res.status(404).json({ error: 'Collection not found' });
    }
    if (existing.user_id !== requestingUserId) {
        return res.status(403).json({ error: 'Forbidden: you do not own this collection' });
    }

    // Capture the exact transition instant so the notification dedupe key is
    // unique per transition (allows pause → reopen → pause again to each notify
    // once, while a retry of the SAME transition stays deduped).
    const transitionAt = new Date().toISOString();
    const { error } = await supabase
        .from('collections')
        .update({ status: newStatus, updated_at: transitionAt })
        .eq('id', collectionId);

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    await notifyCollectionStatusChanged({
        userId: existing.user_id,
        collectionId,
        collectionTitle: existing.title,
        status: newStatus,
        collectionType: existing.collection_type,
        transitionAt,
    });

    return res.status(200).json({ message: "Collection status updated successfully." });
};


