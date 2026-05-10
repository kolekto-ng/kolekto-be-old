import express from "express";
import verifyToken from "../utils/verifyToken.js";
import { collectionActivities, getCollectionDashboardStats, getDashboardStats } from "../controllers/dashboard.js";

const router = express.Router();

// Paystack verify payment webhook endpoint
router.get('/stats', verifyToken, getDashboardStats);
router.get('/collections/:collectionId/stats', verifyToken, getCollectionDashboardStats);
router.get('/activities', verifyToken, collectionActivities);

export default router;
