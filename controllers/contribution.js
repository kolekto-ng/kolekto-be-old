import { supabase } from "../utils/client.js";

export const getSingleCollection = async (req, res) => {
    const { collectionId } = req.query;
    console.log(`Fetching collection with ID: ${collectionId}`);

    const { data, error } = await supabase
        .from('collections')
        .select('*')
        .eq('id', collectionId)
        .single();

    if (error) {
        return res.status(404).json({ error: error.message });
    }

    return res.status(200).json({ data });
};