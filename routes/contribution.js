import express from "express";
// Adjusted to match existing controller
import verifyToken from "../utils/verifyToken.js";
import { createContribution, getContributions, getSingleCollection } from "../controllers/contribution.js";

const router = express.Router();
// Contributor routes
router.post("/contributions/:id", createContribution); // Public for contribution
// router.get("/:id/contributors", verifyToken, getContributors);
router.get("/contributions", verifyToken, getContributions); // Required for DashboardPage

export default router;
