import express from "express";
// Adjusted to match existing controller
import { createCollection, getSingleCollection, getUserCollections } from "../controllers/collection.js";
import verifyToken from "../utils/verifyToken.js";

const router = express.Router();

// Collection routes
router.post("/create-collection", verifyToken, createCollection);
// router.put("/:id", verifyToken, editCollection);
router.get("/collections", verifyToken, getUserCollections);
// router.get("/collections/:id", verifyToken, getSingleCollection);
// router.get("/contribute/collection/:id", getSingleCollection);

// Contributor routes
// router.post("/:id/contributors", createContributor); // Public for contribution
// router.get("/:id/contributors", verifyToken, getContributors);
// router.get("/contributors", verifyToken, getAllContributors); // Required for DashboardPage

export default router;
