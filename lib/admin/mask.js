'use strict';
// Secrets kept where Node-RED's credential store does not protect them: plain node properties
// (an ical-config's password and private calendar URL), context values (OAuth tokens a flow
// saved), URLs with userinfo or a token in the query. Every read tool passes what it answers
// through here, so a model — and the chat it reports into — sees that a value exists and how
// long it is, not the value.
//
// Best effort by construction: a secret typed into function code or a path segment cannot be
// told from code. Masking by name and by URL shape catches what is stored as data; what is
// written as code belongs in credentials or environment variables.

// Property and key names whose values are masked. Compared against the whole name for short
// words that are too common as substrings (`key`, `pass`), and as a substring for the rest.
// `token` only ends a name — access_token, spotifyTokens — so a setting about tokens
// (tokenCacheTTL, tokenType) is not taken for one.
const SENSITIVE_PART = /(tokens?$|secret|passw(?:or)?d|passphrase|api[-_]?key|private[-_]?key|credential|cookie|bearer|session[-_]?id)/i;
const SENSITIVE_WORD = new Set(['key', 'auth', 'authorization', 'pass', 'pwd', 'pin', 'apikey', 'jwt']);

const MARK = '«masked';
const marker = v => MARK + (typeof v === 'string' ? ': ' + v.length + ' chars»' : '»');

function isSensitiveName(name) {
    const n = String(name);
    return SENSITIVE_WORD.has(n.toLowerCase()) || SENSITIVE_PART.test(n);
}

// A URL's userinfo and the values of sensitive query parameters.
function scrubUrl(s) {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    let u;
    try { u = new URL(s); } catch { return s; }
    let changed = false;
    if (u.username || u.password) { u.username = 'masked'; u.password = ''; changed = true; }
    for (const k of [...u.searchParams.keys()]) {
        if (isSensitiveName(k)) { u.searchParams.set(k, 'masked'); changed = true; }
    }
    return changed ? u.toString() : s;
}

// Only strings and structures can hold a secret; a number or a flag under a sensitive name is a
// setting (a TTL, an enable switch), and masking it hides configuration for nothing.
const isSecretShaped = v => (typeof v === 'string' && v !== '') || (v !== null && typeof v === 'object');

// A copy of `value` with sensitive members masked, recursively.
function maskValue(value, depth = 0) {
    if (typeof value === 'string') return scrubUrl(value);
    if (value === null || typeof value !== 'object' || depth > 20) return value;
    if (Array.isArray(value)) return value.map(v => maskValue(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = isSensitiveName(k) && isSecretShaped(v) ? marker(v) : maskValue(v, depth + 1);
    }
    return out;
}

// createMasker({ enabled, extra }) — extra: "type.property" entries masked whatever they are
// called (ical-config.url). Disabled, it passes everything through.
function createMasker({ enabled = true, extra = '' } = {}) {
    const byType = new Map();
    for (const entry of String(extra).split(',').map(s => s.trim()).filter(Boolean)) {
        const i = entry.lastIndexOf('.');
        if (i <= 0) continue;
        const type = entry.slice(0, i), prop = entry.slice(i + 1);
        if (!byType.has(type)) byType.set(type, new Set());
        byType.get(type).add(prop);
    }
    const node = n => {
        if (!enabled || !n || typeof n !== 'object') return n;
        const out = maskValue(n);
        for (const prop of byType.get(n.type) || []) {
            if (n[prop] !== undefined && n[prop] !== '') out[prop] = marker(n[prop]);
        }
        // Structural fields are never secrets, and masking them would break the answer.
        for (const k of ['id', 'type', 'z', 'g', 'wires', 'links']) if (k in n) out[k] = n[k];
        return out;
    };
    return {
        enabled,
        node,
        value: v => enabled ? maskValue(v) : v,
        // A context key whose name is sensitive is masked whole.
        keyed: (key, v) => enabled && isSensitiveName(key) && isSecretShaped(v) ? marker(v) : (enabled ? maskValue(v) : v)
    };
}

// Whether a value about to be written carries a mask marker — a masked value read back and sent
// on would overwrite the real one with the placeholder.
function containsMask(value, depth = 0) {
    if (typeof value === 'string') return value.startsWith(MARK);
    if (value === null || typeof value !== 'object' || depth > 20) return false;
    return Object.values(value).some(v => containsMask(v, depth + 1));
}

module.exports = { createMasker, maskValue, isSensitiveName, scrubUrl, containsMask, MARK };
