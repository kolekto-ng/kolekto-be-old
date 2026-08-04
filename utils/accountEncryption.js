import crypto from "crypto";

const IV_LENGTH = 16; // AES block size

// Single source of truth for payout-account number encryption/decryption.
// Previously `controllers/settings/profile.js` (encrypt) and
// `controllers/withdrawal.js` (decrypt) each kept their own copy of this
// key-derivation + cipher logic. They happened to stay in sync, but any
// future edit to one without the other would silently break decryption for
// every account saved after the drift. Both controllers now import from
// here instead.

// Derive a stable 32-byte AES key from ACCOUNT_ENCRYPTION_KEY. Accepts:
//   - a 32-byte raw string  -> use bytes directly
//   - a 64-char hex string  -> decode to 32 bytes
//   - any other passphrase  -> SHA-256 -> 32 bytes
export function getAccountEncryptionKey() {
    const raw = process.env.ACCOUNT_ENCRYPTION_KEY;
    if (!raw) return null;
    let buf = Buffer.from(raw, "utf8");
    if (buf.length !== 32 && /^[0-9a-fA-F]{64}$/.test(raw)) {
        buf = Buffer.from(raw, "hex");
    }
    if (buf.length === 32) return buf;
    return crypto.createHash("sha256").update(raw, "utf8").digest();
}

// AES-256-CBC encryption. Returns base64 `iv||ciphertext` so the value
// round-trips cleanly through PostgREST regardless of column type.
export function encryptAccountNumber(text) {
    const keyBuffer = getAccountEncryptionKey();
    if (!keyBuffer) {
        throw new Error("ACCOUNT_ENCRYPTION_KEY is not configured");
    }
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-cbc", keyBuffer, iv);
    const encrypted = Buffer.concat([
        cipher.update(String(text), "utf8"),
        cipher.final(),
    ]);
    return Buffer.concat([iv, encrypted]).toString("base64");
}

// Try to unwrap the legacy bug-shape: the original encryptAccountNumber
// returned a Node Buffer, which Supabase-JS serialised to JSON as
//   {"type":"Buffer","data":[1,2,...]}
// If the underlying column was text, that literal JSON string is what got
// persisted. If the column was bytea, PostgREST hex-encoded those JSON bytes
// — we need to undo both layers here.
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

// A base64 string of a 16-byte-IV + ciphertext is always >= ~24 chars and
// only uses base64's alphabet. Used to recognise "this byte sequence is
// actually the ASCII text of a base64 string" rather than real cipher bytes.
function looksLikeBase64Text(str) {
    return typeof str === "string" && str.length >= 24 && /^[A-Za-z0-9+/]+=*$/.test(str);
}

// Accepts every historical ciphertext shape: base64 string (current),
// `\x...` hex (Postgres bytea text rendering), raw Buffer, or the
// `{type:"Buffer",data:[...]}` JSON form Supabase-JS produced before the
// encryption fix. Returns an array of candidate Buffers to try decrypting,
// most-likely-correct first — callers try each until one decrypts.
function cipherToBufferCandidates(cipherValue) {
    if (cipherValue == null) return [];
    if (Buffer.isBuffer(cipherValue)) return [cipherValue];
    if (cipherValue instanceof Uint8Array) return [Buffer.from(cipherValue)];
    if (
        typeof cipherValue === "object" &&
        cipherValue.type === "Buffer" &&
        Array.isArray(cipherValue.data)
    ) {
        return [Buffer.from(cipherValue.data)];
    }
    if (typeof cipherValue !== "string") return [];

    const candidates = [];

    // Legacy text-column corruption: literal JSON-serialised Buffer.
    const fromJson = tryUnwrapBufferJson(cipherValue);
    if (fromJson) candidates.push(fromJson);

    if (cipherValue.startsWith("\\x") || cipherValue.startsWith("0x")) {
        const hex = cipherValue.slice(2);
        const hexBuf = Buffer.from(hex, "hex");

        // Legacy bytea-column corruption: hex-encoded JSON-serialised Buffer.
        if (hexBuf.length > 0 && hexBuf[0] === 0x7b /* '{' */) {
            const unwrapped = tryUnwrapBufferJson(hexBuf.toString("utf8"));
            if (unwrapped) candidates.push(unwrapped);
        }

        // Bytea-column corruption: the column stored the literal base64
        // STRING as raw bytes (PostgREST/driver wrote the UTF-8 bytes of the
        // base64 text into the bytea column instead of decoding it first).
        // Reading it back gives `\x`-hex of those ASCII bytes — decode the
        // hex, then base64-decode the resulting text to recover the real
        // iv||ciphertext bytes.
        const hexAsText = hexBuf.toString("utf8");
        if (looksLikeBase64Text(hexAsText)) {
            try {
                candidates.push(Buffer.from(hexAsText, "base64"));
            } catch {
                /* not valid base64 — skip */
            }
        }

        // Raw hex bytes as a last resort (covers a genuine binary bytea
        // column written correctly).
        candidates.push(hexBuf);
    } else {
        candidates.push(Buffer.from(cipherValue, "base64"));
    }

    return candidates;
}

function tryDecryptWithBuffer(encryptedBuffer, keyBuffer) {
    if (!encryptedBuffer || encryptedBuffer.length <= 16) return null;
    try {
        const iv = encryptedBuffer.subarray(0, 16);
        const cipherText = encryptedBuffer.subarray(16);
        const decipher = crypto.createDecipheriv("aes-256-cbc", keyBuffer, iv);
        const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
        const plain = decrypted.toString("utf8").trim();
        return plain || null;
    } catch {
        return null;
    }
}

// Returns the decrypted account number, or null if the ciphertext cannot be
// recovered with the current ACCOUNT_ENCRYPTION_KEY (wrong key, or a legacy
// corrupted shape none of the fallbacks above can repair).
export function decryptAccountNumber(cipherValue) {
    const keyBuffer = getAccountEncryptionKey();
    if (!keyBuffer) return null;

    const candidates = cipherToBufferCandidates(cipherValue);

    if (typeof cipherValue === "string") {
        const trimmed = cipherValue.trim();
        if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
            candidates.push(Buffer.from(trimmed, "hex"));
        }
    }

    for (const candidate of candidates) {
        const plain = tryDecryptWithBuffer(candidate, keyBuffer);
        if (plain) return plain;
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
