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
    const { collectionId } = req.query;

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
        .eq('id', collectionId)
        .single();

    console.log(data, 'collectiopn data');
    if (data?.max_contributions == data?.total_contributions) {
        res.status(200).json({ message: "collection is full", data })
    }

    if (error) {
        return res.status(404).json({ error: error.message });
    }


    return res.status(200).json({ data });
};

export const createContribution = async (req, res) => {
    const { contributor, collectionType } = req.body;
    let { name, email, phone, amount, contributionInformation, collectionId } = contributor || {};

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

        const { data: collection, error: collectionError } = await supabase
            .from("collections")
            .select("*")
            .eq("id", collectionId)
            .single();
        if (collectionError || !collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found",
            });
        }


        const { type: collection_type, fee_bearer, price_tiers, amount: collectionAmount } = collection;
        console.log(collection, '<< collection details');

        let collectionType = collection_type || "fixed";
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
                .eq("collection_id", collectionId)
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
            console.log('fundraising fee calculation', amount);

            parsedAmount = parseFloat(amount + (amount * 0.025)); // minimum ₦100

        }

        // Insert contributor
        const { data: contributorData, error: contributorError } = await supabase
            .from("contributions")
            .insert([{
                collection_id: collectionId,
                name,
                email,
                phone,
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
