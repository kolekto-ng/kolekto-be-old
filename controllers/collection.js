import { supabase } from '../utils/client.js';

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
        price_tiers, // <-- array of tiers if tiered
    } = req.body;

    // ------------------------
    // 1. Basic validations
    // ------------------------
    let collectionType = "fixed"; // default
    let parsedAmount = null;

    if (collection_type && !["fixed", "tiered", "fundraising"].includes(collection_type)) {
        return res.status(400).json({ error: "Collection type must be either 'fixed' or 'tiered'" });
    }

    if (collection_type === "fundraising" && (!target_amount || isNaN(parseFloat(target_amount)) || parseFloat(target_amount) <= 0)) {
        return res.status(400).json({ error: "Target amount must be a positive number for fundraising collections" });
    }

    if (collection_type === "fundraising") {
        if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 100) {
            return res.status(400).json({ error: "Amount must be greater than ₦100 for fundraising collections" });
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
        return res.status(400).json({ error: "Title is required" });
    }

    if (collection_type !== "fundraising") {
        if (!deadline || isNaN(Date.parse(deadline)) || new Date(deadline) <= new Date()) {
            return res.status(400).json({ error: "Deadline must be a valid future date" });
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
            return res.status(400).json({ error: "Amount is required for fixed collections" });
        }

        parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 100) {
            return res.status(400).json({ error: "Amount must be greater than ₦100" });
        }
    }

    // ------------------------
    // 3. Fee Breakdown
    // ------------------------
    let amountBreakdown = {};

    if (collectionType === "fixed" && !isNaN(parsedAmount)) {
        // ----------- fixed collection fees -----------
        let kolektoFee = Math.min(parsedAmount * 0.005, 2000); // 0.5% capped at ₦2,000
        let gatewayFee = Math.min(parsedAmount * 0.015, 2000); // 1.5% capped at ₦2,000

        const totalFees = kolektoFee + gatewayFee;


        amountBreakdown = {
            type: "fixed",
            amount: parsedAmount,
            fee_bearer: fee_bearer || "organizer",
            platformFee: kolektoFee,
            paymentGatewayFee: gatewayFee,
            totalFees,
            totalPayable:
                fee_bearer === "contributor"
                    ? parsedAmount + totalFees
                    : parsedAmount,
        };
    } else if (collectionType === "tiered") {
        // ----------- Tiered collection fees -----------
        amountBreakdown = {
            type: "tiered",
            tiers: price_tiers.map((tier) => {
                // Kolekto fee: 0.5% capped at ₦2,000
                let kolektoFee = Math.min(tier.price * 0.005, 2000);

                // Gateway fee: 1.5% capped at ₦2,000
                let gatewayFee = Math.min(tier.price * 0.015, 2000);

                const totalFees = kolektoFee + gatewayFee;

                return {
                    name: tier.name,
                    price: tier.price,
                    quantity: tier.quantity, // null = unlimited
                    fee_bearer: fee_bearer || "organizer",
                    platformFee: kolektoFee,
                    paymentGatewayFee: gatewayFee,
                    totalFees,
                    totalPayable:
                        fee_bearer === "contributor"
                            ? tier.price + totalFees
                            : tier.price,
                };
            }),
        };
    }

    if (collection_type === "fundraising") {
        if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 100) {
            return res.status(400).json({ error: "Amount must be greater than ₦100 for fundraising collections" });
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

    try {
        // ------------------------
        // 4. Insert collection
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
                    max_contributions,
                    contributions_fields: contributions_fields || [],
                    status: status || "active",
                    fee_bearer: fee_bearer || "organizer",
                    currency: currency || "NGN",
                    currency_symbol: currency_symbol || "₦",
                    total_contributions: 0,
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
            return res.status(500).json({ error: error.message });
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
                error:
                    "Collection created but wallet creation failed: " +
                    walletError.message,
            });
        }

        return res.status(201).json({ collection });
    } catch (error) {
        console.error("Error creating collection:", error);
        return res
            .status(500)
            .json({ error: "Unexpected server error: " + error.message });
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
                    ledger_balance,
                    gross_payment,
                    net_payment,
                    withdrawn,
                    fee_breakdown,
                    currency,
                    currency_symbol
                )
            `)
            .eq('user_id', user_id);

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
    const {
        title,
        description,
        deadline,
        max_contributions,
        contributions_fields,
        price_tiers,
        collectionType
    } = req.body;

    // Prepare update data
    const updateData = {
        title,
        description,
        deadline,
        max_contributions: collectionType === 'fixed' ? (max_contributions || null) : null,
        contributions_fields: Array.isArray(contributions_fields) && contributions_fields.length > 0 ? contributions_fields : null,
        price_tiers: collectionType === 'tiered' ? price_tiers : null,
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
    console.log(collectionId, newStatus);

    if (!collectionId || !newStatus) {
        return res.status(400).json({ error: "Collection ID and new status are required." });
    }

    const { error } = await supabase
        .from('collections')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', collectionId);

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({ message: "Collection status updated successfully." });
};


