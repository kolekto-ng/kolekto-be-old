import webpush from "web-push";
import { randomUUID } from "node:crypto";
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
        collectionId: payload.collectionId || null,
        contributionId: payload.contributionId || null,
        transactionReference: payload.transactionReference || null,
        url: appUrl(payload.url || "/dashboard"),
        renotify: Boolean(payload.renotify),
    };
}

function isInvalidSubscriptionError(error) {
    const statusCode = error?.statusCode || error?.status;
    return statusCode === 404 || statusCode === 410;
}

async function claimNotificationEvent(userId, type, dedupeKey, payload) {
    if (!dedupeKey) return { shouldSend: true, eventId: null };
    const { data, error } = await supabase.rpc("claim_push_notification_event", {
        p_user_id: userId,
        p_event_type: type || "general",
        p_dedupe_key: dedupeKey,
        p_payload: payload || {},
    });
    if (!error) {
        const claim = Array.isArray(data) ? data[0] : data;
        return {
            shouldSend: Boolean(claim?.should_send),
            duplicate: Boolean(claim?.is_duplicate),
            eventId: claim?.event_id || null,
        };
    }

    console.warn("[push] atomic claim unavailable; using legacy dedupe:", error.message || error);
    const { data: inserted, error: insertError } = await supabase
        .from("push_notification_events")
        .insert([{ user_id: userId, event_type: type || "general", dedupe_key: dedupeKey }])
        .select("id")
        .maybeSingle();
    if (!insertError) return { shouldSend: true, eventId: inserted?.id || null };
    if (insertError.code === "23505") return { shouldSend: false, duplicate: true, eventId: null };

    console.warn("[push] delivery log write failed; sending without dedupe:", insertError.message || insertError);
    return { shouldSend: true, eventId: null };
}

function resolveNotificationEntity(eventType, notification) {
    if (notification.collectionId) return { entityType: "collection", entityId: String(notification.collectionId) };
    if (notification.contributionId) return { entityType: "contribution", entityId: String(notification.contributionId) };
    const type = String(eventType || "");
    if (type.startsWith("withdrawal")) return { entityType: "withdrawal", entityId: notification.id ? String(notification.id) : null };
    if (type.startsWith("kyc")) return { entityType: "kyc", entityId: notification.id ? String(notification.id) : null };
    if (type.startsWith("collection") || type.startsWith("fundraising")) {
        return { entityType: "collection", entityId: notification.id ? String(notification.id) : null };
    }
    return { entityType: null, entityId: notification.id ? String(notification.id) : null };
}

// Durable in-app notification record. Mirrors every push so users have an
// in-app feed even when the browser push was undeliverable. Idempotent on
// (user_id, type, dedupe_key): the natural key falls back to the push tag,
// then a random UUID, so webhook/retry/double-click replays never duplicate
// a row. Best-effort — a missing table or write error never blocks the push.
async function recordInAppNotification(userId, eventType, dedupeKey, notification) {
    if (!userId) return;
    try {
        const naturalKey = dedupeKey || notification.tag || randomUUID();
        const { entityType, entityId } = resolveNotificationEntity(eventType, notification);
        const { error } = await supabase
            .from("notifications")
            .upsert(
                {
                    user_id: userId,
                    type: eventType || "general",
                    title: notification.title || "Kolekto update",
                    body: notification.body || "",
                    url: notification.url || null,
                    entity_type: entityType,
                    entity_id: entityId,
                    data: notification,
                    dedupe_key: naturalKey,
                },
                { onConflict: "user_id,type,dedupe_key", ignoreDuplicates: true }
            );
        if (error) {
            console.warn("[push] in-app notification write skipped:", error.message || error);
        }
    } catch (error) {
        console.warn("[push] in-app notification write threw:", error?.message || error);
    }
}

async function recordNotificationResult(eventId, result) {
    if (!eventId) return;
    const { error } = await supabase
        .from("push_notification_events")
        .update({
            status: result.status,
            subscription_count: result.subscriptionCount || 0,
            sent_count: result.sent || 0,
            failed_count: result.failed || 0,
            removed_count: result.removed || 0,
            last_error: result.error ? String(result.error).slice(0, 1000) : null,
            sent_at: result.sent > 0 ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
        })
        .eq("id", eventId);
    if (error) console.warn("[push] delivery log update failed:", error.message || error);
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
    // Retry ONLY genuinely-failed deliveries (transient push-provider errors)
    // from the last 15 minutes — i.e. an event that failed against a device the
    // user already had moments ago. We deliberately do NOT replay
    // 'no_subscriptions' events here: those happened when the user had no device
    // and are terminal. Resurrecting them on enable is what produced the flood
    // of long-ago approvals/deadlines. The in-app rows already exist either way.
    void retryUndeliveredNotifications({
        userId,
        statuses: ["failed"],
        olderThanMs: 0,
        maxAgeMs: 15 * 60 * 1000,
        limit: 10,
    }).catch((retryError) => {
        console.warn("[push] subscription retry sweep failed:", retryError?.message || retryError);
    });
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
    const eventType = options.type || payload.type || "general";
    const dedupeKey = options.dedupeKey
        || (payload.id ? `${eventType}:${payload.id}` : null);
    const notification = buildPayload(payload);
    let eventId = null;

    try {
        console.log("[push] event detected", { userId, eventType, dedupeKey });
        if (!userId) {
            console.warn("[push] target user not found", { eventType, dedupeKey });
            return { sent: 0, skipped: true };
        }
        console.log("[push] target user found", { userId, eventType, dedupeKey });

        const claim = await claimNotificationEvent(userId, eventType, dedupeKey, notification);
        eventId = claim.eventId;
        if (!claim.shouldSend) {
            console.log("[push] duplicate suppressed", { userId, eventType, dedupeKey });
            return { sent: 0, duplicate: true };
        }

        // Persist the in-app notification first, so the user has a durable
        // record regardless of whether the browser push below succeeds (no
        // VAPID config, no subscription, expired endpoint, etc.). Idempotent.
        await recordInAppNotification(userId, eventType, dedupeKey, notification);

        if (!configureWebPush()) {
            await recordNotificationResult(eventId, {
                status: "failed",
                error: "VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY is missing",
            });
            console.warn("[push] failed: VAPID is not configured", { userId, eventType, dedupeKey });
            return { sent: 0, skipped: true };
        }

        const { data: subscriptions, error } = await supabase
            .from("push_subscriptions")
            .select("id, endpoint, p256dh, auth_secret")
            .eq("user_id", userId);

        if (error) throw error;
        if (!subscriptions?.length) {
            await recordNotificationResult(eventId, { status: "no_subscriptions" });
            console.log("[push] no subscription found", { userId, eventType, dedupeKey });
            return { sent: 0 };
        }
        console.log("[push] subscriptions found", { userId, eventType, dedupeKey, subscriptions: subscriptions.length });
        let sent = 0;
        let removed = 0;
        let failed = 0;

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
                        removed += 1;
                        console.log("[push] removed expired subscription", { userId, subscriptionId: row.id });
                        return;
                    }
                    failed += 1;
                    console.warn("[push] notification failed", {
                        userId,
                        eventType,
                        subscriptionId: row.id,
                        statusCode: error?.statusCode || error?.status || null,
                        error: error?.message || error,
                    });
                }
            })
        );

        const status = sent > 0
            ? "sent"
            : removed === subscriptions.length
                ? "no_subscriptions"
                : "failed";
        await recordNotificationResult(eventId, {
            status,
            subscriptionCount: subscriptions.length,
            sent,
            failed,
            removed,
            error: failed > 0 ? `${failed} subscription delivery attempt(s) failed` : null,
        });

        console.log(sent > 0 ? "[push] notification sent successfully" : "[push] notification failed", {
            userId,
            eventType,
            dedupeKey,
            subscriptions: subscriptions.length,
            sent,
            failed,
            removed,
        });

        return { sent, failed, removed, eventId };
    } catch (error) {
        await recordNotificationResult(eventId, {
            status: "failed",
            error: error?.message || error,
        }).catch(() => undefined);
        console.warn("[push] notification skipped:", {
            userId,
            eventType,
            dedupeKey,
            error: error?.message || error,
        });
        return { sent: 0, error };
    }
}

// Diagnostic-only send. Unlike sendPushToUser it does NOT claim/dedupe and does
// NOT write an in-app notification or a delivery-log row — so it can be run
// repeatedly to answer one question: "can the backend deliver a push to THIS
// user's stored subscriptions right now?" Returns per-subscription outcomes
// (with provider status codes and reasons) and never throws. No secrets are
// returned. Invalid (404/410) endpoints are cleaned up exactly as the real
// sender would, so a test run also self-heals dead subscriptions.
export async function sendTestPushToUser(userId) {
    const result = {
        vapidConfigured: isPushConfigured(),
        subscriptionCount: 0,
        attempted: 0,
        sent: 0,
        failed: 0,
        removed: 0,
        failures: [],
    };

    if (!userId) {
        result.error = "No authenticated user";
        return result;
    }

    if (!configureWebPush()) {
        result.error = "VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY is missing";
        return result;
    }

    const { data: subscriptions, error } = await supabase
        .from("push_subscriptions")
        .select("id, endpoint, p256dh, auth_secret")
        .eq("user_id", userId);

    if (error) {
        result.error = error.message || String(error);
        return result;
    }

    result.subscriptionCount = subscriptions?.length || 0;
    if (!subscriptions?.length) return result;

    const notification = buildPayload({
        title: "Kolekto test notification",
        body: "If you can read this, push delivery is working on this device.",
        type: "info",
        tag: `push-test-${Date.now()}`,
        renotify: true,
        url: "/dashboard",
    });

    await Promise.all(
        subscriptions.map(async (row) => {
            result.attempted += 1;
            try {
                await webpush.sendNotification(
                    {
                        endpoint: row.endpoint,
                        keys: { p256dh: row.p256dh, auth: row.auth_secret },
                    },
                    JSON.stringify(notification)
                );
                result.sent += 1;
            } catch (sendError) {
                const statusCode = sendError?.statusCode || sendError?.status || null;
                if (isInvalidSubscriptionError(sendError)) {
                    await supabase.from("push_subscriptions").delete().eq("id", row.id);
                    result.removed += 1;
                    result.failures.push({
                        subscriptionId: row.id,
                        statusCode,
                        reason: "expired-subscription-removed",
                    });
                    return;
                }
                result.failed += 1;
                result.failures.push({
                    subscriptionId: row.id,
                    statusCode,
                    // web-push surfaces the provider's own message here; it never
                    // contains our VAPID private key.
                    reason: sendError?.body || sendError?.message || "unknown-error",
                });
            }
        })
    );

    return result;
}

// Retries ONLY transient 'failed' deliveries. 'no_subscriptions' is terminal
// and is never swept here (resurrecting it = the stale-notification flood).
// `maxAgeMs` bounds how old (by created_at) an event may be to still qualify;
// it must stay within the claim function's 24h retry window — anything older is
// permanently abandoned by the claim guard anyway, so we never even select it.
export async function retryUndeliveredNotifications({
    userId = null,
    statuses = ["failed"],
    olderThanMs = 60_000,
    maxAgeMs = 24 * 60 * 60 * 1000,
    limit = 100,
} = {}) {
    // Defensive: 'no_subscriptions' (and any non-'failed' status) is terminal —
    // the claim function will refuse it, so never select it for a retry.
    const retryStatuses = statuses.filter((status) => status === "failed");
    if (retryStatuses.length === 0) return 0;

    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const recent = new Date(Date.now() - maxAgeMs).toISOString();
    let query = supabase
        .from("push_notification_events")
        .select("user_id, event_type, dedupe_key, payload")
        .in("status", retryStatuses)
        .lt("last_attempt_at", cutoff)
        .gte("created_at", recent)
        .order("last_attempt_at", { ascending: true })
        .limit(limit);
    if (userId) query = query.eq("user_id", userId);

    const { data: events, error } = await query;
    if (error) throw error;
    await Promise.all((events || []).map((event) =>
        sendPushToUser(event.user_id, event.payload || {}, {
            type: event.event_type,
            dedupeKey: event.dedupe_key,
        })
    ));
    return events?.length || 0;
}

export async function notifyContributionPaid({ organizerId, collectionId, contributionId, collectionTitle, contributorName, amount, reference }) {
    return sendPushToUser(
        organizerId,
        {
            title: "New contribution received",
            body: `${compactText(contributorName, "A contributor")} paid ${formatNaira(amount)} for ${compactText(collectionTitle, "your collection")}.`,
            type: "contribution_paid",
            tag: `contribution-${reference || collectionId}`,
            id: contributionId || reference || collectionId,
            collectionId,
            contributionId: contributionId || null,
            transactionReference: reference || null,
            url: `/collections/${collectionId}`,
        },
        { type: "contribution_paid", dedupeKey: reference ? `contribution-paid:${reference}` : null }
    );
}

// Contributor-side "Payment successful" push. ONLY fires when the payer's
// email uniquely matches a real account (profiles row → auth user). Anonymous
// payers get an email receipt, never a faked push. Idempotent per reference.
async function notifyContributorPaidByEmail({ email, collectionId, collectionTitle, contributionId, amount, reference }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail) return { sent: 0, skipped: true };

    const { data: profiles, error } = await supabase
        .from("profiles")
        .select("id")
        .ilike("email", normalizedEmail)
        .limit(2);

    // Require exactly one match — never push to an ambiguous/aliased account.
    if (error || !profiles || profiles.length !== 1) return { sent: 0, skipped: true };
    const contributorUserId = profiles[0].id;

    return sendPushToUser(
        contributorUserId,
        {
            title: "Payment successful",
            body: `Your payment of ${formatNaira(amount)} for ${compactText(collectionTitle, "a collection")} was received.`,
            type: "payment_successful",
            tag: `contributor-paid-${reference || collectionId}`,
            id: contributionId || reference || collectionId,
            collectionId,
            contributionId: contributionId || null,
            transactionReference: reference || null,
            url: "/dashboard/activities",
        },
        { type: "payment_successful", dedupeKey: reference ? `contributor-paid:${reference}` : null }
    );
}

export async function notifyContributionByReference(reference) {
    try {
        if (!reference) return;

        const { data: contributions } = await supabase
            .from("contributions")
            .select("id, name, email, amount, gross_amount, collection_id, payment_reference")
            .eq("payment_reference", reference)
            .order("created_at", { ascending: true });

        const contribution = contributions?.[0];

        if (!contribution?.collection_id) return;

        const { data: collection } = await supabase
            .from("collections")
            .select("id, title, user_id, target_amount, max_contributions, collection_type, amount")
            .eq("id", contribution.collection_id)
            .maybeSingle();

        if (!collection?.user_id) return;

        const totalAmount = (contributions || []).reduce(
            (sum, row) => sum + Number(row.gross_amount || row.amount || 0),
            0
        );

        const result = await notifyContributionPaid({
            organizerId: collection.user_id,
            collectionId: collection.id,
            contributionId: contribution.id,
            collectionTitle: collection.title,
            contributorName: contribution.name,
            amount: totalAmount || contribution.gross_amount || contribution.amount,
            reference,
        });

        // Contributor push — best-effort, only if their email links to a real
        // account. Never blocks the organizer notification above.
        await notifyContributorPaidByEmail({
            email: contribution.email,
            collectionId: collection.id,
            collectionTitle: collection.title,
            contributionId: contribution.id,
            amount: totalAmount || contribution.gross_amount || contribution.amount,
            reference,
        }).catch((error) => {
            console.warn("[push] contributor notification skipped:", error?.message || error);
        });

        await notifyCollectionMilestones(collection.id, { reference });
        return result;
    } catch (error) {
        console.warn("[push] contribution notification skipped:", error?.message || error);
        return { sent: 0, error };
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

export async function notifyWithdrawalApproved({ userId, withdrawalId, amount }) {
    return sendPushToUser(
        userId,
        {
            title: "Withdrawal approved",
            body: `Your ${formatNaira(amount)} withdrawal has been approved for processing.`,
            type: "success",
            tag: `withdrawal-approved-${withdrawalId}`,
            id: withdrawalId,
            url: "/dashboard/wallet",
        },
        { type: "withdrawal_approved", dedupeKey: `withdrawal-approved:${withdrawalId}` }
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

export async function notifyWithdrawalFailed({ userId, withdrawalId, amount, status = "failed" }) {
    return sendPushToUser(
        userId,
        {
            title: "Withdrawal failed",
            body: `Your ${formatNaira(amount)} withdrawal could not be completed.`,
            type: "error",
            tag: `withdrawal-failed-${withdrawalId}`,
            id: withdrawalId,
            url: "/dashboard/wallet",
        },
        { type: "withdrawal_failed", dedupeKey: `withdrawal-failed:${withdrawalId}:${status}` }
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
        {
            type: repaired ? "bank_account_updated" : "bank_account_added",
            dedupeKey: `bank-account:${userId}:${repaired ? "updated" : "added"}`,
        }
    );
}

export async function notifyCollectionStatusChanged({ userId, collectionId, collectionTitle, status, collectionType, transitionAt }) {
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

    const isFundraisingApproval = normalized === "active" && collectionType === "fundraising";

    // Fundraising approval is a once-ever event → key on the collection id alone.
    // All other status changes are REPEATABLE (pause → reopen → pause again), so
    // the key must include the specific transition instant; otherwise the second
    // "paused" would collide with the first and be silently deduped. `transitionAt`
    // is the collection's updated_at at the moment of this transition — a webhook
    // retry or double-processing of the SAME transition shares it (deduped),
    // while a genuinely new transition gets a fresh key (notified once).
    const transitionStamp = transitionAt ? new Date(transitionAt).getTime() : "";
    const dedupeKey = isFundraisingApproval
        ? `fundraising-approved:${collectionId}`
        : `collection-status:${collectionId}:${normalized}:${transitionStamp}`;

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
        {
            type: isFundraisingApproval ? "fundraising_approved" : `collection_${normalized}`,
            dedupeKey,
        }
    );
}

// Admin fundraising approval happens by setting collections.status = 'active'
// directly (no backend endpoint owns that transition), so this sweep is the
// trigger for the approval push. It is idempotent — the dedupe key
// `fundraising-approved:<id>` guarantees a single notification.
//
// CRITICAL: this sweep is ALWAYS windowed by `updated_at`. The old "unfiltered
// hourly backstop" re-enumerated EVERY active fundraiser on every run; combined
// with the previous claim logic that resurrected non-'sent' events, that
// re-sent ancient approvals indefinitely. We now only ever look at fundraisers
// activated within `sinceMs` (default 26h, slight overlap on the hourly run),
// and the claim function's 24h window is the hard backstop that prevents any
// stale resend even if an old row's `updated_at` is bumped by an edit.
export async function notifyApprovedFundraisers({ sinceMs = 26 * 60 * 60 * 1000 } = {}) {
    const windowMs = sinceMs || 26 * 60 * 60 * 1000;
    const query = supabase
        .from("collections")
        .select("id, title, user_id, status, collection_type, updated_at")
        .eq("collection_type", "fundraising")
        .eq("status", "active")
        .gte("updated_at", new Date(Date.now() - windowMs).toISOString())
        .limit(500);

    const { data: collections, error } = await query;

    if (error) throw error;
    await Promise.all((collections || []).map((collection) =>
        notifyCollectionStatusChanged({
            userId: collection.user_id,
            collectionId: collection.id,
            collectionTitle: collection.title,
            status: collection.status,
            collectionType: collection.collection_type,
        })
    ));
}

function getTierCapacityStats(priceTiers = [], contributions = []) {
    if (!Array.isArray(priceTiers) || priceTiers.length === 0) return null;
    const soldByTier = new Map();
    for (const contribution of contributions) {
        const infoRows = Array.isArray(contribution.contributor_information)
            ? contribution.contributor_information
            : [];
        for (const info of infoRows) {
            const key = String(info?.TierId || info?.Tier || "");
            if (key) soldByTier.set(key, (soldByTier.get(key) || 0) + Number(info?.Quantity || 1));
        }
    }

    let totalCapacity = 0;
    let totalSold = 0;
    let allTiersFinite = true;
    let allTiersFull = true;
    for (const tier of priceTiers) {
        const capacity = Number(tier?.quantity);
        if (!Number.isFinite(capacity) || capacity <= 0) {
            allTiersFinite = false;
            allTiersFull = false;
            continue;
        }
        const key = String(tier?.id || tier?.name || "");
        const sold = Number(tier?.sold_quantity ?? soldByTier.get(key) ?? 0);
        totalCapacity += capacity;
        totalSold += Math.min(capacity, sold);
        if (sold < capacity) allTiersFull = false;
    }

    return {
        totalCapacity,
        totalSold,
        full: allTiersFinite && allTiersFull && totalCapacity > 0,
    };
}

export async function notifyCollectionMilestones(collectionId, { reference } = {}) {
    try {
        const { data: collection } = await supabase
            .from("collections")
            .select("id, title, user_id, target_amount, max_contributions, collection_type, price_tiers")
            .eq("id", collectionId)
            .maybeSingle();

        if (!collection?.user_id) return;

        const { data: contributions, error } = await supabase
            .from("contributions")
            .select("amount, contributor_information")
            .eq("collection_id", collectionId)
            .eq("status", "paid");

        if (error) throw error;

        const paidCount = contributions?.length || 0;
        const raised = (contributions || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
        const target = Number(collection.target_amount || 0);
        const maxContributions = Number(collection.max_contributions || 0);
        const tierStats = getTierCapacityStats(collection.price_tiers, contributions || []);
        const fullByTarget = target > 0 && raised >= target;
        const fullByLimit = maxContributions > 0 && paidCount >= maxContributions;
        const fullByTiers = Boolean(tierStats?.full);

        if (target > 0 && raised >= target * 0.8 && raised < target) {
            await sendPushToUser(
                collection.user_id,
                {
                    title: "Collection is 80% funded",
                    body: `${compactText(collection.title, "Your collection")} has raised ${formatNaira(raised)}.`,
                    type: "success",
                    tag: `collection-target-${collection.id}`,
                    id: collection.id,
                    url: `/collections/${collection.id}`,
                },
                {
                    type: "collection_80_percent",
                    dedupeKey: `collection-target-80:${collection.id}`,
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

        if (tierStats?.totalCapacity > 0 && tierStats.totalSold >= Math.ceil(tierStats.totalCapacity * 0.8) && !tierStats.full) {
            await sendPushToUser(
                collection.user_id,
                {
                    title: "Collection is almost full",
                    body: `${compactText(collection.title, "Your collection")} has sold ${tierStats.totalSold} of ${tierStats.totalCapacity} available spots.`,
                    type: "info",
                    tag: `collection-tier-80-${collection.id}`,
                    id: collection.id,
                    url: `/collections/${collection.id}`,
                },
                { type: "collection_limit_80_percent", dedupeKey: `collection-tier-80:${collection.id}` }
            );
        }

        if (fullByTarget || fullByLimit || fullByTiers) {
            await sendPushToUser(
                collection.user_id,
                {
                    title: "Collection is full",
                    body: `${compactText(collection.title, "Your collection")} is now full.`,
                    type: "success",
                    tag: `collection-full-${collection.id}`,
                    id: collection.id,
                    collectionId: collection.id,
                    url: `/collections/${collection.id}`,
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
    // Only deadlines that passed within the last 48h. Without this lower bound,
    // every run re-enumerated EVERY collection whose deadline ever passed and
    // that stayed active/paused (e.g. auto_close off) — re-sending ancient
    // "deadline reached" pushes forever. The claim function's 24h window is the
    // hard backstop; this just keeps the sweep cheap and focused on fresh ones.
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: collections, error } = await supabase
        .from("collections")
        .select("id, title, user_id, deadline, status, collection_type, auto_close")
        .not("deadline", "is", null)
        .lte("deadline", now)
        .gte("deadline", since)
        .in("status", ["active", "paused"]);

    if (error) {
        console.warn("[push] due collection lookup failed:", error.message || error);
        return;
    }

    await Promise.all(
        (collections || []).map(async (collection) => {
            await sendPushToUser(
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
            );

            if (collection.auto_close) {
                const closedAt = new Date().toISOString();
                const { data: closed, error: closeError } = await supabase
                    .from("collections")
                    .update({ status: "closed", updated_at: closedAt })
                    .eq("id", collection.id)
                    .in("status", ["active", "paused"])
                    .select("id")
                    .maybeSingle();
                if (closeError) throw closeError;
                if (closed) {
                    await notifyCollectionStatusChanged({
                        userId: collection.user_id,
                        collectionId: collection.id,
                        collectionTitle: collection.title,
                        status: "closed",
                        collectionType: collection.collection_type,
                        transitionAt: closedAt,
                    });
                }
            }
        })
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
