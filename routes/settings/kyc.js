import express from "express";
import verifyToken from "../../utils/verifyToken.js";
import { getDocuments, uploadDocument, saveNIN } from "../../controllers/settings/kyc.js";
import multer from "multer";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// B-6: KYC upload hardening.
//   - Cap per-file size at 5 MB (matches the avatar upload config in
//     middleware/multer.js).
//   - MIME whitelist: jpeg/png/webp + pdf only. Rejects html/exe/svg etc.
//   - upload.array("files", 5) already caps to 5 files per request.
// On rejection we surface a stable error code the FE can branch on.
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED_KYC_MIME = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
]);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5 MB per file
        files: 5,                   // matches upload.array(..., 5)
        fields: 10,                 // small text-field cap
    },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_KYC_MIME.has(file.mimetype)) {
            cb(null, true);
            return;
        }
        // Multer surfaces this via `next(err)`; we translate at the route
        // error handler below.
        const err = new Error("UNSUPPORTED_MIME");
        err.code = "UNSUPPORTED_MIME";
        cb(err, false);
    },
});

// Translate multer errors into structured 4xx responses with stable codes
// so the FE can show meaningful messages ("File too large", "Bad file type")
// instead of a generic 500.
function handleMulterError(err, req, res, next) {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
                error: "Each file must be 5 MB or smaller.",
                code: "FILE_TOO_LARGE",
            });
        }
        if (err.code === "LIMIT_FILE_COUNT") {
            return res.status(400).json({
                error: "You can upload at most 5 files per request.",
                code: "TOO_MANY_FILES",
            });
        }
        return res.status(400).json({
            error: err.message || "Upload failed",
            code: err.code || "UPLOAD_FAILED",
        });
    }
    if (err.code === "UNSUPPORTED_MIME") {
        return res.status(415).json({
            error: "Unsupported file type. Allowed: JPEG, PNG, WEBP, PDF.",
            code: "UNSUPPORTED_MIME",
        });
    }
    return next(err);
}

router.post(
    "/upload-document",
    verifyToken,
    upload.array("files", 5),
    handleMulterError,
    uploadDocument
);

router.post("/save-nin", verifyToken, saveNIN);

// ─────────────────────────────────────────────────────────────────────────────
// B-12: route contract cleanup.
//
// The historical route `GET /:userId` ignored its URL param and returned
// the documents of `req.user.id`. We keep the legacy route as a backwards-
// compatible alias (the FE in useProfileStore.fetchKYCStatus calls
// `/settings/kyc/${userId}`) AND expose a cleaner `/documents` route.
// Both handlers read `req.user.id` — the URL param is never trusted.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/documents", verifyToken, getDocuments);
router.get("/:userId", verifyToken, getDocuments); // legacy alias (param ignored)


export default router;
