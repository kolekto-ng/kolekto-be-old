import express from "express";
import cors from "cors";
import dotenv from "dotenv";
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
import helmet from "helmet";
import { verifyEmailConfig } from "./services/emailService.js";
dotenv.config();

const app = express();

app.use(helmet());

const corsOptions = {
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
        "kolekto-fe.vercel.app",
        "https://kolekto.com.ng",
        "kolekto.com.ng",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

app.use(cors(corsOptions));
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && corsOptions.origin.includes(origin)) {
        res.header("Access-Control-Allow-Origin", origin);
        res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});

app.use(express.json());
app.use(cookieParser());

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

app.listen(port, async () => {
    console.log(`Server Running on port ${port}`);
    // Initialize email service on startup, but don't block the API in dev
    if (process.env.NODE_ENV === "production") {
        await initializeEmailService();
    } else {
        initializeEmailService().catch((error) => {
            console.warn("Email service check skipped/failed in development:", error?.message || error);
        });
    }
});
