import { supabase } from "../utils/client.js";

const FINAL_WITHDRAWAL_STATUSES = new Set(["success", "completed", "processed"]);
const WAT_OFFSET_HOURS = 1;

function getSettlementCutoffUtc(now = new Date()) {
    // Nigeria (WAT) is UTC+1 all year (no DST).
    const watNow = new Date(now.getTime() + WAT_OFFSET_HOURS * 60 * 60 * 1000);
    const year = watNow.getUTCFullYear();
    const month = watNow.getUTCMonth();
    const day = watNow.getUTCDate();
    const watHour = watNow.getUTCHours();

    // 5:00 AM WAT is 4:00 AM UTC.
    const cutoffUtc = new Date(Date.UTC(year, month, day, 4, 0, 0, 0));
    if (watHour < 5) {
        cutoffUtc.setUTCDate(cutoffUtc.getUTCDate() - 1);
    }
    return cutoffUtc;
}

export const getDashboardStats = async (req, res) => {
    const userId = req.user.id;

    try {
        const { data: collections, error: collectionsError } = await supabase
            .from("collections")
            .select("id, status")
            .eq("user_id", userId);

        if (collectionsError) {
            throw collectionsError;
        }

        const rows = collections || [];
        const collectionIds = rows.map((c) => c.id);
        const totalCollections = rows.length;
        const activeCollections = rows.filter((c) => c.status === "active").length;

        if (collectionIds.length === 0) {
            return res.status(200).json({
                totalCollections,
                activeCollections,
                totalBalance: 0,
                availableBalance: 0,
                pendingBalance: 0,
                totalRaised: 0,
                pendingWithdrawalRequests: 0,
                cutoffUtc: getSettlementCutoffUtc().toISOString(),
            });
        }

        const [{ data: contributions, error: contributionsError }, { data: withdrawals, error: withdrawalsError }] = await Promise.all([
            supabase
                .from("contributions")
                .select("amount, created_at")
                .in("collection_id", collectionIds)
                .eq("status", "paid"),
            supabase
                .from("withdrawals")
                .select("amount, status")
                .in("collection_id", collectionIds),
        ]);

        if (contributionsError) throw contributionsError;
        if (withdrawalsError) throw withdrawalsError;

        const contributionRows = contributions || [];
        const withdrawalRows = withdrawals || [];
        const cutoffUtc = getSettlementCutoffUtc();

        const totalCollected = contributionRows.reduce(
            (sum, row) => sum + Number(row.amount || 0),
            0
        );

        const pendingBalance = contributionRows
            .filter((row) => {
                if (!row.created_at) return false;
                const createdAt = new Date(row.created_at);
                return !Number.isNaN(createdAt.getTime()) && createdAt >= cutoffUtc;
            })
            .reduce((sum, row) => sum + Number(row.amount || 0), 0);

    const successfulWithdrawals = withdrawalRows
        .filter((row) => FINAL_WITHDRAWAL_STATUSES.has(String(row.status || "").toLowerCase()))
        .reduce((sum, row) => sum + Number(row.amount || 0), 0);

    const approvedWithdrawals = withdrawalRows
        .filter((row) => String(row.status || "").toLowerCase() === "approved")
        .reduce((sum, row) => sum + Number(row.amount || 0), 0);

    const pendingWithdrawalRequests = withdrawalRows
        .filter((row) => String(row.status || "").toLowerCase() === "pending")
        .reduce((sum, row) => sum + Number(row.amount || 0), 0);

    const totalBalance = Math.max(0, totalCollected - successfulWithdrawals);
    const availableBalance = Math.max(0, totalBalance - pendingBalance - pendingWithdrawalRequests - approvedWithdrawals);

        return res.status(200).json({
            totalCollections,
            activeCollections,
            totalBalance,
            availableBalance,
            pendingBalance,
            totalRaised: totalCollected,
            pendingWithdrawalRequests: 0,
            cutoffUtc: cutoffUtc.toISOString(),
        });
    } catch (err) {
        return res.status(500).json({
            error: err.message || "Failed to compute dashboard stats",
        });
    }
};

export const getCollectionDashboardStats = async (req, res) => {
    const userId = req.user.id;
    const { collectionId } = req.params;

    try {
        if (!collectionId) {
            return res.status(400).json({ error: "Collection ID is required" });
        }

        const { data: collection, error: collectionError } = await supabase
            .from("collections")
            .select("id, user_id, status")
            .eq("id", collectionId)
            .single();

        if (collectionError || !collection) {
            return res.status(404).json({ error: "Collection not found" });
        }

        if (collection.user_id !== userId) {
            return res.status(403).json({ error: "Unauthorized access to collection stats" });
        }

        const [{ data: contributions, error: contributionsError }, { data: withdrawals, error: withdrawalsError }] = await Promise.all([
            supabase
                .from("contributions")
                .select("amount, created_at")
                .eq("collection_id", collectionId)
                .eq("status", "paid"),
            supabase
                .from("withdrawals")
                .select("amount, status")
                .eq("collection_id", collectionId),
        ]);

        if (contributionsError) throw contributionsError;
        if (withdrawalsError) throw withdrawalsError;

        const contributionRows = contributions || [];
        const withdrawalRows = withdrawals || [];
        const cutoffUtc = getSettlementCutoffUtc();

        const totalCollected = contributionRows.reduce(
            (sum, row) => sum + Number(row.amount || 0),
            0
        );

        const pendingBalance = contributionRows
            .filter((row) => {
                if (!row.created_at) return false;
                const createdAt = new Date(row.created_at);
                return !Number.isNaN(createdAt.getTime()) && createdAt >= cutoffUtc;
            })
            .reduce((sum, row) => sum + Number(row.amount || 0), 0);

        const successfulWithdrawals = withdrawalRows
            .filter((row) => FINAL_WITHDRAWAL_STATUSES.has(String(row.status || "").toLowerCase()))
            .reduce((sum, row) => sum + Number(row.amount || 0), 0);

        const approvedWithdrawals = withdrawalRows
            .filter((row) => String(row.status || "").toLowerCase() === "approved")
            .reduce((sum, row) => sum + Number(row.amount || 0), 0);

        const pendingWithdrawalRequests = withdrawalRows
            .filter((row) => String(row.status || "").toLowerCase() === "pending")
            .reduce((sum, row) => sum + Number(row.amount || 0), 0);

        const totalBalance = Math.max(0, totalCollected);
        const availableBalance = Math.max(
            0,
            totalCollected - pendingBalance - pendingWithdrawalRequests - successfulWithdrawals - approvedWithdrawals
        );
        const paidContributionsCount = contributionRows.length;

        return res.status(200).json({
            collectionId,
            collectionStatus: collection.status,
            totalRaised: totalCollected,
            totalBalance,
            availableBalance,
            pendingBalance,
            pendingWithdrawalRequests,
            paidContributionsCount,
            cutoffUtc: cutoffUtc.toISOString(),
        });
    } catch (err) {
        return res.status(500).json({
            error: err.message || "Failed to compute collection dashboard stats",
        });
    }
};

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
