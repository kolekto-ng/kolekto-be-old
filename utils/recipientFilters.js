// Formats a list of values as a PostgREST "in"-list literal, e.g.
// ["a@x.com", 'b"c@y.com'] -> ("a@x.com","b\"c@y.com"). Used for the
// not.in exclusion filter below.
function formatInList(values) {
  return `(${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',')})`;
}

// Applies the Email Campaign audience filters (AND-combined) to a
// supabase-js query against the email_recipient_directory view. Plain
// chained filters rather than a bespoke filter-DSL-to-SQL translator,
// consistent with how every other admin page in this repo queries Supabase.
//
// Deliberately does NOT support country/state/city — no such columns exist
// on public.profiles (verified against the live schema before this was
// written; see database/email_recipient_directory.sql).
export function applyRecipientFilters(query, filters = {}) {
  let q = query;
  if (filters.registeredAfter) q = q.gte('registered_at', filters.registeredAfter);
  if (filters.registeredBefore) q = q.lte('registered_at', filters.registeredBefore);
  if (filters.isEmailVerified !== undefined && filters.isEmailVerified !== null) {
    q = q.eq('is_email_verified', filters.isEmailVerified);
  }
  if (filters.isAmbassador !== undefined && filters.isAmbassador !== null) {
    q = q.eq('is_ambassador', filters.isAmbassador);
  }
  if (filters.isOrganizer !== undefined && filters.isOrganizer !== null) {
    q = q.eq('is_organizer', filters.isOrganizer);
  }
  if (filters.isContributor !== undefined && filters.isContributor !== null) {
    q = q.eq('is_contributor', filters.isContributor);
  }
  if (filters.isCollectionCreator !== undefined && filters.isCollectionCreator !== null) {
    q = q.eq('is_collection_creator', filters.isCollectionCreator);
  }
  if (filters.collectionsCountMin !== undefined && filters.collectionsCountMin !== null && filters.collectionsCountMin !== '') {
    q = q.gte('collections_count', filters.collectionsCountMin);
  }
  if (filters.lastLoginAfter) q = q.gte('last_login_at', filters.lastLoginAfter);
  if (filters.lastLoginBefore) q = q.lte('last_login_at', filters.lastLoginBefore);
  if (filters.isReferred !== undefined && filters.isReferred !== null) {
    q = q.eq('is_referred', filters.isReferred);
  }
  if (filters.referralCode) q = q.eq('ambassador_referral_code', filters.referralCode);
  // Lets an admin remove specific individuals from an otherwise-matching
  // audience (e.g. "everyone who's a contributor, except these 3 people").
  if (Array.isArray(filters.excludeEmails) && filters.excludeEmails.length > 0) {
    q = q.not('email', 'in', formatInList(filters.excludeEmails));
  }
  return q;
}

export function hasAnyFilters(filters) {
  if (!filters || typeof filters !== 'object') return false;
  return Object.entries(filters).some(([key, v]) => {
    if (key === 'excludeEmails') return Array.isArray(v) && v.length > 0;
    return v !== undefined && v !== null && v !== '';
  });
}
