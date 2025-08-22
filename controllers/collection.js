import { supabase } from '../utils/client.js';

// controllers/collections.js
export const createCollection = async (req, res) => {
    const {
        title,
        description,
        amount,
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
    if (!title) {
        return res.status(400).json({ error: "Title is required" });
    }

    if (!deadline || isNaN(Date.parse(deadline)) || new Date(deadline) <= new Date()) {
        return res.status(400).json({ error: "Deadline must be a valid future date" });
    }

    const user_id = req.user.id;

    // ------------------------
    // 2. Determine collection type
    // ------------------------
    let collectionType = "flat"; // default
    let parsedAmount = null;

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
        // Flat collection
        if (!amount) {
            return res.status(400).json({ error: "Amount is required for flat collections" });
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

    if (collectionType === "flat" && !isNaN(parsedAmount)) {
        // ----------- Flat collection fees -----------
        let kolektoFee;

        if (parsedAmount < 1000) {
            kolektoFee = 30;
        } else if (parsedAmount <= 5000) {
            kolektoFee = 50;
        } else if (parsedAmount <= 10000) {
            kolektoFee = 100;
        } else if (parsedAmount <= 20000) {
            kolektoFee = 200;
        } else {
            kolektoFee = Math.min(parsedAmount * 0.01, 2000);
        }

        let gatewayFee = Math.min(parsedAmount * 0.015, 2000);
        const totalFees = kolektoFee + gatewayFee;

        amountBreakdown = {
            type: "flat",
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
                let kolektoFee;

                if (tier.price < 1000) {
                    kolektoFee = 30;
                } else if (tier.price <= 5000) {
                    kolektoFee = 50;
                } else if (tier.price <= 10000) {
                    kolektoFee = 100;
                } else if (tier.price <= 20000) {
                    kolektoFee = 200;
                } else {
                    kolektoFee = Math.min(tier.price * 0.01, 2000);
                }

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
            amountBreakdown: collection.type === "flat"
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
            amountBreakdown: data.type === "flat"
                ? data.wallets?.fee_breakdown || {}
                : null
        };

        return res.status(200).json({ collection });
    } catch (err) {
        console.error("Error fetching collection:", err);
        return res.status(500).json({ error: "Unexpected server error" });
    }
};
