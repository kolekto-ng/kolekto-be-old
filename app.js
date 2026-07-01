import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth.js";
import collectorRouter from "./routes/collection.js";
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
import helmet from "helmet";
import { verifyEmailConfig } from "./services/emailService.js";
import { getAccountEncryptionStatus } from "./utils/accountCrypto.js";
import "./jobs/paymentSettlement.js"; // registers T+1 settlement cron (5am WAT daily)
import "./jobs/pushNotifications.js"; // registers push notification reminder/deadline jobs
// Imported directly so we can mount the webhook route with a RAW body parser
// before the global JSON parser. See B-1 below.
import { handleWebhook } from "./controllers/deposit.js";
const app = express();
app.use(helmet());

app.use(
    cors({
        origin: [
            "https://www.kolekto.com.ng",
            "www.kolekto.com.ng",
            "http://localhost:8080",
            "http://localhost:8081",
            "http://localhost:5173",
            "http://localhost:5174",
            "https://staging-kolekto-fe.vercel.app",
            "https://kolekto-admin-control-panel.vercel.app",
            "https://test.kolekto.com.ng",
            "test.kolekto.com.ng",
            "https://kolekto-fe.vercel.app",
            "https://kolekto-fe-old.vercel.app",
            "kolekto-fe.vercel.app",
            "https://kolekto.com.ng",
            "kolekto.com.ng",
        ],
        credentials: true, // Allow credentials (cookies) to be sent
    })
);



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

app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Kolekto backend is running successfully"
    });
});

app.use("/api", contributorRouter);
app.use("/api/auth", authRouter);
app.use("/api", collectorRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/payments", paymentRouter);
app.use("/api/withdrawals", withdrawalRouter);
app.use("/api/settings/profile", profileRouter);
app.use("/api/settings/kyc", kycRouter);
app.use("/api/settings/security", securityRouter);
app.use("/api/push", pushRouter);
app.use("/api/landing-page", landingPageRouter);
app.use("/api/adminurlabdkole", adminRouter);
// Same admin prefix — Express composes multiple routers on the same mount.
// F5: admin reconcile-payment endpoint.
app.use("/api/adminurlabdkole", adminPaymentsRouter);
// Payment Monitoring & Recovery Center — dashboard data + retry/resolve/notes.
app.use("/api/adminurlabdkole", adminPaymentMonitoringRouter);

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
            "fallback keys, but consider cleaning the env var so the raw value matches."
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
    // Initialize email service on startup, but don't block the API in dev
    if (process.env.NODE_ENV === "production") {
        await initializeEmailService();
    } else {
        initializeEmailService().catch((error) => {
            console.warn("Email service check skipped/failed in development:", error?.message || error);
        });
    }
});
