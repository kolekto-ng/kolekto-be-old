import express from "express";
import verifyToken from "../utils/verifyToken.js";
import {
    requestCollectionAccess,
    verifyCollectionAccessOtp,
    respondToCollectionAccess,
    revokeCollectionAccess,
    cancelCollectionAccessInvite,
    getCollectionAccessList,
    getSharedCollections,
    getSharedCollectionDetail,
} from "../controllers/collectionAccess.js";

const router = express.Router();

// Owner-initiated grant flow
router.post("/collections/access/request", verifyToken, requestCollectionAccess);
router.post("/collections/access/verify", verifyToken, verifyCollectionAccessOtp);
router.post("/collections/access/grants/:grantId/revoke", verifyToken, revokeCollectionAccess);
router.post("/collections/access/invites/:inviteId/cancel", verifyToken, cancelCollectionAccessInvite);
router.get("/collections/:id/access", verifyToken, getCollectionAccessList);

// Recipient response — verifyToken required; the controller additionally
// matches the caller's email against the invited email (identity isn't a
// stored user id, since the invited email may not have had an account yet).
router.post("/collection-access/respond", verifyToken, respondToCollectionAccess);

// Collaborator-facing read surface
router.get("/collections/shared-with-me", verifyToken, getSharedCollections);
router.get("/collections/:id/shared-view", verifyToken, getSharedCollectionDetail);

export default router;
