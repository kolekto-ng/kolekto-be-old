import webpush from "web-push";
import { supabase } from "./client.js";

const DEFAULT_FRONTEND_URL = "https://www.kolekto.com.ng";
const DEFAULT_ICON = "/kelekto_logo-removebg-preview.png";
const DEFAULT_BADGE = "/favicon.ico";

function getFrontendUrl() {
    return (process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL).replace(/\/+$/, "");
}

function getVapidConfig() {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    const rawSubject = (process.env.VAPID_SUBJECT || process.env.SUPPORT_EMAIL || "mailto:support@kolekto.com.ng").trim();
    const subject = rawSubject.includes(":") ? rawSubject : `mailto:${rawSubject}`;

    return { publicKey, privateKey, subject };
}

function configureWebPush() {
    const { publicKey, privateKey, subject } = getVapidConfig();
    if (!publicKey || !privateKey) return false;

    webpush.setVapidDetails(subject, publicKey, privateKey);
    return true;
}

function formatNaira(value) {
    const amount = Number(value || 0);
    return new Intl.NumberFormat("en-NG", {
        style: "currency",
        currency: "NGN",
        maximumFractionDigits: 0,
    }).format(amount);
}

function appUrl(path = "/dashboard") {
    if (/^https?:\/\//i.test(path)) return path;
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return `${getFrontendUrl()}${cleanPath}`;
}

function compactText(value, fallback = "") {
    return String(value || fallback).trim();
}

function buildPayload(payload) {
    return {
        title: payload.title || "Kolekto update",
        body: payload.body || "You have a new Kolekto update.",
        icon: payload.icon || DEFAULT_ICON,
        badge: payload.badge || DEFAULT_BADGE,
        type: payload.type || "info",
        tag: payload.tag || payload.type || "kolekto-update",
        id: payload.id || null,
        url: appUrl(payload.url || "/dashboard"),
        renotify: Boolean(payload.renotify),
    };
}

function isInvalidSubscriptionError(error) {
    const statusCode = error?.statusCode || error?.status;
    return statusCode === 404 || statusCode === 410;
}

async function claimNotificationEvent(userId, type, dedupeKey) {
    if (!dedupeKey) return true;

    const { error } = await supabase
        .from("push_notification_events")
        .insert([{ user_id: userId, event_type: type || "general", dedupe_key: dedupeKey }]);

    if (!error) return true;

    if (error.code === "23505") {
        return false;
    }

    console.warn("[push] dedupe insert failed:", error.message || error);
    return true;
}

export function isPushConfigured() {
    const { publicKey, privateKey } = getVapidConfig();
    return Boolean(publicKey && privateKey);
}

export function getVapidPublicKey() {
    return getVapidConfig().publicKey || null;
}

export async function savePushSubscription(userId, subscription, metadata = {}) {
    if (!userId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        throw new Error("Invalid push subscription");
    }

    const payload = {
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth_secret: subscription.keys.auth,
        expiration_time: subscription.expirationTime || null,
        user_agent: metadata.userAgent || null,
        platform: metadata.platform || null,
        device_label: metadata.deviceLabel || null,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
        .from("push_subscriptions")
        .upsert(payload, { onConflict: "endpoint" })
        .select("id, user_id, endpoint, created_at, updated_at")
        .single();

    if (error) throw error;
    return data;
}

export async function removePushSubscription(userId, endpoint) {
    if (!userId || !endpoint) return;

    const { error } = await supabase
        .from("push_subscriptions")
        .delete()
        .eq("user_id", userId)
        .eq("endpoint", endpoint);

    if (error) throw error;
}

export async function sendPushToUser(userId, payload, options = {}) {
    try {
        if (!userId || !configureWebPush()) return { sent: 0, skipped: true };

        const claimed = await claimNotificationEvent(userId, options.type || payload.type, options.dedupeKey);
        if (!claimed) return { sent: 0, duplicate: true };

        const { data: subscriptions, error } = await supabase
            .from("push_subscriptions")
            .select("id, endpoint, p256dh, auth_secret")
            .eq("user_id", userId);

        if (error) throw error;
        if (!subscriptions?.length) return { sent: 0 };

        const notification = buildPayload(payload);
        let sent = 0;

        await Promise.all(
            subscriptions.map(async (row) => {
                try {
                    await webpush.sendNotification(
                        {
                            endpoint: row.endpoint,
                            keys: {
                                p256dh: row.p256dh,
                                auth: row.auth_secret,
                            },
                        },
                        JSON.stringify(notification)
                    );
                    sent += 1;
                } catch (error) {
                    if (isInvalidSubscriptionError(error)) {
                        await supabase.from("push_subscriptions").delete().eq("id", row.id);
                        return;
                    }
                    console.warn("[push] send failed:", error?.message || error);
                }
            })
        );

        return { sent };
    } catch (error) {
        console.warn("[push] notification skipped:", error?.message || error);
        return { sent: 0, error };
    }
}

export async function notifyContributionPaid({ organizerId, collectionId, collectionTitle, contributorName, amount, reference }) {
    return sendPushToUser(
        organizerId,
        {
            title: "New contribution received",
            body: `${compactText(contributorName, "A contributor")} paid ${formatNaira(amount)} for ${compactText(collectionTitle, "your collection")}.`,
            type: "success",
            tag: `contribution-${reference || collectionId}`,
            id: reference || collectionId,
            url: `/dashboard/collections/${collectionId}`,
        },
        { type: "contribution_paid", dedupeKey: reference ? `contribution-paid:${reference}` : null }
    );
}

export async function notifyContributionByReference(reference) {
    try {
        if (!reference) return;

        const { data: contribution } = await supabase
            .from("contributions")
            .select("id, name, amount, gross_amount, collection_id, payment_reference")
            .eq("payment_reference", reference)
            .limit(1)
            .maybeSingle();

        if (!contribution?.collection_id) return;

        const { data: collection } = await supabase
            .from("collections")
            .select("id, title, user_id, target_amount, max_contributions, collection_type, amount")
            .eq("id", contribution.collection_id)
            .maybeSingle();

        if (!collection?.user_id) return;

        await notifyContributionPaid({
            organizerId: collection.user_id,
            collectionId: collection.id,
            collectionTitle: collection.title,
            contributorName: contribution.name,
            amount: contribution.gross_amount || contribution.amount,
            reference,
        });

        await notifyCollectionMilestones(collection.id, { reference });
    } catch (error) {
        console.warn("[push] contribution notification skipped:", error?.message || error);
    }
}

export async function notifyPaymentIssue({ userId, collectionId, collectionTitle, reference, status }) {
    return sendPushToUser(
        userId,
        {
            title: status === "abandoned" ? "Payment incomplete" : "Payment failed",
            body: `A payment for ${compactText(collectionTitle, "your collection")} was not completed.`,
            type: "warning",
            tag: `payment-${reference || collectionId}`,
            id: reference || collectionId,
            url: collectionId ? `/dashboard/collections/${collectionId}` : "/dashboard/activities",
        },
        { type: "payment_issue", dedupeKey: reference ? `payment-issue:${reference}:${status || "failed"}` : null }
    );
}

export async function notifyWithdrawalRequested({ userId, withdrawalId, amount }) {
    return sendPushToUser(
        userId,
        {
            title: "Withdrawal request sent",
            body: `We received your withdrawal request for ${formatNaira(amount)}.`,
            type: "info",
            tag: `withdrawal-request-${withdrawalId}`,
            id: withdrawalId,
            url: "/dashboard/wallet",
        },
        { type: "withdrawal_requested", dedupeKey: `withdrawal-requested:${withdrawalId}` }
    );
}

export async function notifyWithdrawalProcessed({ userId, withdrawalId, amount }) {
    return sendPushToUser(
        userId,
        {
            title: "Withdrawal processed",
            body: `Your ${formatNaira(amount)} withdrawal has been processed.`,
            type: "success",
            tag: `withdrawal-processed-${withdrawalId}`,
            id: withdrawalId,
            url: "/dashboard/wallet",
        },
        { type: "withdrawal_processed", dedupeKey: `withdrawal-processed:${withdrawalId}` }
    );
}

export async function notifyWithdrawalRejected({ userId, withdrawalId, amount }) {
    return sendPushToUser(
        userId,
        {
            title: "Withdrawal not approved",
            body: `Your ${formatNaira(amount)} withdrawal could not be processed.`,
            type: "error",
            tag: `withdrawal-rejected-${withdrawalId}`,
            id: withdrawalId,
            url: "/dashboard/wallet",
        },
        { type: "withdrawal_rejected", dedupeKey: `withdrawal-rejected:${withdrawalId}` }
    );
}

export async function notifyKycApproved({ userId, verificationType, kycId }) {
    const label = verificationType && verificationType !== "all" ? `${verificationType} verification` : "KYC";
    return sendPushToUser(
        userId,
        {
            title: "KYC approved",
            body: `Your ${label} has been approved.`,
            type: "success",
            tag: `kyc-approved-${kycId}-${verificationType || "all"}`,
            id: kycId,
            url: "/dashboard/profile",
        },
        { type: "kyc_approved", dedupeKey: `kyc-approved:${kycId}:${verificationType || "all"}` }
    );
}

export async function notifyKycRejected({ userId, verificationType, kycId }) {
    const label = verificationType && verificationType !== "all" ? `${verificationType} verification` : "KYC";
    return sendPushToUser(
        userId,
        {
            title: "KYC needs attention",
            body: `Your ${label} was not approved. Please review and try again.`,
            type: "warning",
            tag: `kyc-rejected-${kycId}-${verificationType || "all"}`,
            id: kycId,
            url: "/dashboard/profile",
        },
        { type: "kyc_rejected", dedupeKey: `kyc-rejected:${kycId}:${verificationType || "all"}` }
    );
}

export async function notifyKycReminder({ userId, dedupeKey }) {
    return sendPushToUser(
        userId,
        {
            title: "Complete your KYC",
            body: "Finish your verification to keep withdrawals smooth.",
            type: "info",
            tag: "kyc-reminder",
            id: userId,
            url: "/dashboard/profile",
        },
        { type: "kyc_reminder", dedupeKey }
    );
}

export async function notifyBankAccountAdded({ userId, bankName, repaired }) {
    return sendPushToUser(
        userId,
        {
            title: repaired ? "Bank account updated" : "Bank account added",
            body: `${compactText(bankName, "Your bank account")} is ready for withdrawals.`,
            type: "success",
            tag: `bank-account-${userId}`,
            id: userId,
            url: "/dashboard/profile",
        },
        { type: repaired ? "bank_account_updated" : "bank_account_added", dedupeKey: null }
    );
}

export async function notifyCollectionStatusChanged({ userId, collectionId, collectionTitle, status, collectionType }) {
    const normalized = String(status || "").toLowerCase();
    const titleByStatus = {
        active: collectionType === "fundraising" ? "Fundraising approved" : "Collection resumed",
        paused: "Collection paused",
        closed: "Collection closed",
        completed: "Collection closed",
    };

    const bodyByStatus = {
        active: collectionType === "fundraising"
            ? `${compactText(collectionTitle, "Your fundraising collection")} is now live.`
            : `${compactText(collectionTitle, "Your collection")} is now accepting payments again.`,
        paused: `${compactText(collectionTitle, "Your collection")} is paused for contributors.`,
        closed: `${compactText(collectionTitle, "Your collection")} has been closed.`,
        completed: `${compactText(collectionTitle, "Your collection")} has been closed.`,
    };

    const notificationTitle = titleByStatus[normalized];
    if (!notificationTitle) return;

    return sendPushToUser(
        userId,
        {
            title: notificationTitle,
            body: bodyByStatus[normalized],
            type: normalized === "active" ? "success" : "info",
            tag: `collection-status-${collectionId}-${normalized}`,
            id: collectionId,
            url: `/dashboard/collections/${collectionId}`,
        },
        { type: `collection_${normalized}`, dedupeKey: `collection-status:${collectionId}:${normalized}` }
    );
}

export async function notifyCollectionMilestones(collectionId, { reference } = {}) {
    try {
        const { data: collection } = await supabase
            .from("collections")
            .select("id, title, user_id, target_amount, max_contributions, collection_type")
            .eq("id", collectionId)
            .maybeSingle();

        if (!collection?.user_id) return;

        const { data: contributions, error } = await supabase
            .from("contributions")
            .select("amount")
            .eq("collection_id", collectionId)
            .eq("status", "paid");

        if (error) throw error;

        const paidCount = contributions?.length || 0;
        const raised = (contributions || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
        const target = Number(collection.target_amount || 0);
        const maxContributions = Number(collection.max_contributions || 0);

        if (target > 0 && raised >= target * 0.8) {
            await sendPushToUser(
                collection.user_id,
                {
                    title: raised >= target ? "Collection target reached" : "Collection is 80% funded",
                    body: `${compactText(collection.title, "Your collection")} has raised ${formatNaira(raised)}.`,
                    type: "success",
                    tag: `collection-target-${collection.id}`,
                    id: collection.id,
                    url: `/dashboard/collections/${collection.id}`,
                },
                {
                    type: raised >= target ? "collection_full" : "collection_80_percent",
                    dedupeKey: raised >= target
                        ? `collection-target-full:${collection.id}`
                        : `collection-target-80:${collection.id}`,
                }
            );
        }

        if (maxContributions > 0 && paidCount >= Math.ceil(maxContributions * 0.8) && paidCount < maxContributions) {
            await sendPushToUser(
                collection.user_id,
                {
                    title: "Collection is almost full",
                    body: `${compactText(collection.title, "Your collection")} has reached ${paidCount} of ${maxContributions} contributions.`,
                    type: "info",
                    tag: `collection-limit-80-${collection.id}`,
                    id: collection.id,
                    url: `/dashboard/collections/${collection.id}`,
                },
                {
                    type: "collection_limit_80_percent",
                    dedupeKey: `collection-limit-80:${collection.id}`,
                }
            );
        }

        if (maxContributions > 0 && paidCount >= maxContributions) {
            await sendPushToUser(
                collection.user_id,
                {
                    title: "Collection is full",
                    body: `${compactText(collection.title, "Your collection")} has reached its contribution limit.`,
                    type: "success",
                    tag: `collection-full-${collection.id}`,
                    id: collection.id,
                    url: `/dashboard/collections/${collection.id}`,
                },
                { type: "collection_full", dedupeKey: `collection-full:${collection.id}` }
            );
        }
    } catch (error) {
        console.warn("[push] collection milestone skipped:", error?.message || error);
    }
}

export async function notifyDueCollections() {
    const now = new Date().toISOString();
    const { data: collections, error } = await supabase
        .from("collections")
        .select("id, title, user_id, deadline, status")
        .not("deadline", "is", null)
        .lte("deadline", now)
        .in("status", ["active", "paused"]);

    if (error) {
        console.warn("[push] due collection lookup failed:", error.message || error);
        return;
    }

    await Promise.all(
        (collections || []).map((collection) =>
            sendPushToUser(
                collection.user_id,
                {
                    title: "Collection deadline reached",
                    body: `${compactText(collection.title, "Your collection")} has reached its deadline.`,
                    type: "info",
                    tag: `collection-deadline-${collection.id}`,
                    id: collection.id,
                    url: `/dashboard/collections/${collection.id}`,
                },
                { type: "collection_deadline", dedupeKey: `collection-deadline:${collection.id}` }
            )
        )
    );
}

export async function notifyKycReminderBatch() {
    const today = new Date().toISOString().slice(0, 10);
    const { data: rows, error } = await supabase
        .from("kyc_verifications")
        .select("id, user_id, status")
        .neq("status", "verified")
        .limit(500);

    if (error) {
        console.warn("[push] KYC reminder lookup failed:", error.message || error);
        return;
    }

    await Promise.all(
        (rows || []).map((row) => notifyKycReminder({ userId: row.user_id, dedupeKey: `kyc-reminder:${row.user_id}:${today}` }))
    );
}
