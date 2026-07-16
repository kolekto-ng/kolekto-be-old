import { supabase } from '../utils/client.js';
import { notifyCollectionStatusChanged } from '../utils/pushNotifications.js';
import { collectionService } from '../services/collectionService.js';

// controllers/collection.js
//
// Thin controllers: validate/normalize the HTTP shape, delegate to a service,
// shape the response. Business rules for collection creation live in
// services/collectionService.js (Phase 1, Wave 1 consolidation).

/**
 * Create a collection.
 *
 * Delegates to the single authoritative CollectionService, which reproduces the
 * live behavior previously served by the Supabase Edge function
 * `create-collection`. Response shape (`{ data: collection }`, 200) matches that
 * Edge function so the frontend can be repointed to this route without any
 * behavioral change (the flip itself is a later, separately-deployed step).
 */
export const createCollection = async (req, res) => {
    try {
        const collection = await collectionService.create({
            userId: req.user?.id,
            input: req.body,
            requestId: req.id, // correlation id from requestContext middleware
        });
        return res.status(200).json({ data: collection, requestId: req.id });
    } catch (err) {
        // The service already emitted a structured, correlated log line; here we
        // only shape the HTTP response and echo the correlation id so a user can
        // quote it in a bug report.
        const status = err.statusCode || 500;
        return res.status(status).json({
            error: err.message || "Internal server error",
            requestId: req.id,
        });
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
