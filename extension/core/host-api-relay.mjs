// Host API capabilities a relay-bridged session may ever hold, by device tier (relay design D1): the web tier reads and
// chats (remote turns run AUTO_READ_ONLY) but never answers approvals; null = no cap beyond what the host serves.
export const RELAY_TIER_SCOPES = Object.freeze({ web: Object.freeze(new Set(['host', 'chat', 'read'])), ios: null });
export const relayCap = (tier) => (tier && Object.hasOwn(RELAY_TIER_SCOPES, tier) ? RELAY_TIER_SCOPES[tier] : null);
