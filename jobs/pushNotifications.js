import cron from "node-cron";
import {
    notifyApprovedFundraisers,
    notifyDueCollections,
    notifyKycReminderBatch,
    retryUndeliveredNotifications,
} from "../utils/pushNotifications.js";

cron.schedule(
    "*/5 * * * *",
    () => {
        retryUndeliveredNotifications().catch((error) => {
            console.warn("[push-job] failed-delivery retry failed:", error?.message || error);
        });
    },
    { timezone: "Africa/Lagos" }
);

cron.schedule(
    "17 * * * *",
    () => {
        notifyDueCollections().catch((error) => {
            console.warn("[push-job] collection deadline check failed:", error?.message || error);
        });
        notifyApprovedFundraisers().catch((error) => {
            console.warn("[push-job] fundraising approval check failed:", error?.message || error);
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
