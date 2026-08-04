import { supabase } from "../utils/client.js";
import { calculateFees } from "../utils/financial.js";
import { normalizeContributorRows } from "../utils/contributionNormalize.js";

// Get contributions, optionally filtered by collectionId
export const getContributions = async (req, res) => {
    const { collectionId } = req.query;

    let query = supabase
        .from("contributions")
        .select("*")
        .order("created_at", { ascending: false });

    if (collectionId) {
        query = query.eq("collection_id", collectionId);
    }

    const { data, error } = await query;

    if (error) {
        return res.status(500).json({ success: false, message: error.message });
    }

    // Normalize mixed/older row shapes (legacy column names, contributor info
    // stored under a different key, etc.) into one consistent response shape.
    // Read-side only — does not touch stored data or any balance/payment logic.
    return res.status(200).json({ success: true, data: normalizeContributorRows(data) });
};

export const getSingleCollection = async (req, res) => {
    const { collectionId, slug } = req.query;

    // Determine if we're using ID or slug
    // UUID format: 8-4-4-4-12 hex characters
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const identifier = collectionId || slug;

    if (!identifier) {
        return res.status(400).json({ error: "Collection ID or slug is required" });
    }

    // Build query - check if identifier is UUID (backward compatible) or slug
    let query = supabase
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
        .limit(1);

    // If it looks like a UUID, use ID; otherwise use slug
    if (uuidRegex.test(identifier)) {
        query = query.eq('id', identifier);
    } else {
        query = query.eq('slug', identifier);
    }

    const { data, error } = await query.single();

    if (error) {
        return res.status(404).json({ message: error.message });
    }

    // A deleted collection is archived (status='deleted'), not removed from the
    // DB — payment/withdrawal records are preserved for the host — but
    // contributors must never be able to view or pay into it.
    if (data?.status === 'deleted') {
        return res.status(404).json({ message: 'Collection not found' });
    }

    // Check if collection is full
    if (data?.max_contributions && data?.max_contributions == data?.total_contributions) {
        return res.status(200).json({ message: "collection is full", data });
    }

    return res.status(200).json({ data });
};

export const createContribution = async (req, res) => {
    const { contributor, collectionType } = req.body;
    let { name, email, phoneNumber, amount, contributionInformation, collectionId } = contributor || {};

    // Validate required fields
    const requiredFields = ["name", "email", "amount"];
    const missingFields = requiredFields.filter((field) => !contributor?.[field]);
    if (missingFields.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Please provide ${missingFields.join(", ")}`,
        });
    }



    try {
        // Check if collection exists
        // ✅ Step 2: Fetch collection details
        // Support both ID (UUID) and slug for backward compatibility
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        let collectionQuery = supabase
            .from("collections")
            .select("*")
            .limit(1);

        // If it looks like a UUID, use ID; otherwise use slug
        if (uuidRegex.test(collectionId)) {
            collectionQuery = collectionQuery.eq("id", collectionId);
        } else {
            collectionQuery = collectionQuery.eq("slug", collectionId);
        }

        const { data: collection, error: collectionError } = await collectionQuery.single();
        if (collectionError || !collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found",
            });
        }

        // Use the actual collection ID from the fetched collection
        const actualCollectionId = collection.id;

        const { collection_type: col_type_new, type: col_type_old, fee_bearer, price_tiers, amount: collectionAmount } = collection;
        console.log(collection, '<< collection details');

        // Use collection_type column first (new wizard), fall back to type column (legacy)
        let collectionType = col_type_new || col_type_old || "fixed";
        let parsedAmount = null;
        let amountBreakdown = {};

        // B-13: All fee math routes through calculateFees(). The breakdown
        // shape preserves the legacy field names (paymentGatewayFee) so the
        // host FE and admin panel see exactly the same payload they did
        // before.
        const resolvedFeeBearer = fee_bearer || "organizer";

        // ✅ Step 3: Handle contribution depending on collection type
        if (collectionType === "tiered") {
            // pick first selected tier from contributor_information
            const selectedTierName = contributionInformation?.[0]?.Tier;
            if (!selectedTierName) {
                return res.status(400).json({ error: "No tier selected" });
            }

            // find that tier in collection.price_tiers
            const selectedTier = price_tiers.find(
                (t) => t.name.toLowerCase() === selectedTierName.toLowerCase()
            );

            if (!selectedTier) {
                return res.status(400).json({ error: `Tier "${selectedTierName}" not found in collection` });
            }

            const tierPrice = parseFloat(selectedTier.price);
            if (isNaN(tierPrice) || tierPrice <= 100) {
                return res.status(400).json({ error: `Invalid tier price for "${selectedTier.name}"` });
            }

            const { platformFee, gatewayFee, totalFees, totalPayable } =
                calculateFees(tierPrice, "tiered", resolvedFeeBearer);

            amountBreakdown = {
                type: "tiered", // keep "tiered" if frontend depends on it
                tier: {
                    name: selectedTier.name,
                    basePrice: tierPrice,
                    fee_bearer: resolvedFeeBearer,
                    platformFee,
                    paymentGatewayFee: gatewayFee,
                    totalFees,
                    totalPayable,
                },
            };

            parsedAmount = totalPayable;

        } else if (collectionType === "fixed") {
            if (isNaN(collectionAmount) || collectionAmount <= 100) {
                return res.status(400).json({ error: "Collection amount must be greater than ₦100" });
            }

            const { platformFee, gatewayFee, totalFees, totalPayable } =
                calculateFees(collectionAmount, "fixed", resolvedFeeBearer);

            amountBreakdown = {
                type: "fixed",
                baseAmount: collectionAmount,        // collection's fixed amount
                fee_bearer: resolvedFeeBearer,
                platformFee,
                paymentGatewayFee: gatewayFee,
                totalFees,
                totalPayable,
            };

            // ✅ final amount contributor should pay
            parsedAmount = totalPayable;
        }


        // (Optional) Check max contributions at API level
        if (collection.max_contributions && collection.max_contributions > 0) {
            const { count, error: countError } = await supabase
                .from("contributions")
                .select("id", { count: "exact", head: true })
                .eq("collection_id", actualCollectionId)
                .eq("status", "paid");

            if (countError) throw new Error("Failed to count participants");
            if (count >= collection.max_contributions) {
                return res.status(400).json({
                    success: false,
                    message: "Maximum contributions reached",
                });
            }
        }
        if (collectionType === 'fundraising') {
            const numericAmount = parseFloat(amount);
            if (isNaN(numericAmount) || numericAmount <= 100) {
                return res.status(400).json({ error: "Donation amount must be greater than ₦100" });
            }
            // B-13: Replace the hardcoded 0.025 (1% platform + 1.5% gateway,
            // contributor-borne) with calculateFees. This stays in sync with
            // utils/financial.js if rates change, and respects the ₦2,000 fee
            // cap that the old hardcoded math silently ignored.
            const { totalPayable } = calculateFees(numericAmount, "fundraising", "contributor");
            parsedAmount = totalPayable;
        } else if (collectionType === 'open_pool') {
            const numericAmount = parseFloat(amount);
            if (isNaN(numericAmount) || numericAmount <= 0) {
                return res.status(400).json({ error: "Contribution amount must be greater than ₦0" });
            }
            parsedAmount = numericAmount;
        } else if (collectionType === 'ticket') {
            // amount from frontend already includes quantity × price (and fees if contributor-borne)
            const numericAmount = parseFloat(amount);
            if (isNaN(numericAmount) || numericAmount <= 0) {
                return res.status(400).json({ error: "Invalid ticket amount" });
            }
            parsedAmount = numericAmount;
        }
        console.log(parsedAmount, 'parsd amo', collectionType);

        // Final safety check: parsedAmount must be a positive number
        if (parsedAmount === null || parsedAmount === undefined || isNaN(parsedAmount) || parsedAmount <= 0) {
            console.error('parsedAmount is null/invalid for type:', collectionType, 'amount:', amount, 'collectionAmount:', collectionAmount);
            return res.status(400).json({ error: `Could not determine contribution amount for collection type "${collectionType}". Please contact support.` });
        }

        // Insert contributor
        const { data: contributorData, error: contributorError } = await supabase
            .from("contributions")
            .insert([{
                collection_id: actualCollectionId,
                name,
                email,
                phone: phoneNumber,
                amount: parsedAmount,
                contributor_information: contributionInformation || [],
                status: "pending",
            }])
            .select()
            .single();

        if (contributorError) {
            if (contributorError.message.includes("Maximum contributions reached")) {
                return res.status(400).json({
                    success: false,
                    message: "Maximum contributions reached",
                });
            }
            throw contributorError;
        }

        return {
            contributor: contributorData,
            contributorId: contributorData.id,
        }

    } catch (error) {
        console.error("Error in createContribution:", error);
        res.status(500).json({
            success: false,
            message: error.message || "Internal server error",
        });
    }
};
