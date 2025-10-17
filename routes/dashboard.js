import express from "express";
import verifyToken from "../utils/verifyToken.js";
import { collectionActivities } from "../controllers/dashboard.js";

const router = express.Router();

// Paystack verify payment webhook endpoint
router.get('/activities', verifyToken, collectionActivities);

export default router;