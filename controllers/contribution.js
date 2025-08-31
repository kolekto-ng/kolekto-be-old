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

    if (error) {
        return res.status(404).json({ error: error.message });
    }


    return res.status(200).json({ data });
};

// Create a new contribution (contributor)
// export const createContribution = async (req, res) => {
//     const { name, email, phone, amount, contributionInformation, collectionId } = req.body.contributor;

//     // Validate required fields
//     const requiredFields = ["name", "email", "amount"];
//     const missingFields = requiredFields.filter((field) => !req.body[field]);
//     if (missingFields.length > 0) {
//         return res.status(400).json({
//             success: false,
//             message: `Please provide ${missingFields.join(", ")}`,
//         });
//     }

//     // Start transaction (using Supabase's RPC for rollback, if available)
//     const client = supabase; // Supabase JS client does not support multi-statement transactions directly
//     try {
//         // Check if collection exists
//         const { data: collection, error: collectionError } = await client
//             .from('collections')
//             .select('*')
//             .eq('id', collectionId)
//             .single();

//         if (collectionError || !collection) {
//             return res.status(404).json({
//                 success: false,
//                 message: "Collection not found",
//             });
//         }

//         // Check max participants if applicable
//         if (
//             collection.max_contributions &&
//             collection.max_contributions > 0
//         ) {
//             const { count, error: countError } = await client
//                 .from('contributions')
//                 .select('id', { count: 'exact', head: true })
//                 .eq('collection_id', collectionId)
//                 .eq('status', 'paid');

//             if (countError) {
//                 throw new Error("Failed to count participants");
//             }

//             if (count >= collection.max_contributions) {
//                 return res.status(400).json({
//                     success: false,
//                     message: "Maximum participants reached",
//                 });
//             }
//         }

//         // Generate unique code if needed
//         let contributorUniqueCode = null;
//         if (collection.code_prefix) {
//             contributorUniqueCode = `${collection.code_prefix}_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
//         }

//         // Insert contributor (contribution)
//         const { data: contributor, error: contributorError } = await client
//             .from('contributions')
//             .insert([{
//                 collection_id: collectionId,
//                 name,
//                 email,
//                 phone,
//                 amount,
//                 contributor_information: contributionInformation || [],
//                 status: "pending",
//             }])
//             .select()
//             .single();

//         if (contributorError) {
//             throw new Error(contributorError.message);
//         }
//         return {
//             contributor,
//             contributorId: contributor.id,
//         }
//     } catch (error) {
//         console.error("Error in createContribution:", error);
//         res.status(500).json({
//             success: false,
//             message: error.message || "Internal server error",
//         });
//     }
// };

export const createContribution = async (req, res) => {
    const { contributor } = req.body;
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
            let kolektoFee;
            if (tierPrice < 1000) kolektoFee = 30;
            else if (tierPrice <= 5000) kolektoFee = 50;
            else if (tierPrice <= 10000) kolektoFee = 100;
            else if (tierPrice <= 20000) kolektoFee = 200;
            else kolektoFee = Math.min(tierPrice * 0.01, 2000);

            let gatewayFee = Math.min(tierPrice * 0.015, 2000);
            const totalFees = kolektoFee + gatewayFee;

            amountBreakdown = {
                type: "tiered",
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

        } else {
            // ✅ Fixed contribution


            if (isNaN(collectionAmount) || collectionAmount <= 100) {
                return res.status(400).json({ error: "Collection amount must be greater than ₦100" });
            }

            // Base amount is always the collection's set amount
            parsedAmount = collectionAmount;

            // Fee calculation
            let kolektoFee;
            if (parsedAmount < 1000) kolektoFee = 30;
            else if (parsedAmount <= 5000) kolektoFee = 50;
            else if (parsedAmount <= 10000) kolektoFee = 100;
            else if (parsedAmount <= 20000) kolektoFee = 200;
            else kolektoFee = Math.min(parsedAmount * 0.01, 2000);

            let gatewayFee = Math.min(parsedAmount * 0.015, 2000);
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
