// Merge-tag template engine for the Email Campaign system.
//
// Syntax: {{key}} or {{key|Fallback text}}. Deliberately dumb/generic — it
// has no idea what "first_name" or "referral_code" mean, it just looks the
// key up in the `data` object handed to it. All the domain logic (which
// keys exist, how they're computed, currency formatting, etc.) lives in
// utils/mergeDataResolver.js, so this file stays a single reusable
// substitution primitive shared by every render path (preview, test-send,
// scheduled campaigns, bulk sends).
const MERGE_TAG_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\}\}/g;

// Values are always HTML-escaped before insertion — recipient-controlled
// data (full_name, etc.) must never be interpreted as markup, and this also
// happens to be *correct* HTML for values placed in attribute position
// (e.g. an unescaped `&` inside an href is invalid HTML).
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replaces every {{key}} / {{key|fallback}} occurrence in `html` using
 * `data` (a flat { key: value } object — see mergeDataResolver.js). A key
 * missing from `data`, or present but null/undefined/empty string, uses the
 * fallback text (trimmed) if one was given in the template, otherwise
 * renders as an empty string — never leaves a raw `{{...}}` in sent email.
 */
export function renderMergeTags(html, data = {}) {
  if (!html) return html;
  return html.replace(MERGE_TAG_PATTERN, (_match, key, fallback) => {
    const value = data[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return escapeHtml(value);
    }
    return fallback !== undefined ? escapeHtml(fallback.trim()) : '';
  });
}

/** Returns the distinct set of merge-tag keys referenced in `html`. */
export function extractMergeTagKeys(html) {
  if (!html) return [];
  const keys = new Set();
  for (const match of html.matchAll(MERGE_TAG_PATTERN)) {
    keys.add(match[1]);
  }
  return Array.from(keys);
}
