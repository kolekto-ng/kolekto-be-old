import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth.js";
import collectorRouter from "./routes/collection.js";
import collectionTransferRouter from "./routes/collectionTransfer.js";
import collectionAccessRouter from "./routes/collectionAccess.js";
import dashboardRouter from "./routes/dashboard.js";
import paymentRouter from "./routes/payment.js";
import contributorRouter from "./routes/contribution.js";
import withdrawalRouter from "./routes/withdrawal.js";
import profileRouter from "./routes/settings/profile.js";
import kycRouter from "./routes/settings/kyc.js";
import securityRouter from "./routes/settings/security.js";
import landingPageRouter from "./routes/landingPage.js";
import adminRouter from "./routes/admin/kyc.js";
import adminPaymentsRouter from "./routes/admin/payments.js";
import adminPaymentMonitoringRouter from "./routes/admin/paymentMonitoring.js";
import pushRouter from "./routes/push.js";
import ambassadorRouter from "./routes/ambassador.js";
import adminAmbassadorsRouter from "./routes/admin/ambassadors.js";
import adminEmailCampaignsRouter from "./routes/admin/emailCampaigns.js";
import emailPublicRouter from "./routes/emailPublic.js";
import healthRouter from "./routes/health.js";
import helmet from "helmet";
import { verifyEmailConfig } from "./services/emailService.js";
import { verifyAmbassadorEmailConfig } from "./utils/ambassadorMailer.js";
import { verifyMarketingEmailConfig } from "./utils/marketingMailer.js";
import { getAccountEncryptionStatus } from "./utils/accountCrypto.js";
import "./jobs/paymentSettlement.js"; // registers T+1 settlement cron (5am WAT daily)
import "./jobs/pushNotifications.js"; // registers push notification reminder/deadline jobs
import "./jobs/emailCampaignQueue.js"; // registers email campaign send-queue worker (leader-gated)
import "./jobs/emailCampaignScheduler.js"; // registers scheduled-campaign promotion worker (leader-gated)
// Imported directly so we can mount the webhook route with a RAW body parser
// before the global JSON parser. See B-1 below.
import { handleWebhook } from "./controllers/deposit.js";
import { installProcessGuards } from "./utils/processGuards.js";
import requestContext from "./middleware/requestContext.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";
import { runStartupProbe } from "./utils/supabaseStartupProbe.js";
import { setDependencyStatus } from "./utils/readiness.js";

// Install process-level crash guards BEFORE anything else can throw. On Node 22
// an unhandled rejection would otherwise terminate the process by default —
// this turns that invisible full outage into a loud, correlated log line while
// keeping the API up. See utils/processGuards.js.
installProcessGuards();

// Router-import sanity check — fails loud and names the culprit instead of
// letting a bad import (wrong export name, circular dependency, etc.) surface
// as Express's generic "app.use() requires a middleware function but got
// undefined", which gives no clue which of the ~20 mounted routers is broken.
[
    ['authRouter', authRouter],
    ['collectorRouter', collectorRouter],
    ['collectionTransferRouter', collectionTransferRouter],
    ['collectionAccessRouter', collectionAccessRouter],
    ['dashboardRouter', dashboardRouter],
    ['paymentRouter', paymentRouter],
    ['contributorRouter', contributorRouter],
    ['withdrawalRouter', withdrawalRouter],
    ['profileRouter', profileRouter],
    ['kycRouter', kycRouter],
    ['securityRouter', securityRouter],
    ['landingPageRouter', landingPageRouter],
    ['adminRouter', adminRouter],
    ['adminPaymentsRouter', adminPaymentsRouter],
    ['adminPaymentMonitoringRouter', adminPaymentMonitoringRouter],
    ['pushRouter', pushRouter],
    ['ambassadorRouter', ambassadorRouter],
    ['adminAmbassadorsRouter', adminAmbassadorsRouter],
    ['adminEmailCampaignsRouter', adminEmailCampaignsRouter],
    ['emailPublicRouter', emailPublicRouter],
    ['healthRouter', healthRouter],
].forEach(([name, router]) => {
    if (typeof router !== 'function') {
        throw new Error(
            `[startup] Router "${name}" did not import correctly (got ${typeof router} instead of an Express router/function). ` +
            `This router would otherwise be silently missing or crash the process at mount time with no indication of which module is at fault.`
        );
    }
});

const app = express();
app.use(helmet());

app.use(
    cors({
        origin: [
            "https://www.kolekto.com.ng",
            "www.kolekto.com.ng",
            "http://localhost:3000",
            "http://localhost:8080",
            "http://localhost:8081",
            "http://localhost:5173",
            "http://localhost:5174",
            "https://staging-kolekto-fe.vercel.app",
            "https://kolekto-admin-control-panel.vercel.app",
            "https://kelekto-admin.vercel.app",
            "https://test.kolekto.com.ng",
            "test.kolekto.com.ng",
            "https://kolekto-fe.vercel.app",
            "https://kolekto-fe-old.vercel.app",
            "kolekto-fe.vercel.app",
            "https://kolekto.com.ng",
            "kolekto.com.ng",
            "https://ambassador.kolekto.com",
            "https://ambassador.kolekto.com.ng",
            "http://localhost:5175",
        ],
        credentials: true, // Allow credentials (cookies) to be sent
    })
);

// Assign a correlation id + per-request structured logging to EVERYTHING that
// follows (including the raw-body webhook mounted just below, ahead of the JSON
// parser). Provides req.id, req.log, the X-Request-Id response header, and a
// one-line-per-request access log with latency. See middleware/requestContext.js.
app.use(requestContext);



// ─────────────────────────────────────────────────────────────────────────────
// B-1: Paystack webhook MUST receive the raw request bytes for HMAC
// verification. Paystack signs the exact bytes of the body. If we let
// express.json() parse first, our HMAC verification ends up computing the
// hash over JSON.stringify(parsed) which has different whitespace / key
// order than the original — so signatures NEVER match.
//
// We mount this single endpoint with express.raw BEFORE the global JSON
// parser so handleWebhook gets req.body as a Buffer. handleWebhook is
// already written to handle both Buffer and parsed bodies, so it works in
// either order — but the raw path is the only one where signatures match.
//
// Note: this is registered ahead of the paymentRouter mount; the route inside
// routes/payment.js has been removed (was the same path).
// ─────────────────────────────────────────────────────────────────────────────
app.post(
    "/api/payments/webhook",
    // type is a function so it always matches regardless of charset qualifiers
    // (e.g. "application/json; charset=utf-8") that Paystack may include.
    // This route is webhook-only so accepting any Content-Type is safe.
    express.raw({ type: () => true, limit: "2mb" }),
    handleWebhook
);

app.use(express.json());
app.use(cookieParser());

// Liveness/readiness endpoints — unauthenticated, secret-free. Mounted early so
// they answer even while the rest of the app is degraded. /health/ready is 503
// until the startup probe confirms privileged Supabase access (see app.listen).
app.use(healthRouter);

app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Kolekto backend is running successfully"
    });
});

app.use("/api", contributorRouter);
app.use("/api/auth", authRouter);
app.use("/api", collectorRouter);
app.use("/api", collectionTransferRouter);
app.use("/api", collectionAccessRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/payments", paymentRouter);
app.use("/api/withdrawals", withdrawalRouter);
app.use("/api/settings/profile", profileRouter);
app.use("/api/settings/kyc", kycRouter);
app.use("/api/settings/security", securityRouter);
app.use("/api/push", pushRouter);
app.use("/api/ambassadors", ambassadorRouter);
app.use("/api/adminurlabdkole", adminRouter);
// Same admin prefix — Express composes multiple routers on the same mount.
// F5: admin reconcile-payment endpoint.
app.use("/api/adminurlabdkole", adminPaymentsRouter);
// Payment Monitoring & Recovery Center — dashboard data + retry/resolve/notes.
app.use("/api/adminurlabdkole", adminPaymentMonitoringRouter);
app.use("/api/adminurlabdkole", adminAmbassadorsRouter);
// Email Campaign & Communications Center — same admin prefix convention.
app.use("/api/adminurlabdkole", adminEmailCampaignsRouter);
// Public email endpoints (unsubscribe) — deliberately NOT under the admin
// prefix. Recipients click this link from inside an email; they have no
// admin session and shouldn't need the obscured admin path.
app.use("/api/email", emailPublicRouter);

// ── Tail middleware — MUST be after every router ─────────────────────────────
// notFound: any unmatched route → structured JSON 404 (was previously an
// unlogged Express default). errorHandler: the 4-arg net that catches every
// rejected async route handler (Express 5 forwards them here), logs it once
// with the request's correlation id + stack, and returns { error, requestId }.
app.use(notFound);
app.use(errorHandler);

const port = process.env.PORT || 5050;

app.set('trust proxy', true);

// Initialize email service
const initializeEmailService = async () => {
    const isReady = await verifyEmailConfig();
    if (isReady) {
        console.log('✅ Email service initialized successfully');
    } else {
        console.warn('⚠️ Email service not configured properly. Check your .env file.');
    }
};

// Initialize the dedicated Ambassador Mail Agent — fully independent of the
// main email service above. A failure here never affects (and is never
// affected by) the main transactional mailer.
const initializeAmbassadorEmailService = async () => {
    const isReady = await verifyAmbassadorEmailConfig();
    if (isReady) {
        console.log('✅ Ambassador email service initialized successfully');
    } else {
        console.warn('⚠️ Ambassador email service not configured properly. Check AMBASSADOR_SMTP_* env vars.');
    }
};

// Initialize the dedicated Marketing Mail Agent (Email Campaigns) — fully
// independent of both the main transactional mailer and the Ambassador
// mailer above. A failure here never affects (and is never affected by)
// either of those.
const initializeMarketingEmailService = async () => {
    const isReady = await verifyMarketingEmailConfig();
    if (isReady) {
        console.log('✅ Marketing email service initialized successfully');
    } else {
        console.warn('⚠️ Marketing email service not configured properly. Check MARKETING_SMTP_* env vars.');
    }
};

// Fail loudly in the LOGS (never in the user UI) if bank-account encryption is
// misconfigured. Bank add + withdrawal both depend on ACCOUNT_ENCRYPTION_KEY;
// a missing/weak/reformatted key is the single most common cause of the
// "encryption error" users hit. This runs once at boot so ops can spot it
// immediately instead of via a failed user action.
const verifyAccountEncryptionConfig = () => {
    const status = getAccountEncryptionStatus();
    if (!status.configured) {
        console.error(
            "❌ ACCOUNT_ENCRYPTION_KEY is NOT set. Bank account setup and " +
            "withdrawals will fail. Set it in the environment before serving traffic."
        );
        return;
    }
    if (status.hadSurroundingWhitespaceOrQuotes) {
        console.warn(
            "⚠️ ACCOUNT_ENCRYPTION_KEY had surrounding quotes/whitespace; it has " +
            "been sanitised at runtime. Older ciphertext is still recovered via " +
            "fallback key. s, but consider cleaning the env var so the raw value matches."
        );
    }
    if (status.weak) {
        console.warn(
            "⚠️ ACCOUNT_ENCRYPTION_KEY is shorter than 16 characters. It still " +
            "works (SHA-256 widens it) but a longer secret is strongly recommended."
        );
    }
    console.log("✅ Account encryption key configured");
};

// Environment cross-wiring guard.
//
// Root cause behind a real incident investigated 2026-06-30: a payment made
// against the TEST Supabase project produced an orphaned contribution
// because nothing in the chain (frontend callback, webhook) ever invoked
// verify-paystack-payment. While investigating, we also found this
// backend's local dev .env pointed SUPABASE_URL at TEST while the
// frontend's local dev .env pointed VITE_SUPABASE_URL at PROD — exactly the
// kind of mismatch that makes the webhook safety net (which can only ever
// call ONE Supabase project, whichever this process is configured for)
// structurally unable to recover a payment that happened against the other
// project. This can't be fully prevented from inside a single Express
// process (it can't see the frontend's or edge functions' env), but it CAN
// make a mismatch between ITS OWN SUPABASE_URL and ITS OWN
// PAYSTACK_SECRET_KEY mode impossible to miss in the logs — that pairing
// (test project + live key, or prod project + test key) is the single most
// dangerous version of this mistake, since it means either real money moves
// against a throwaway database, or test traffic silently never reaches a
// real Paystack account.
//
// Non-fatal by default — exiting on a possibly-wrong heuristic in a live
// payment backend is itself a production risk. Set STRICT_ENV_CHECK=true
// once you've confirmed the detection is reliable for your deploy targets.
const KNOWN_PROJECT_ENVIRONMENTS = {
    busfgcmbndleljklrcbd: { name: "production", expectedPaystackMode: "sk_live_" },
    lpeeckqsltxohppheucz: { name: "test", expectedPaystackMode: "sk_test_" },
};

const verifyEnvironmentConsistency = () => {
    const supabaseUrl = process.env.SUPABASE_URL || "";
    const paystackKey = process.env.PAYSTACK_SECRET_KEY || "";
    const projectRef = (supabaseUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1] || null;
    const paystackMode = paystackKey.startsWith("sk_live_")
        ? "sk_live_"
        : paystackKey.startsWith("sk_test_")
            ? "sk_test_"
            : null;

    if (!projectRef || !paystackMode) {
        console.warn(
            "⚠️ ENV_CHECK: could not determine Supabase project ref or Paystack key mode " +
            "(SUPABASE_URL/PAYSTACK_SECRET_KEY missing or malformed) — skipping consistency check."
        );
        return;
    }

    const known = KNOWN_PROJECT_ENVIRONMENTS[projectRef];
    if (!known) {
        console.log(
            `[startup] ENV_CHECK projectRef=${projectRef} (not in KNOWN_PROJECT_ENVIRONMENTS — ` +
            `add it there once this is a recognised deploy target) paystackMode=${paystackMode}`
        );
        return;
    }

    console.log(`[startup] ENV_CHECK environment=${known.name} projectRef=${projectRef} paystackMode=${paystackMode}`);

    if (known.expectedPaystackMode !== paystackMode) {
        const message =
            `❌❌❌ ENVIRONMENT MISMATCH: SUPABASE_URL resolves to "${known.name}" ` +
            `(${projectRef}) but PAYSTACK_SECRET_KEY is a "${paystackMode}" key ` +
            `(expected "${known.expectedPaystackMode}" for ${known.name}). This is exactly the ` +
            `cross-wiring pattern that left a real payment unrecoverable on 2026-06-30 — the ` +
            `webhook recovery path can only ever target the Supabase project THIS process is ` +
            `configured for, so a mismatch here means payments against the other project can ` +
            `never be auto-recovered by this backend. Fix SUPABASE_URL or PAYSTACK_SECRET_KEY ` +
            `before serving real traffic.`;
        console.error(message);
        if (process.env.STRICT_ENV_CHECK === "true") {
            console.error("STRICT_ENV_CHECK=true — refusing to start.");
            process.exit(1);
        }
    }
};

app.listen(port, '0.0.0.0', async () => {
    console.log(`Server Running on port ${port}`);
    verifyEnvironmentConsistency();
    // TEMPORARY DEBUG (remove once the payout-account decryption issue is
    // confirmed fixed in production): confirms the process actually picked
    // up ACCOUNT_ENCRYPTION_KEY after a `pm2 restart` (PM2 does NOT reload
    // .env on a plain restart — `--update-env` is required, or the env was
    // baked into the PM2 process at an earlier, different value). Logs
    // presence + length only — never the key value itself.
    const keyRaw = process.env.ACCOUNT_ENCRYPTION_KEY;
    console.log("[startup] ACCOUNT_ENCRYPTION_KEY:", keyRaw ? `present (length=${keyRaw.length})` : "MISSING");
    verifyAccountEncryptionConfig();

    // ── Privileged-dependency readiness probe ────────────────────────────────
    // A valid service-role KEY STRING is not proof of ACCESS: a wrong project,
    // rotated grant, or network partition constructs a fine client yet denies
    // every privileged read at runtime — the exact failure that made Payment
    // Monitoring and Communications render empty. This actively verifies the
    // access path (minimal, read-only, secret-free) and flips readiness so
    // /health/ready reports 503 instead of the backend looking healthy while
    // its financial/operational dashboards are silently blind.
    try {
        const probe = await runStartupProbe();
        setDependencyStatus("supabase", { ok: probe.ok, reason: probe.reason });
        if (!probe.ok) {
            console.error("[FATAL] Supabase service-role configuration is unavailable.");
            console.error("[ERROR] Required privileged database access cannot be verified.");
            console.error("[ERROR] Payment Monitoring and Communications cannot safely operate.");
            console.error(`[ERROR] dependency=supabase component=startup_probe status=failed reason=${probe.reason}`);
            // Readiness lifecycle: process stays ALIVE (so /health/live is 200 and
            // logs keep flowing) but NOT READY. Set STRICT_STARTUP_PROBE=true to
            // turn this into a hard, non-zero exit on deploy targets that prefer a
            // crash-loop to a running-but-unready process.
            if (process.env.STRICT_STARTUP_PROBE === "true") {
                console.error("STRICT_STARTUP_PROBE=true — refusing to run without verified privileged access.");
                process.exit(1);
            }
        }
    } catch (err) {
        setDependencyStatus("supabase", { ok: false, reason: "probe_threw" });
        console.error("[FATAL] Supabase startup probe threw:", err?.message || err);
        if (process.env.STRICT_STARTUP_PROBE === "true") process.exit(1);
    }
    // Initialize email service on startup, but don't block the API in dev
    if (process.env.NODE_ENV === "production") {
        await initializeEmailService();
        await initializeAmbassadorEmailService();
        await initializeMarketingEmailService();
    } else {
        initializeEmailService().catch((error) => {
            console.warn("Email service check skipped/failed in development:", error?.message || error);
        });
        initializeAmbassadorEmailService().catch((error) => {
            console.warn("Ambassador email service check skipped/failed in development:", error?.message || error);
        });
        initializeMarketingEmailService().catch((error) => {
            console.warn("Marketing email service check skipped/failed in development:", error?.message || error);
        });
    }
});
