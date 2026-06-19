import express from "express";
import verifyToken from "../utils/verifyToken.js";
import { deleteSubscription, getPublicKey, saveSubscription } from "../controllers/push.js";

const router = express.Router();

router.get("/vapid-public-key", verifyToken, getPublicKey);
router.post("/subscriptions", verifyToken, saveSubscription);
router.delete("/subscriptions", verifyToken, deleteSubscription);

export default router;
