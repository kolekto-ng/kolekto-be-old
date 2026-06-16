import { supabase } from "../utils/client.js";

export const getCollectionWallet = async (req, res) => {
    const { collectionId } = req.query;
    if (!collectionId) {
        return res.status(400).json({ error: "collectionId is required" });
    }

    // Use order+limit instead of .single() because legacy data may contain
    // duplicate wallet rows for the same collection (missing UNIQUE constraint).
    const { data: wallets, error } = await supabase
        .from("wallets")
        .select("*")
        .eq("collection_id", collectionId)
        .order("updated_at", { ascending: false })
        .limit(1);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    const wallet = wallets && wallets[0];
    if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
    }

    return res.status(200).json(wallet);
};