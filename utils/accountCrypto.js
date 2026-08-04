import crypto from "crypto";

// ─── Single source of truth for payout-account encryption ────────────────────
//
// Bank account numbers are encrypted at rest in `payout_accounts.account_number_cipher`
// using AES-256-CBC. The key is derived from the `ACCOUNT_ENCRYPTION_KEY` env var.
//
// Historically the key-derivation + cipher helpers were copy-pasted into
// controllers/settings/profile.js (encrypt), controllers/withdrawal.js
// (decrypt) and scripts/auditPayoutAccounts.js (audit). When those copies
// drifted — or when the same env var resolved to different bytes between
// environments — encryption written by one path could not be read by another,
// surfacing to users as an "encryption error" when adding a bank account or
// requesting a withdrawal.
//
// This module is the ONE place the key is derived and the ONE place we encrypt
// and decrypt, so the encrypt and decrypt sides can never disagree again.

const IV_LENGTH = 16; // AES block size

// `.env` parsers and hosting dashboards (Render, Railway, Vercel, Docker
// `--env-file`, copy/paste) frequently introduce surrounding quotes or a
// trailing newline / carriage return / whitespace. Without sanitising, a key
// that is exactly 32 bytes locally (used as raw AES-256 key bytes) becomes 33+
// bytes in production and silently falls through to the SHA-256 branch — a
// DIFFERENT key. Strip those so the SAME secret always derives the SAME key.
function sanitizeRawKey(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    // Strip one layer of matching surrounding quotes ("..." or '...').
    if (
        s.length >= 2 &&
        ((s[0] === '"' && s[s.length - 1] === '"') ||
            (s[0] === "'" && s[s.length - 1] === "'"))
    ) {
        s = s.slice(1, -1).trim();
    }
    return s.length ? s : null;
}

// Derive a stable 32-byte key from a raw string value.
//   - a 32-byte raw string  → use bytes directly
//   - a 64-char hex string  → decode to 32 bytes
//   - any other passphrase  → SHA-256 → 32 bytes
function deriveKey(rawValue) {
    if (rawValue == null) return null;
    const str = String(rawValue);
    let buf = Buffer.from(str, "utf8");
    if (buf.length !== 32 && /^[0-9a-fA-F]{64}$/.test(str)) {
        buf = Buffer.from(str, "hex");
    }
    if (buf.length === 32) return buf;
    return crypto.createHash("sha256").update(str, "utf8").digest();
}

// The canonical key used for NEW encryption. Read lazily on each call so env
// loading order (tests / CI / scripts) never causes a module-load crash.
export function getAccountEncryptionKey() {
    return deriveKey(sanitizeRawKey(process.env.ACCOUNT_ENCRYPTION_KEY));
}

export function isAccountEncryptionConfigured() {
    return !!getAccountEncryptionKey();
}

// Structured status for startup logging / health checks. Never returns the key
// material itself — only its shape — so it is safe to log.
export function getAccountEncryptionStatus() {
    const raw = process.env.ACCOUNT_ENCRYPTION_KEY;
    const sanitized = sanitizeRawKey(raw);
    return {
        configured: !!sanitized,
        // Surface formatting that would previously have changed the key.
        hadSurroundingWhitespaceOrQuotes:
            !!raw && !!sanitized && String(raw) !== sanitized,
        rawLength: raw == null ? 0 : String(raw).length,
        // A short passphrase still works (SHA-256 widens it) but is weak.
        weak: !!sanitized && sanitized.length < 16,
    };
}

// All candidate keys to TRY during decryption. The canonical (sanitised) key
// is tried first; the raw/un-sanitised variants are tried as fallbacks so that
// ciphertext written BEFORE this sanitisation existed (e.g. with a trailing
// newline baked into the key) still decrypts. New data is always written with
// the canonical key. De-duplicated by key bytes.
//
// KEY ROTATION: set `ACCOUNT_ENCRYPTION_KEY_PREVIOUS` to the OLD key while
// rotating to a new `ACCOUNT_ENCRYPTION_KEY`. Records written with the old key
// keep decrypting (read path tries it as a fallback) while all NEW writes use
// the new key — so a rotation never makes existing bank records unreadable.
// Supports a comma-separated list for chained rotations.
function candidateKeys() {
    const keys = [];
    const seen = new Set();
    const push = (k) => {
        if (!k) return;
        const hex = k.toString("hex");
        if (seen.has(hex)) return;
        seen.add(hex);
        keys.push(k);
    };
    const pushAllVariants = (rawEnv) => {
        push(deriveKey(sanitizeRawKey(rawEnv))); // canonical
        push(deriveKey(rawEnv == null ? null : String(rawEnv))); // exact raw value
        push(deriveKey(rawEnv == null ? null : String(rawEnv).trim())); // trimmed only
    };

    pushAllVariants(process.env.ACCOUNT_ENCRYPTION_KEY);

    const previous = process.env.ACCOUNT_ENCRYPTION_KEY_PREVIOUS;
    if (previous) {
        for (const part of String(previous).split(",")) {
            pushAllVariants(part);
        }
    }
    return keys;
}

// AES-256-CBC encryption.
// Returns base64 string `iv||ciphertext` so the value can be stored in any
// column type (bytea, text, jsonb) and round-trips cleanly through PostgREST.
export function encryptAccountNumber(text) {
    const key = getAccountEncryptionKey();
    if (!key) {
        throw new Error("ACCOUNT_ENCRYPTION_KEY is not configured");
    }
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([
        cipher.update(String(text), "utf8"),
        cipher.final(),
    ]);
    return Buffer.concat([iv, encrypted]).toString("base64");
}

// ─── Legacy ciphertext-shape tolerance ───────────────────────────────────────
// We accept every historical ciphertext shape: base64 string (current),
// `\x...` / `0x...` hex, raw Buffer, Uint8Array, or the
// `{type:"Buffer",data:[...]}` JSON form Supabase-JS produced before the
// encryption fix (which may itself have been hex-encoded by a bytea column).

function tryUnwrapBufferJson(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && parsed.type === "Buffer" && Array.isArray(parsed.data)) {
            return Buffer.from(parsed.data);
        }
    } catch {
        /* not JSON — fall through */
    }
    return null;
}

function cipherToBuffer(cipherValue) {
    if (cipherValue == null) return null;
    if (Buffer.isBuffer(cipherValue)) return cipherValue;
    if (cipherValue instanceof Uint8Array) return Buffer.from(cipherValue);
    if (
        typeof cipherValue === "object" &&
        cipherValue.type === "Buffer" &&
        Array.isArray(cipherValue.data)
    ) {
        return Buffer.from(cipherValue.data);
    }
    if (typeof cipherValue === "string") {
        // Legacy text-column corruption: literal JSON-serialised Buffer.
        const fromJson = tryUnwrapBufferJson(cipherValue);
        if (fromJson) return fromJson;

        if (cipherValue.startsWith("\\x") || cipherValue.startsWith("0x")) {
            const hex = cipherValue.slice(2);
            const hexBuf = Buffer.from(hex, "hex");
            // Legacy bytea-column corruption: hex-encoded JSON-serialised Buffer.
            if (hexBuf.length > 0 && hexBuf[0] === 0x7b /* '{' */) {
                const unwrapped = tryUnwrapBufferJson(hexBuf.toString("utf8"));
                if (unwrapped) return unwrapped;
            }
            return hexBuf;
        }
        return Buffer.from(cipherValue, "base64");
    }
    return null;
}

function tryDecryptWithBuffer(encryptedBuffer, keyBuffer) {
    if (!encryptedBuffer || encryptedBuffer.length <= 16) return null;
    try {
        const iv = encryptedBuffer.subarray(0, 16);
        const cipherText = encryptedBuffer.subarray(16);
        const decipher = crypto.createDecipheriv("aes-256-cbc", keyBuffer, iv);
        const decrypted = Buffer.concat([
            decipher.update(cipherText),
            decipher.final(),
        ]);
        const plain = decrypted.toString("utf8").trim();
        return plain || null;
    } catch {
        return null;
    }
}

// Returns the decrypted plaintext account number, or null if it cannot be
// recovered with any candidate key / ciphertext shape. Never throws.
export function decryptAccountNumber(cipherValue) {
    const keys = candidateKeys();
    if (!keys.length) return null;

    // Collect every plausible buffer interpretation of the stored value.
    const buffers = [];
    const pushBuf = (b) => {
        if (b && b.length > 16) buffers.push(b);
    };
    pushBuf(cipherToBuffer(cipherValue));

    if (typeof cipherValue === "string") {
        const trimmed = cipherValue.trim();
        pushBuf(tryUnwrapBufferJson(trimmed));
        if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
            pushBuf(Buffer.from(trimmed, "hex"));
        }

        // Legacy bytea double-encoding: the column was `bytea`, so PostgREST
        // returned `\x<hex>` where the hex decodes not to the raw ciphertext
        // but to the base64 STRING of it (the encrypt side wrote a base64
        // string into a bytea column). Undo the extra layer: hex → utf8 text →
        // base64-decode → real iv‖ciphertext.
        if (trimmed.startsWith("\\x") || trimmed.startsWith("0x")) {
            try {
                const inner = Buffer.from(trimmed.slice(2), "hex").toString("utf8").trim();
                if (/^[A-Za-z0-9+/=]+$/.test(inner)) {
                    pushBuf(Buffer.from(inner, "base64"));
                }
            } catch {
                /* not this shape — ignore */
            }
        }
    }

    for (const buf of buffers) {
        for (const key of keys) {
            const plain = tryDecryptWithBuffer(buf, key);
            if (plain) return plain;
        }
    }
    return null;
}

// Convenience boolean check used when deciding which saved account is safe
// to default to. Never logs or returns the plaintext.
export function isAccountCipherDecryptable(cipherValue) {
    return decryptAccountNumber(cipherValue) !== null;
}

// Safe shape diagnostics for support/debugging — never includes the cipher
// bytes or any decrypted plaintext, only metadata about the storage shape.
// Used by scripts/auditPayoutAccounts.js and ad-hoc production debugging to
// answer "what format is Supabase actually returning?" without risking a
// sensitive value ending up in logs.
export function describeCipherShape(cipherValue) {
    if (cipherValue == null) {
        return { jsType: typeof cipherValue, shape: "null", length: 0, decryptable: false };
    }
    if (Buffer.isBuffer(cipherValue)) {
        return { jsType: "object", shape: "Buffer", length: cipherValue.length, decryptable: isAccountCipherDecryptable(cipherValue) };
    }
    if (cipherValue instanceof Uint8Array) {
        return { jsType: "object", shape: "Uint8Array", length: cipherValue.length, decryptable: isAccountCipherDecryptable(cipherValue) };
    }
    if (typeof cipherValue === "object") {
        const shape = cipherValue.type === "Buffer" && Array.isArray(cipherValue.data)
            ? "BufferJSON"
            : "unknownObject";
        return { jsType: "object", shape, length: Array.isArray(cipherValue?.data) ? cipherValue.data.length : null, decryptable: isAccountCipherDecryptable(cipherValue) };
    }
    if (typeof cipherValue === "string") {
        let shape = "base64";
        if (cipherValue.startsWith("\\x")) shape = "bytea-hex(\\x)";
        else if (cipherValue.startsWith("0x")) shape = "hex(0x)";
        else if (cipherValue.trim().startsWith("{")) shape = "jsonText";
        return { jsType: "string", shape, length: cipherValue.length, decryptable: isAccountCipherDecryptable(cipherValue) };
    }
    return { jsType: typeof cipherValue, shape: "unknown", length: null, decryptable: false };
}
