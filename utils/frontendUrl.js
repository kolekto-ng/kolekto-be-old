const DEFAULT_FRONTEND_URL = "https://www.kolekto.com.ng";

// Returns a well-formed absolute frontend origin (no trailing slash).
// FRONTEND_URL is validated, not just trusted — a malformed value (missing
// entirely, or a scheme-only placeholder like "http://") falls back to the
// default rather than producing a broken link. A naive
// `(process.env.FRONTEND_URL || "").replace(/\/$/, "")` looks safe but
// silently breaks: for "http://" it strips only the single trailing slash,
// leaving "http:/", so `${that}/path` becomes "http://path" — a bare host
// named "path" instead of an actual URL.
export function getFrontendUrl() {
  const raw = (process.env.FRONTEND_URL || "").trim();
  if (!raw) return DEFAULT_FRONTEND_URL;

  try {
    const parsed = new URL(raw);
    if (!parsed.host) return DEFAULT_FRONTEND_URL;
    return raw.replace(/\/+$/, "");
  } catch {
    return DEFAULT_FRONTEND_URL;
  }
}
