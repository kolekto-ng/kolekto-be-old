import {
    getVapidPublicKey,
    isPushConfigured,
    removePushSubscription,
    savePushSubscription,
    sendTestPushToUser,
} from "../utils/pushNotifications.js";
import { supabase } from "../utils/client.js";

export const getPublicKey = async (req, res) => {
    const publicKey = getVapidPublicKey();
    if (!publicKey || !isPushConfigured()) {
        return res.status(503).json({
            error: "Push notifications are not configured.",
            configured: false,
        });
    }

    return res.status(200).json({ publicKey, configured: true });
};

export const saveSubscription = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { subscription, metadata } = req.body || {};

        if (!userId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const saved = await savePushSubscription(userId, subscription, metadata);
        return res.status(200).json({ success: true, subscription: saved });
    } catch (error) {
        console.error("Push subscription save error:", error?.message || error);
        return res.status(400).json({ error: "Could not save notification settings." });
    }
};

export const deleteSubscription = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { endpoint } = req.body || {};

        if (!userId) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        if (!endpoint) {
            return res.status(400).json({ error: "Subscription endpoint is required." });
        }

        await removePushSubscription(userId, endpoint);
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Push subscription delete error:", error?.message || error);
        return res.status(400).json({ error: "Could not update notification settings." });
    }
};

// Sends a real test push to the signed-in user's stored subscriptions and
// returns a clear delivery summary. This is the single tool that separates
// "push delivery is broken" (subscriptionCount 0, or failures with provider
// status codes) from "an event trigger is broken" (delivery works here but a
// payment/approval never reached sendPushToUser). Exposes no secrets.
export const sendTestPush = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await sendTestPushToUser(userId);
    return res.status(200).json(result);
};

// Safe self-diagnostics for the signed-in user. Exposes NO secrets — only the
// (already public) VAPID public key, presence flags for server env, this
// user's own subscription summaries, and recent delivery outcomes. Lets us see
// exactly where push is failing without reading the live DB or leaking keys.
export const getDiagnostics = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const diagnostics = {
        server: {
            vapidConfigured: isPushConfigured(),
            // The public key is safe to return (the frontend already fetches it
            // to subscribe). Compare it against the key the browser subscribed
            // with to catch VAPID rotation mismatches.
            vapidPublicKey: getVapidPublicKey() || null,
            paystackSecretPresent: Boolean(process.env.PAYSTACK_SECRET_KEY),
            frontendUrlConfigured: Boolean(process.env.FRONTEND_URL),
            // The webhook is mounted at this path in app.js; this is where the
            // Paystack dashboard webhook URL must point (no secret involved).
            expectedWebhookPath: "/api/payments/webhook",
        },
        subscriptions: [],
        recentEvents: [],
    };

    try {
        const { data: subs } = await supabase
            .from("push_subscriptions")
            .select("id, endpoint, device_label, platform, created_at, updated_at")
            .eq("user_id", userId)
            .order("updated_at", { ascending: false });

        diagnostics.subscriptions = (subs || []).map((s) => ({
            id: s.id,
            // Only the provider host + a short suffix — enough to tell two
            // devices apart, never the full pushable endpoint token.
            endpointHost: safeEndpointHost(s.endpoint),
            endpointTail: s.endpoint ? `…${String(s.endpoint).slice(-6)}` : null,
            deviceLabel: s.device_label || null,
            platform: s.platform || null,
            createdAt: s.created_at,
            updatedAt: s.updated_at,
        }));
        diagnostics.subscriptionCount = diagnostics.subscriptions.length;
    } catch (error) {
        diagnostics.subscriptionsError = error?.message || String(error);
    }

    try {
        const { data: events } = await supabase
            .from("push_notification_events")
            .select("event_type, dedupe_key, status, subscription_count, sent_count, failed_count, removed_count, last_error, created_at, sent_at")
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(10);
        diagnostics.recentEvents = events || [];
    } catch (error) {
        diagnostics.recentEventsError = error?.message || String(error);
    }

    return res.status(200).json(diagnostics);
};

function safeEndpointHost(endpoint) {
    try {
        return new URL(String(endpoint)).host;
    } catch {
        return null;
    }
}
