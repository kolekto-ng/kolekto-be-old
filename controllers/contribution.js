import { supabase } from "../utils/client.js";

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

    return res.status(200).json({ success: true, data });
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
        `);

    // If it looks like a UUID, use ID; otherwise use slug
    if (uuidRegex.test(identifier)) {
        query = query.eq('id', identifier);
    } else {
        query = query.eq('slug', identifier);
    }

    const { data, error } = await query.single();

    console.log(data, 'collection data');

    if (error) {
        return res.status(404).json({ message: error.message });
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
            .select("*");

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

            // Fee calculation
            let kolektoFee = Math.min(tierPrice * 0.005, 2000); // 0.5% capped ₦2,000
            let gatewayFee = Math.min(tierPrice * 0.015, 2000); // 1.5% capped ₦2,000
            const totalFees = kolektoFee + gatewayFee;

            amountBreakdown = {
                type: "tiered", // keep "tiered" if frontend depends on it
                tier: {
                    name: selectedTier.name,
                    basePrice: tierPrice,
                    fee_bearer: fee_bearer || "organizer",
                    platformFee: kolektoFee,
                    paymentGatewayFee: gatewayFee,
                    totalFees,
                    totalPayable:
                        fee_bearer === "contributor"
                            ? tierPrice + totalFees
                            : tierPrice,
                },
            };

            parsedAmount = amountBreakdown.tier.totalPayable;

        } else if (collectionType === "fixed") {
            // ✅ Fixed contribution

            if (isNaN(collectionAmount) || collectionAmount <= 100) {
                return res.status(400).json({ error: "Collection amount must be greater than ₦100" });
            }
            parsedAmount = collectionAmount;


            // Base amount is always the collection's set amount

            // Fee calculation
            let kolektoFee = Math.min(parsedAmount * 0.005, 2000); // 0.5% capped ₦2,000
            let gatewayFee = Math.min(parsedAmount * 0.015, 2000); // 1.5% capped ₦2,000
            const totalFees = kolektoFee + gatewayFee;

            amountBreakdown = {
                type: "fixed",
                baseAmount: parsedAmount,            // <- always collection’s fixed amount
                fee_bearer: fee_bearer || "organizer",
                platformFee: kolektoFee,
                paymentGatewayFee: gatewayFee,
                totalFees,
                totalPayable:
                    fee_bearer === "contributor"
                        ? parsedAmount + totalFees
                        : parsedAmount,
            };

            // ✅ final amount contributor should pay
            parsedAmount = amountBreakdown.totalPayable;

            console.log({ parsedAmount, kolektoFee, gatewayFee, totalFees }, "<< breakdown");
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
            console.log('fundraising fee calculation', numericAmount);
            parsedAmount = numericAmount + numericAmount * 0.025;
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
