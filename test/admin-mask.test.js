'use strict';

const assert = require('node:assert');
const { createMasker, isSensitiveName, scrubUrl, containsMask } = require('../lib/admin/mask');

describe('lib/admin/mask', function () {
    it('recognises secret names, whole words only for the short ones', function () {
        for (const n of ['password', 'access_token', 'refreshToken', 'clientSecret', 'apiKey', 'api_key', 'key', 'auth', 'Authorization', 'cookie', 'sessionId'])
            assert.ok(isSensitiveName(n), n);
        for (const n of ['keepalive', 'author', 'authType', 'monkey', 'name', 'url', 'username', 'func', 'tokenCacheTTL', 'tokenType'])
            assert.ok(!isSensitiveName(n), n);
    });

    it('never masks numbers or flags, whatever they are called', function () {
        assert.deepStrictEqual(createMasker().value({ password: 0, secretEnabled: true, apiKey: null, token: 'abc' }),
            { password: 0, secretEnabled: true, apiKey: null, token: '«masked: 3 chars»' });
    });

    it('scrubs URL userinfo and sensitive query parameters, nothing else', function () {
        assert.strictEqual(scrubUrl('https://u:p@host/x'), 'https://masked@host/x');
        assert.strictEqual(scrubUrl('https://host/x?token=abc&q=1'), 'https://host/x?token=masked&q=1');
        assert.strictEqual(scrubUrl('https://host/x?q=1'), 'https://host/x?q=1');
        assert.strictEqual(scrubUrl('not a url'), 'not a url');
    });

    it('masks nested values by name and leaves structure and empty values alone', function () {
        const m = createMasker();
        assert.deepStrictEqual(m.value({ a: 1, tokens: { access_token: 'xyz', expires: 3 }, list: [{ password: 'p' }], password: '' }),
            { a: 1, tokens: '«masked»', list: [{ password: '«masked: 1 chars»' }], password: '' });
        assert.deepStrictEqual(m.node({ id: 'n', type: 'x', z: 't', wires: [['a']], secret: 's' }),
            { id: 'n', type: 'x', z: 't', wires: [['a']], secret: '«masked: 1 chars»' });
    });

    it('masks extra type.property entries, and passes everything through when disabled', function () {
        const n = { id: 'c', type: 'ical-config', url: 'https://cal/private-1/basic.ics', password: 'p' };
        assert.ok(createMasker({ extra: 'ical-config.url' }).node(n).url.startsWith('«masked'));
        assert.strictEqual(createMasker().node(n).url, n.url);
        assert.deepStrictEqual(createMasker({ enabled: false }).node(n), n);
        assert.strictEqual(createMasker().keyed('spotifyTokens', { a: 1 }), '«masked»');
    });

    it('finds a mask marker anywhere in a value about to be written', function () {
        assert.ok(containsMask({ a: { b: ['«masked: 3 chars»'] } }));
        assert.ok(!containsMask({ a: 'masked' }));
    });
});
