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

// Accepts every historical ciphertext shape: base64 string (current),
// `\x...` hex (Postgres bytea text rendering), raw Buffer, or the
// `{type:"Buffer",data:[...]}` JSON form Supabase-JS produced before the
// encryption fix.
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

    const primary = cipherToBuffer(cipherValue);
    const fromPrimary = tryDecryptWithBuffer(primary, keyBuffer);
    if (fromPrimary) return fromPrimary;

    if (typeof cipherValue === "string") {
        const trimmed = cipherValue.trim();
        const fromJson = tryUnwrapBufferJson(trimmed);
        const fromJsonResult = tryDecryptWithBuffer(fromJson, keyBuffer);
        if (fromJsonResult) return fromJsonResult;

        if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
            const hexBuf = Buffer.from(trimmed, "hex");
            const fromHex = tryDecryptWithBuffer(hexBuf, keyBuffer);
            if (fromHex) return fromHex;
        }
    }

    return null;
}

// Convenience boolean check used when deciding which saved account is safe
// to default to. Never logs or returns the plaintext.
export function isAccountCipherDecryptable(cipherValue) {
    return decryptAccountNumber(cipherValue) !== null;
}
