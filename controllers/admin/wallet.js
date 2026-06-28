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
