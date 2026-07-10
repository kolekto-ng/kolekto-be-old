import express from "express";
import verifyToken from "../utils/verifyToken.js";
import {
    requestCollectionTransfer,
    verifyCollectionTransferOtp,
    respondToCollectionTransfer,
    cancelCollectionTransfer,
    getCollectionTransferStatus,
} from "../controllers/collectionTransfer.js";

const router = express.Router();

// Owner-initiated steps
router.post("/collections/:id/transfer/request", verifyToken, requestCollectionTransfer);
router.post("/collections/:id/transfer/verify", verifyToken, verifyCollectionTransferOtp);
router.post("/collections/:id/transfer/cancel", verifyToken, cancelCollectionTransfer);
router.get("/collections/:id/transfer/status", verifyToken, getCollectionTransferStatus);

// Recipient response — verifyToken required; the controller additionally
// checks the caller is the specific invited account (token alone is not
// treated as sufficient authorization here, unlike email-change confirm).
router.post("/collection-transfer/respond", verifyToken, respondToCollectionTransfer);

export default router;
