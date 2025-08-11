import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth.js";
import collectorRouter from "./routes/collection.js";
import paymentRouter from "./routes/payment.js";
import contributorRouter from "./routes/contribution.js";
import withdrawalRouter from "./routes/withdrawal.js";
dotenv.config();

const app = express();

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
            "kolekto-fe.vercel.app",
            "https://kolekto.com.ng",
            "kolekto.com.ng",
        ],
        credentials: true, // Allow credentials (cookies) to be sent
    })
);



app.use(express.json());
app.use(cookieParser());

app.use("/api", contributorRouter);
app.use("/api/auth", authRouter);
app.use("/api", collectorRouter);
app.use("/api/payments", paymentRouter);
app.use("/api/withdrawals", withdrawalRouter);

const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`Server Running on port ${port}`);
});
