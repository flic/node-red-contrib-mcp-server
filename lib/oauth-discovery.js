'use strict';
// Pure helpers for the mcp-server config node's OAuth protected-resource discovery
// (RFC 9728), authorization-server discovery (RFC 8414) and dynamic client registration
// shim. No Express/HTTP dependency, so these are unit-testable in isolation — the node's
// route handlers are thin glue that parse the request, call one of these, and res.json()
// the result.

// RFC 9728: the resource identifier must equal the URL the client actually connects to
// (the MCP JSON-RPC endpoint), and authorization_servers must list the server(s) that can
// issue tokens for it.
function buildProtectedResourceMetadata({ resourceUrl, authServerUrl, scopes }) {
    return {
        resource                 : resourceUrl,
        authorization_servers    : [authServerUrl],
        bearer_methods_supported : ['header'],
        scopes_supported         : scopes
    };
}

// RFC 8414 authorization server metadata. The MCP server proxies the real OIDC issuer's
// endpoints under its own `issuer` identity so MCP clients only ever need to trust one
// origin (this server) for discovery + DCR, while the actual authorize/token/userinfo
// traffic still goes straight to the real IdP.
function buildAuthorizationServerMetadata({ issuerBase, oidc, registrationEndpoint, scopes, hasClientSecret }) {
    return {
        issuer                                 : issuerBase,
        authorization_endpoint                 : oidc.authorization_endpoint,
        token_endpoint                         : oidc.token_endpoint,
        userinfo_endpoint                      : oidc.userinfo_endpoint,
        registration_endpoint                  : registrationEndpoint,
        jwks_uri                               : oidc.jwks_uri,
        scopes_supported                       : scopes,
        response_types_supported               : ['code'],
        grant_types_supported                  : ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported       : ['S256'],
        token_endpoint_auth_methods_supported  : hasClientSecret ? ['client_secret_post', 'none'] : ['none']
    };
}

// Never echo attacker-controlled redirect_uris back to the caller. Constrain any requested
// URIs to the configured allowlist; fall back to the full configured set when none (valid)
// were requested. { ok: false } signals "requested URIs, none of which are allowed" — the
// caller should reject with 400 rather than register anything.
function filterRedirectUris(requestedUris, allowedUris) {
    const requested = Array.isArray(requestedUris) ? requestedUris : [];
    const allowed   = requested.filter(u => allowedUris.includes(u));
    if (requested.length && !allowed.length) {
        return { ok: false, uris: [] };
    }
    return { ok: true, uris: allowed.length ? allowed : allowedUris };
}

function buildDcrRegistration({ clientId, clientSecret, redirectUris, scopeStr }) {
    const registration = {
        client_id                  : clientId,
        client_id_issued_at        : Math.floor(Date.now() / 1000),
        redirect_uris              : redirectUris,
        grant_types                : ['authorization_code', 'refresh_token'],
        response_types             : ['code'],
        token_endpoint_auth_method : clientSecret ? 'client_secret_post' : 'none',
        scope                      : scopeStr
    };
    if (clientSecret) registration.client_secret = clientSecret;
    return registration;
}

module.exports = {
    buildProtectedResourceMetadata,
    buildAuthorizationServerMetadata,
    filterRedirectUris,
    buildDcrRegistration
};
