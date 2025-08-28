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

    console.log("Collection data:", data);

    return res.status(200).json({ data });
};

// Create a new contribution (contributor)
export const createContribution = async (req, res) => {
    const { name, email, phone, amount, contributionInformation, collectionId } = req.body.contributor;

    // const collectionId= req.params.id;

    // Parse contributionInformation || []; if needed
    // let parsedParticipantInfo = contributionInformation || [];
    // if (
    //     typeof contributionInformation === "string"
    // ) {
    //     try {
    //         parsedParticipantInfo = JSON.parse(contributionInformation);
    //     } catch (error) {
    //         console.error("Failed to parse contributionInformation || [];:", error);
    //         return res.status(400).json({
    //             success: false,
    //             message: "Invalid contributionInformation || []; format",
    //         });
    //     }
    // }

    // Validate required fields
    const requiredFields = ["name", "email", "amount"];
    const missingFields = requiredFields.filter((field) => !req.body[field]);
    if (missingFields.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Please provide ${missingFields.join(", ")}`,
        });
    }

    // Start transaction (using Supabase's RPC for rollback, if available)
    const client = supabase; // Supabase JS client does not support multi-statement transactions directly
    try {
        // Check if collection exists
        const { data: collection, error: collectionError } = await client
            .from('collections')
            .select('*')
            .eq('id', collectionId)
            .single();

        if (collectionError || !collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found",
            });
        }

        // Check max participants if applicable
        if (
            collection.max_participants &&
            collection.max_participants > 0
        ) {
            const { count, error: countError } = await client
                .from('contributions')
                .select('id', { count: 'exact', head: true })
                .eq('collection_id', collectionId)
                .eq('status', 'paid');

            if (countError) {
                throw new Error("Failed to count participants");
            }

            if (count >= collection.max_participants) {
                return res.status(400).json({
                    success: false,
                    message: "Maximum participants reached",
                });
            }
        }

        // Generate unique code if needed
        let contributorUniqueCode = null;
        if (collection.code_prefix) {
            contributorUniqueCode = `${collection.code_prefix}_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        }

        // Insert contributor (contribution)
        const { data: contributor, error: contributorError } = await client
            .from('contributions')
            .insert([{
                collection_id: collectionId,
                name,
                email,
                phone,
                amount,
                contributor_information: contributionInformation || [],
                status: "pending",
            }])
            .select()
            .single();

        if (contributorError) {
            throw new Error(contributorError.message);
        }
        return {
            contributor,
            contributorId: contributor.id,
        }
        res.status(201).json({
            success: true,
            message: "Contributor added, payment initialized",
            contributor,
            contributorId: contributor.id,
        });
    } catch (error) {
        console.error("Error in createContribution:", error);
        res.status(500).json({
            success: false,
            message: error.message || "Internal server error",
        });
    }
};