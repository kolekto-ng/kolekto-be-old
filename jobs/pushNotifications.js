import cron from "node-cron";
import { notifyDueCollections, notifyKycReminderBatch } from "../utils/pushNotifications.js";

cron.schedule(
    "17 * * * *",
    () => {
        notifyDueCollections().catch((error) => {
            console.warn("[push-job] collection deadline check failed:", error?.message || error);
        });
    },
    { timezone: "Africa/Lagos" }
);

cron.schedule(
    "35 9 * * *",
    () => {
        notifyKycReminderBatch().catch((error) => {
            console.warn("[push-job] KYC reminder check failed:", error?.message || error);
        });
    },
    { timezone: "Africa/Lagos" }
);
