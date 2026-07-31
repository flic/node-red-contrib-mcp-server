'use strict';

const assert = require('node:assert');
const {
    buildProtectedResourceMetadata,
    buildAuthorizationServerMetadata,
    filterRedirectUris,
    buildDcrRegistration
} = require('../lib/oauth-discovery');

describe('lib/oauth-discovery buildProtectedResourceMetadata', function () {
    it('produces the RFC 9728 shape', function () {
        const meta = buildProtectedResourceMetadata({
            resourceUrl: 'https://nodered.example.com/mcp/docker',
            authServerUrl: 'https://nodered.example.com/mcp/docker',
            scopes: ['openid', 'profile']
        });
        assert.deepStrictEqual(meta, {
            resource: 'https://nodered.example.com/mcp/docker',
            authorization_servers: ['https://nodered.example.com/mcp/docker'],
            bearer_methods_supported: ['header'],
            scopes_supported: ['openid', 'profile']
        });
    });
});

describe('lib/oauth-discovery buildAuthorizationServerMetadata', function () {
    it('produces the RFC 8414 shape and proxies OIDC endpoints under its own issuer', function () {
        const meta = buildAuthorizationServerMetadata({
            issuerBase: 'https://nodered.example.com/mcp/docker',
            oidc: {
                authorization_endpoint: 'https://idp.example.com/authorize',
                token_endpoint: 'https://idp.example.com/token',
                userinfo_endpoint: 'https://idp.example.com/userinfo',
                jwks_uri: 'https://idp.example.com/jwks'
            },
            registrationEndpoint: 'https://nodered.example.com/mcp/docker/oauth/register',
            scopes: ['openid'],
            hasClientSecret: false
        });
        assert.strictEqual(meta.issuer, 'https://nodered.example.com/mcp/docker');
        assert.strictEqual(meta.authorization_endpoint, 'https://idp.example.com/authorize');
        assert.strictEqual(meta.registration_endpoint, 'https://nodered.example.com/mcp/docker/oauth/register');
        assert.deepStrictEqual(meta.token_endpoint_auth_methods_supported, ['none']);
    });

    it('advertises client_secret_post when a client secret is configured', function () {
        const meta = buildAuthorizationServerMetadata({
            issuerBase: 'https://x', oidc: {}, registrationEndpoint: 'https://x/oauth/register',
            scopes: [], hasClientSecret: true
        });
        assert.deepStrictEqual(meta.token_endpoint_auth_methods_supported, ['client_secret_post', 'none']);
    });
});

describe('lib/oauth-discovery filterRedirectUris', function () {
    const allowed = ['https://claude.ai/api/mcp/auth_callback', 'https://other.example.com/cb'];

    it('allows a requested subset of the allowlist', function () {
        const r = filterRedirectUris(['https://claude.ai/api/mcp/auth_callback'], allowed);
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.uris, ['https://claude.ai/api/mcp/auth_callback']);
    });

    it('rejects when none of the requested URIs are allowed', function () {
        const r = filterRedirectUris(['https://evil.example.com/cb'], allowed);
        assert.strictEqual(r.ok, false);
        assert.deepStrictEqual(r.uris, []);
    });

    it('falls back to the full allowlist when no URIs were requested', function () {
        const r = filterRedirectUris([], allowed);
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.uris, allowed);
    });

    it('falls back to the full allowlist when redirect_uris is missing/not an array', function () {
        const r = filterRedirectUris(undefined, allowed);
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.uris, allowed);
    });
});

describe('lib/oauth-discovery buildDcrRegistration', function () {
    it('omits client_secret for a public client', function () {
        const reg = buildDcrRegistration({
            clientId: 'cid', clientSecret: '', redirectUris: ['https://x/cb'], scopeStr: 'openid profile'
        });
        assert.strictEqual(reg.client_id, 'cid');
        assert.strictEqual(reg.token_endpoint_auth_method, 'none');
        assert.ok(!('client_secret' in reg));
    });

    it('includes client_secret for a confidential client', function () {
        const reg = buildDcrRegistration({
            clientId: 'cid', clientSecret: 'shh', redirectUris: ['https://x/cb'], scopeStr: 'openid'
        });
        assert.strictEqual(reg.client_secret, 'shh');
        assert.strictEqual(reg.token_endpoint_auth_method, 'client_secret_post');
    });
});
