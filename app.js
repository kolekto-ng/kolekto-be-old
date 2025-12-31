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
import landingPageRouter from "./routes/landingPage.js";
import adminRouter from "./routes/admin/kyc.js";
import helmet from "helmet";
import serverless from 'serverless-http';
import { verifyEmailConfig } from "./services/emailService.js";
dotenv.config();

const app = express();

app.use(helmet());

const isProduction = process.env.NODE_ENV === 'production';

const defaultOrigins = [
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
];

// In production do not allow localhost origins
const allowedOrigins = isProduction
    ? defaultOrigins.filter((o) => !/localhost|127\.0\.0\.1/.test(o))
    : defaultOrigins;

app.use(
    cors({
        origin: function (origin, callback) {
            // Allow non-browser requests with no origin (curl, server-to-server)
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) return callback(null, true);
            return callback(new Error('CORS policy: This origin is not allowed.'), false);
        },
        credentials: true, // Allow credentials (cookies) to be sent
    })
);



app.use(express.json());
app.use(cookieParser());

app.get("/", (req, res) => {
    res.json({
        status: "ok",
        service: "Kolekto API",
        environment: process.env.NODE_ENV || "unknown",
    });
});

app.get("/health", (req, res) => {
    res.status(200).json({ status: "healthy" });
});

app.use("/api", contributorRouter);
app.use("/api/auth", authRouter);
app.use("/api", collectorRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/payments", paymentRouter);
app.use("/api/withdrawals", withdrawalRouter);
app.use("/api/settings/profile", profileRouter);
app.use("/api/settings/kyc", kycRouter);
app.use("/api/landing-page", landingPageRouter);
app.use("/api/adminurlabdkole", adminRouter);

const port = process.env.PORT || 5000;

app.set('trust proxy', true);

let emailInitialized = false;
// Initialize email service
const initializeEmailService = async () => {
    const isReady = await verifyEmailConfig();
    if (isReady) {
        console.log('✅ Email service initialized successfully');
    } else {
        throw new Error('Email service not configured properly. Check your .env file.');
    }
    emailInitialized = true;
};

const isLambda = !!process.env.LAMBDA_TASK_ROOT || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

if (!isLambda) {
    app.listen(port, async () => {
        console.log(`Server Running on port ${port}`);
        // Initialize email service on startup
        await initializeEmailService();
    });
}

const lambdaHandler = serverless(app, {
    provider: "aws",
    request: (request, event) => {
        request.url = event.rawPath || request.url;
        console.log(`Lambda request URL: ${request.url}`);
    },
});

export const handler = async (event, context) => {
    if (!emailInitialized) {
        await initializeEmailService();
    }
    return lambdaHandler(event, context);
};
