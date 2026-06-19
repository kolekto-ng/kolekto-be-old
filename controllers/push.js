import {
    getVapidPublicKey,
    isPushConfigured,
    removePushSubscription,
    savePushSubscription,
} from "../utils/pushNotifications.js";

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
