import { supabase } from "../utils/client.js";

export const collectionActivities = async (req, res) => {
    const user_id = req.user.id;

    // Fetch user contributors activities from the database
    try {
        const { data, error } = await supabase
            .from('collections')
            .select('*')
            .eq('user_id', user_id)
            .limit(10) // Limit to recent 10 activities
            .order('created_at', { ascending: false })

        if (error) throw error;

        // use the collections to fetch related data from the cotributors tables
        const activities = [];
        for (const collection of data) {
            const { data: contributorsData, error: contributorsError } = await supabase
                .from('contributions')
                .select('*')
                .eq('collection_id', collection.id)
                .eq('status', 'paid')
                .limit(5) // Limit to recent 5 contributions per collection
                .order('created_at', { ascending: false });
            if (contributorsError) throw contributorsError;
            activities.push(...contributorsData);
        }
        res.status(200).json({ message: 'User activities fetched successfully', data: activities });


    } catch (err) {
        console.log(err);

        res.status(500).json({ error: err.message });
    }
};