import express from "express";
// Adjusted to match existing controller
import verifyToken from "../utils/verifyToken.js";
import { createContribution, getSingleCollection } from "../controllers/contribution.js";

const router = express.Router();

router.get("/contributions", getSingleCollection);

// Contributor routes
router.post("/contributions/:id", createContribution); // Public for contribution
// router.get("/:id/contributors", verifyToken, getContributors);
// router.get("/contributors", verifyToken, getAllContributors); // Required for DashboardPage

export default router;
