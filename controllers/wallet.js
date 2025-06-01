import { supabase } from "../utils/client.js";

export const getCollectionWallet = async (req, res) => {
    const { collectionId } = req.query;
    if (!collectionId) {
        return res.status(400).json({ error: "collectionId is required" });
    }

    const { data: wallet, error } = await supabase
        .from("wallets")
        .select("*")
        .eq("collection_id", collectionId)
        .single();

    if (error || !wallet) {
        return res.status(404).json({ error: "Wallet not found" });
    }

    return res.status(200).json(wallet);
};