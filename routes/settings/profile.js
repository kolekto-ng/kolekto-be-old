import express from "express";
import verifyToken from "../../utils/verifyToken.js";
import upload from "../../middleware/multer.js"; // Import multer configuration
import { getProfile, uploadAvatar } from "../../controllers/settings/profile.js";

const router = express.Router();

// settings routes - add multer middleware
router.post("/upload-avatar", verifyToken, upload.single("avatar"), uploadAvatar);

import {
    fetchBanks,
    verifyBankAccount,
    saveAccount,
    getAccounts,
    setDefaultAccount,
    deletePayoutAccount,
} from "../../controllers/settings/profile.js";

router.get("/", verifyToken, getProfile);
router.get("/banks", fetchBanks);
router.post("/verify-account", verifyBankAccount);
router.post("/save-account", verifyToken, saveAccount);
router.get("/payout-accounts", verifyToken, getAccounts);
router.post("/set-default", verifyToken, setDefaultAccount);
router.delete("/payout-accounts/:id", verifyToken, deletePayoutAccount);


export default router;
