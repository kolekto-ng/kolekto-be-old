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
        // Fast fundraising-approval sweep: admin approval flips status to
        // 'active' directly in the DB, so catch recently-activated fundraisers
        // within ~5 min instead of waiting for the hourly backstop below.
        // Idempotent (dedupe key fundraising-approved:<id>), windowed to the
        // last 2 hours to bound the work per run.
        notifyApprovedFundraisers({ sinceMs: 2 * 60 * 60 * 1000 }).catch((error) => {
            console.warn("[push-job] fast fundraising approval sweep failed:", error?.message || error);
        });
    },
    { timezone: "Africa/Lagos" }
);

cron.schedule(
    "17 * * * *",
    () => {
        // Both sweeps are time-windowed internally (deadlines/approvals from the
        // last ~1-2 days only) and the claim function refuses anything past its
        // 24h retry window, so this hourly run can never replay stale events.
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
