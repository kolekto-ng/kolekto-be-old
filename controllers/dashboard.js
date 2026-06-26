import { supabase } from "../utils/client.js";
import {
  roundCurrency,
  normalizeContributions,
  computeWalletBalances,
} from "../utils/financial.js";

const FINAL_WITHDRAWAL_STATUSES = new Set([
  "success",
  "completed",
  "processed",
]);
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
      .select("id, status, fee_bearer, collection_type")
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

    const [
      { data: contributions, error: contributionsError },
      { data: withdrawals, error: withdrawalsError },
    ] = await Promise.all([
      supabase
        .from("contributions")
        .select("collection_id, amount, gross_amount, created_at")
        .in("collection_id", collectionIds)
        .eq("status", "paid"),
      supabase
        .from("withdrawals")
        .select("amount, status")
        .in("collection_id", collectionIds),
    ]);

    if (contributionsError) throw contributionsError;
    if (withdrawalsError) throw withdrawalsError;

    const collectionMap = new Map(rows.map((c) => [c.id, c]));

    // Group contributions by collection to normalize them
    const contribsByCollection = new Map();
    for (const row of contributions || []) {
      const list = contribsByCollection.get(row.collection_id) || [];
      list.push(row);
      contribsByCollection.set(row.collection_id, list);
    }

    const normalizedContributions = [];
    for (const [colId, list] of contribsByCollection) {
      const col = collectionMap.get(colId);
      const normalized = normalizeContributions(
        list,
        col?.fee_bearer || "organizer",
        col?.collection_type || "fixed",
      );
      normalizedContributions.push(...normalized);
    }

    const withdrawalRows = withdrawals || [];
    const cutoffUtc = getSettlementCutoffUtc();

    const balances = computeWalletBalances(
      normalizedContributions,
      withdrawalRows,
    );

    const pendingWithdrawalRequests = roundCurrency(
      withdrawalRows
        .filter((row) =>
          ["pending", "processing"].includes(
            String(row.status || "").toLowerCase(),
          ),
        )
        .reduce((sum, row) => sum + Number(row.amount || 0), 0),
    );

    const totalBalance = balances.ledgerBalance;
    const availableBalance = Math.max(
      0,
      balances.availableBalance - pendingWithdrawalRequests,
    );
    const pendingBalance = balances.pendingBalance;

    return res.status(200).json({
      totalCollections,
      activeCollections,
      totalBalance,
      availableBalance,
      pendingBalance,
      totalRaised: balances.netPayment,
      pendingWithdrawalRequests,
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
      .select("id, user_id, status, fee_bearer, collection_type")
      .eq("id", collectionId)
      .single();

    if (collectionError || !collection) {
      return res.status(404).json({ error: "Collection not found" });
    }

    if (collection.user_id !== userId) {
      return res
        .status(403)
        .json({ error: "Unauthorized access to collection stats" });
    }

    const [
      { data: contributions, error: contributionsError },
      { data: withdrawals, error: withdrawalsError },
    ] = await Promise.all([
      supabase
        .from("contributions")
        .select("amount, gross_amount, created_at")
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

    const normalized = normalizeContributions(
      contributionRows,
      collection.fee_bearer || "organizer",
      collection.collection_type || "fixed",
    );

    const balances = computeWalletBalances(normalized, withdrawalRows);

    const pendingWithdrawalRequests = roundCurrency(
      withdrawalRows
        .filter((row) =>
          ["pending", "processing"].includes(
            String(row.status || "").toLowerCase(),
          ),
        )
        .reduce((sum, row) => sum + Number(row.amount || 0), 0),
    );

    const totalBalance = balances.ledgerBalance;
    const availableBalance = Math.max(
      0,
      balances.availableBalance - pendingWithdrawalRequests,
    );
    const pendingBalance = balances.pendingBalance;
    const paidContributionsCount = normalized.length;

    // Total withdrawn = anything that has hit the user's bank account
    // (success/completed/successful from the legacy Paystack-transfer
    // flow) plus anything the admin manually marked approved.
    const totalWithdrawn = balances.completedWithdrawals;

    return res.status(200).json({
      collectionId,
      collectionStatus: collection.status,
      totalRaised: balances.netPayment,
      totalBalance,
      availableBalance,
      pendingBalance,
      pendingWithdrawalRequests,
      // `withdrawn` is what the FE renders in the "Withdrawn" stat
      // tile on the collection page. Keep `successfulWithdrawals`
      // and `approvedWithdrawals` broken out separately for any
      // future admin/reporting views.
      withdrawn: totalWithdrawn,
      successfulWithdrawals: roundCurrency(
        withdrawalRows
          .filter((row) =>
            ["success", "successful", "completed"].includes(
              String(row.status || "").toLowerCase(),
            ),
          )
          .reduce((sum, row) => sum + Number(row.amount || 0), 0),
      ),
      approvedWithdrawals: roundCurrency(
        withdrawalRows
          .filter(
            (row) => String(row.status || "").toLowerCase() === "approved",
          )
          .reduce((sum, row) => sum + Number(row.amount || 0), 0),
      ),
      paidContributionsCount,
      cutoffUtc: cutoffUtc.toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Failed to compute collection dashboard stats",
    });
  }
};
// Maps a withdrawal row's `status` column to the activity `type` the FE
// renderer (components/dashboard/ActivityOverview.tsx#getActivityMeta)
// already handles. Keep the strings in sync with that file.
function withdrawalStatusToActivityType(status) {
  const s = String(status || "").toLowerCase();
  if (
    s === "approved" ||
    s === "success" ||
    s === "successful" ||
    s === "completed"
  ) {
    return "withdrawal_approved";
  }
  if (
    s === "rejected" ||
    s === "declined" ||
    s === "failed" ||
    s === "reversed"
  ) {
    return "withdrawal_rejected";
  }
  if (s === "processing") return "withdrawal_pending";
  // Default: "pending" or anything else newly-created.
  return "withdrawal_requested";
}

export const collectionActivities = async (req, res) => {
  const user_id = req.user.id;

  try {
    const { data: collections, error: collectionsError } = await supabase
      .from("collections")
      .select("id, title")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (collectionsError) throw collectionsError;

    const collectionIds = (collections || []).map(
      (collection) => collection.id,
    );
    if (collectionIds.length === 0) {
      return res.status(200).json({
        message: "User activities fetched successfully",
        data: [],
      });
    }

    // Two parallel reads: contributions and withdrawals. Both are
    // surfaced as activity rows the FE knows how to render via a
    // unified `type` field. Withdrawals were previously omitted, so
    // the wallet category never showed pending/approved/rejected
    // withdrawals to the organizer.
    const [contribRes, withdrawalRes] = await Promise.all([
      supabase
        .from("contributions")
        .select(
          "id, name, email, amount, gross_amount, created_at, collection_id",
        )
        .in("collection_id", collectionIds)
        .eq("status", "paid")
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("withdrawals")
        .select(
          "id, collection_id, amount, status, created_at, updated_at, destination_account",
        )
        .in("collection_id", collectionIds)
        .order("updated_at", { ascending: false })
        .limit(100),
    ]);

    if (contribRes.error) throw contribRes.error;
    if (withdrawalRes.error) throw withdrawalRes.error;

    const titleByCollection = new Map(
      (collections || []).map((c) => [c.id, c.title]),
    );

    // Normalise contributions — preserve the existing shape exactly so
    // the FE renderer doesn't have to handle a third format.
    const contribActivities = (contribRes.data || []).map((c) => ({
      ...c,
      type: "contribution",
      // Add a category tag so the FE can offer "Wallet / Withdrawals"
      // vs "Contributions" filtering without re-parsing `type`.
      category: "contribution",
      collection_title: titleByCollection.get(c.collection_id) || null,
    }));

    // Normalise withdrawals into the same shape. Sort key is updated_at
    // so a freshly-approved withdrawal bubbles to the top of the feed.
    const withdrawalActivities = (withdrawalRes.data || []).map((w) => {
      const destination = w.destination_account || {};
      return {
        id: w.id,
        collection_id: w.collection_id,
        amount: Number(w.amount || 0),
        status: w.status,
        type: withdrawalStatusToActivityType(w.status),
        category: "wallet",
        created_at: w.updated_at || w.created_at,
        requested_at: w.created_at,
        collection_title: titleByCollection.get(w.collection_id) || null,
        bank_name: destination.bank_name || destination.bankName || null,
        account_number:
          destination.accountNumber || destination.account_number || null,
        account_name:
          destination.accountName || destination.account_name || null,
      };
    });

    // Merge and sort by the visible timestamp (created_at for
    // contributions, updated_at-as-created_at for withdrawals so
    // status changes float up).
    const merged = [...contribActivities, ...withdrawalActivities]
      .sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tb - ta;
      })
      .slice(0, 100);

    res.status(200).json({
      message: "User activities fetched successfully",
      data: merged,
    });
  } catch (err) {
    console.log(err);

    res.status(500).json({ error: err.message });
  }
};
