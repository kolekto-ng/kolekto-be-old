// Admin "live wallet" endpoint.
//
// Root cause this addresses (Issue 3):
//   The admin panel (CollectionDetailPage.tsx) reads wallet.available_balance
//   and wallet.pending_balance straight off the cached `wallets` columns.
//   Those columns are only re-derived when a contribution/withdrawal mutates
//   the wallet (updateWalletStats) or when the settlement cron runs. The
//   pending↔available split is TIME-dependent (T+1 settlement at 5am WAT), so
//   once a settlement window passes with no wallet write, the cached split
//   goes stale: money that has actually settled still shows as "pending".
//
// Fix: an additive, READ-ONLY endpoint that recomputes the wallet snapshot on
// every request from the same source-of-truth the host dashboard uses
// (paid contributions + withdrawals → computeWalletBalances). It never writes
// to any table, never touches payment/webhook/contribution-insert logic, and
// reuses the canonical financial.js helpers verbatim — so it cannot change a
// balance, double-credit, or miss a credit. It only changes what the admin
// READS.
//
// Mirrors controllers/dashboard.js#getCollectionDashboardStats almost exactly,
// minus the host ownership check (admins may view any collection) and plus a
// `withdrawableBalance` field (available minus outstanding withdrawal requests)
// so the admin can see the same "what can actually be withdrawn right now"
// number the host sees.
//
// Auth: verifyToken + requireAdmin (enforced at the route layer).

import { supabase } from "../../utils/client.js";
import {
  roundCurrency,
  normalizeContributions,
  computeWalletBalances,
  getSettlementCutoff,
} from "../../utils/financial.js";

export const getCollectionWalletLive = async (req, res) => {
  const { id: collectionId } = req.params;

  try {
    if (!collectionId) {
      return res.status(400).json({ error: "Collection ID is required" });
    }

    const { data: collection, error: collectionError } = await supabase
      .from("collections")
      .select("id, status, fee_bearer, collection_type")
      .eq("id", collectionId)
      .single();

    if (collectionError || !collection) {
      return res.status(404).json({ error: "Collection not found" });
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

    // Same normalization + canonical balance computation as the host path.
    const normalized = normalizeContributions(
      contributionRows,
      collection.fee_bearer || "organizer",
      collection.collection_type || "fixed",
    );

    const balances = computeWalletBalances(normalized, withdrawalRows);

    // Outstanding (not-yet-completed) withdrawal requests reduce what is
    // actually withdrawable right now — identical rule to the host dashboard.
    const pendingWithdrawalRequests = roundCurrency(
      withdrawalRows
        .filter((row) =>
          ["pending", "processing"].includes(
            String(row.status || "").toLowerCase(),
          ),
        )
        .reduce((sum, row) => sum + Number(row.amount || 0), 0),
    );

    const withdrawableBalance = roundCurrency(
      Math.max(0, balances.availableBalance - pendingWithdrawalRequests),
    );

    return res.status(200).json({
      collectionId,
      collectionStatus: collection.status,
      // Live-recomputed snapshot — authoritative as of this request.
      totalRaised: balances.netPayment,
      grossPayment: balances.grossPayment,
      totalBalance: balances.ledgerBalance,
      ledgerBalance: balances.ledgerBalance,
      // available_balance = settled-and-not-yet-withdrawn (T+1 honoured live)
      availableBalance: balances.availableBalance,
      // pending_balance = received after the last 5am WAT cutoff
      pendingBalance: balances.pendingBalance,
      // what the host could withdraw this moment (available minus open requests)
      withdrawableBalance,
      pendingWithdrawalRequests,
      withdrawn: balances.completedWithdrawals,
      paidContributionsCount: normalized.length,
      cutoffUtc: getSettlementCutoff().toISOString(),
      // Flag so the admin UI can show "live" vs the cached `wallets` row.
      source: "live",
      computedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Failed to compute live wallet snapshot",
    });
  }
};

// Account-level live wallet snapshot for a user (admin view).
//
// Root cause this addresses:
//   Admin's UserDetailPage builds account totals by SUMMING the cached
//   `wallets` columns (ledger_balance/available_balance/pending_balance/
//   net_payment) across the user's collections. Those columns are only
//   re-derived when a contribution/withdrawal mutates a wallet — so legacy
//   withdrawals approved before the recompute-on-approval logic existed (and
//   collections that have had no activity since) still carry pre-withdrawal
//   balances. The cached sum therefore over-reports by roughly the amount
//   already withdrawn, diverging from the host dashboard.
//
// Fix: recompute the account total live from the SAME source of truth and the
// SAME pooled computeWalletBalances() call the host uses in
// controllers/dashboard.js#getDashboardStats — so admin and host always agree.
// Read-only; never writes; reuses canonical financial.js helpers verbatim.
//
// This intentionally mirrors getDashboardStats almost line-for-line, swapping
// `req.user.id` for the `:userId` route param (admins may view any user).
export const getUserWalletLive = async (req, res) => {
  const { userId } = req.params;

  try {
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    const { data: collections, error: collectionsError } = await supabase
      .from("collections")
      .select("id, status, fee_bearer, collection_type")
      .eq("user_id", userId);

    if (collectionsError) throw collectionsError;

    const rows = collections || [];
    const collectionIds = rows.map((c) => c.id);
    const totalCollections = rows.length;
    const activeCollections = rows.filter((c) => c.status === "active").length;

    if (collectionIds.length === 0) {
      return res.status(200).json({
        userId,
        totalCollections,
        activeCollections,
        totalBalance: 0,
        availableBalance: 0,
        pendingBalance: 0,
        totalRaised: 0,
        withdrawn: 0,
        pendingWithdrawalRequests: 0,
        cutoffUtc: getSettlementCutoff().toISOString(),
        source: "live",
        computedAt: new Date().toISOString(),
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

    // Normalize per collection (fee_bearer/type differ per collection), then
    // pool — identical to getDashboardStats so the numbers are bit-for-bit
    // the same as the host dashboard.
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

    return res.status(200).json({
      userId,
      totalCollections,
      activeCollections,
      totalBalance,
      availableBalance,
      pendingBalance: balances.pendingBalance,
      totalRaised: balances.netPayment,
      withdrawn: balances.completedWithdrawals,
      pendingWithdrawalRequests,
      cutoffUtc: getSettlementCutoff().toISOString(),
      source: "live",
      computedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Failed to compute live account wallet snapshot",
    });
  }
};
