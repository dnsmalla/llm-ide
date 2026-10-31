// Google OAuth scope registry (plan section 4 item 2). The authorization URL is built ONLY from this table, and the
// callback checks the scopes Google granted against what was requested: a grant that contains anything we did not
// ask for is refused (and revoked), a grant that is missing something only turns that product off.
//
// All scopes are READ-ONLY. There is no gmail.modify/compose/send, no calendar write, no drive write.
// Tier labels are what the Connect dialog shows. Google's own tiering (restricted / sensitive) is from third-party
// summaries and the plan marks it unverified; the labels are a hint, not a promise.

export const GOOGLE_HOSTS = Object.freeze([
  'accounts.google.com',
  'oauth2.googleapis.com',
  'gmail.googleapis.com',
  'www.googleapis.com',
  'calendar.googleapis.com',
]);

const A = 'https://www.googleapis.com/auth/';

/** Identity scopes: the account's stable id (`sub`) and its address. No data access. */
export const IDENTITY_SCOPES = Object.freeze(['openid', 'email']);

export const PRODUCTS = Object.freeze({
  gmail: Object.freeze({
    label: 'Gmail',
    scopes: Object.freeze([`${A}gmail.readonly`]),
    tier: 'restricted',
  }),
  gcal: Object.freeze({
    label: 'Google Calendar',
    scopes: Object.freeze([`${A}calendar.events.readonly`, `${A}calendar.calendarlist.readonly`]),
    tier: 'sensitive',
  }),
  gdrive: Object.freeze({
    label: 'Google Drive',
    // Metadata only until the user ticks content indexing, then drive.readonly (which covers metadata too).
    scopes: Object.freeze([`${A}drive.metadata.readonly`]),
    contentScopes: Object.freeze([`${A}drive.readonly`]),
    tier: 'restricted',
  }),
});

export const PRODUCT_IDS = Object.freeze(Object.keys(PRODUCTS));

const TIER_OF = new Map();
for (const p of Object.values(PRODUCTS)) {
  for (const s of p.scopes) TIER_OF.set(s, p.tier);
  for (const s of p.contentScopes || []) TIER_OF.set(s, p.tier);
}
for (const s of IDENTITY_SCOPES) TIER_OF.set(s, 'basic');

// Google reports `email` as the full userinfo URL; compare on the canonical short form.
const CANON = new Map([
  [`${A}userinfo.email`, 'email'],
  [`${A}userinfo.profile`, 'profile'],
]);
export function canonScope(s) { return CANON.get(s) || s; }

/**
 * Scopes to request for a set of products (identity scopes included, de-duplicated, sorted).
 * @param {string[]} products product ids from PRODUCT_IDS (unknown ids are an error)
 * @param {{ driveContent?: boolean }} [o]
 */
export function scopesFor(products, { driveContent = false } = {}) {
  const set = new Set(IDENTITY_SCOPES);
  for (const id of products) {
    const p = PRODUCTS[id];
    if (!p) throw new Error(`unknown Google product: ${id}`);
    if (id === 'gdrive' && driveContent) for (const s of p.contentScopes) set.add(s);
    else for (const s of p.scopes) set.add(s);
  }
  return [...set].sort();
}

/** The scope list as the Connect dialog shows it: scope, tier label, read-only note. */
export function describeScopes(scopes) {
  return scopes.map((scope) => ({ scope, tier: TIER_OF.get(scope) || 'unknown', readOnly: true }));
}

/**
 * Compare what Google granted with what was requested.
 * `ok` is false when Google granted something that was NOT requested (the connect must be refused).
 * `missing` lists requested scopes the user unticked on the consent screen.
 */
export function checkGranted(requested, grantedString) {
  const want = new Set(requested.map(canonScope));
  const got = new Set(String(grantedString || '').split(/\s+/).filter(Boolean).map(canonScope));
  const extra = [...got].filter((s) => !want.has(s)).sort();
  const missing = [...want].filter((s) => !got.has(s)).sort();
  return { ok: extra.length === 0 && got.size > 0, extra, missing, granted: [...got].sort() };
}

/** Products a granted scope set enables (every scope of the product must be granted). */
export function productsEnabledBy(grantedScopes) {
  const got = new Set(grantedScopes.map(canonScope));
  const out = [];
  for (const [id, p] of Object.entries(PRODUCTS)) {
    const need = p.scopes;
    const hasMeta = need.every((s) => got.has(s));
    const hasContent = (p.contentScopes || []).some((s) => got.has(s));
    if (hasMeta || hasContent) out.push(id);
  }
  return out;
}

/** True when the granted scopes allow Drive content export. */
export function driveContentGranted(grantedScopes) {
  const got = new Set(grantedScopes.map(canonScope));
  return PRODUCTS.gdrive.contentScopes.every((s) => got.has(s));
}
