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
import helmet from "helmet";
import { verifyEmailConfig } from "./services/emailService.js";
import "./jobs/paymentSettlement.js"; // registers T+1 settlement cron (5am WAT daily)
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
app.use("/api/landing-page", landingPageRouter);
app.use("/api/adminurlabdkole", adminRouter);
// Same admin prefix — Express composes multiple routers on the same mount.
// F5: admin reconcile-payment endpoint.
app.use("/api/adminurlabdkole", adminPaymentsRouter);

const port = process.env.PORT || 3000;

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

app.listen(port, '0.0.0.0', async () => {
    console.log(`Server Running on port ${port}`);
    // TEMPORARY DEBUG (remove once the payout-account decryption issue is
    // confirmed fixed in production): confirms the process actually picked
    // up ACCOUNT_ENCRYPTION_KEY after a `pm2 restart` (PM2 does NOT reload
    // .env on a plain restart — `--update-env` is required, or the env was
    // baked into the PM2 process at an earlier, different value). Logs
    // presence + length only — never the key value itself.
    const keyRaw = process.env.ACCOUNT_ENCRYPTION_KEY;
    console.log("[startup] ACCOUNT_ENCRYPTION_KEY:", keyRaw ? `present (length=${keyRaw.length})` : "MISSING");
    // Initialize email service on startup, but don't block the API in dev
    if (process.env.NODE_ENV === "production") {
        await initializeEmailService();
    } else {
        initializeEmailService().catch((error) => {
            console.warn("Email service check skipped/failed in development:", error?.message || error);
        });
    }
});
