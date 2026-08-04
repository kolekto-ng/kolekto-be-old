import express from "express";
import verifyToken from "../utils/verifyToken.js";
import { deleteSubscription, getDiagnostics, getPublicKey, saveSubscription, sendTestPush } from "../controllers/push.js";

const router = express.Router();

router.get("/vapid-public-key", verifyToken, getPublicKey);
router.post("/subscriptions", verifyToken, saveSubscription);
router.delete("/subscriptions", verifyToken, deleteSubscription);
router.get("/diagnostics", verifyToken, getDiagnostics);
router.post("/test", verifyToken, sendTestPush);

export default router;
