import express from "express";
import verifyToken from "../../utils/verifyToken.js";
import { getDocuments, uploadDocument, saveNIN } from "../../controllers/settings/kyc.js";
import multer from "multer";

const router = express.Router();

// Multer config → keep files in memory for direct upload to Supabase
const upload = multer({ storage: multer.memoryStorage() });
// settings routes - add multer middleware
router.post("/upload-document", verifyToken, upload.array("files", 5), uploadDocument);
router.post("/save-nin", verifyToken, saveNIN);

router.post("/save-nin", verifyToken, saveNIN);
router.get("/:userId", verifyToken, getDocuments);


export default router;
