'use strict';

const assert = require('node:assert');
const { createAdminApi, AdminApiError } = require('../lib/admin/api');

function build(answer, opts = {}) {
    const calls = [];
    const api = createAdminApi(Object.assign({
        port: 1880, root: '/editor', getToken: () => 'tok',
        httpRequest: async req => { calls.push(req); return answer(req); }
    }, opts));
    return { api, calls };
}

describe('lib/admin/api', function () {
    it('calls loopback under httpAdminRoot with the token and API v2', async function () {
        const { api, calls } = build(() => ({ status: 200, body: { rev: 'r1', flows: [] } }));
        assert.deepStrictEqual(await api.getFlows(), { rev: 'r1', flows: [] });
        assert.strictEqual(calls[0].host, '127.0.0.1');
        assert.strictEqual(calls[0].path, '/editor/flows');
        assert.strictEqual(calls[0].headers.Authorization, 'Bearer tok');
        assert.strictEqual(calls[0].headers['Node-RED-API-Version'], 'v2');
    });

    it('posts flows with the revision and the deployment type', async function () {
        const { api, calls } = build(() => ({ status: 200, body: { rev: 'r2' } }));
        assert.deepStrictEqual(await api.postFlows('r1', [{ id: 'a' }], 'flows'), { rev: 'r2' });
        assert.deepStrictEqual(calls[0].body, { rev: 'r1', flows: [{ id: 'a' }] });
        assert.strictEqual(calls[0].headers['Node-RED-Deployment-Type'], 'flows');
    });

    it('names the missing permission on 401 and 403, and marks 409 as a conflict', async function () {
        const forbidden = build(() => ({ status: 403, body: { error: 'unauthorized' } })).api;
        await assert.rejects(forbidden.postFlows('r1', []), e => e.status === 403 && e.message.includes('flows.write'));
        const unknown = build(() => ({ status: 401, body: {} })).api;
        await assert.rejects(unknown.postFlows('r1', []), e => e.status === 401 && e.message.includes('flows.write'));
        await assert.rejects(forbidden.getContext('global'), e => e.message.includes('context.read'));
        const conflict = build(() => ({ status: 409, body: {} })).api;
        await assert.rejects(conflict.postFlows('r1', []), e => e instanceof AdminApiError && e.status === 409);
    });

    it('refuses ids outside the Node-RED charset before any request', async function () {
        const { api, calls } = build(() => ({ status: 200, body: {} }));
        await assert.rejects(api.inject('../flows'), /Invalid inject node id/);
        await assert.rejects(api.getContext('node', 'a/b'), /Invalid node id/);
        assert.strictEqual(calls.length, 0);
    });

    it('encodes context keys and the store', async function () {
        const { api, calls } = build(() => ({ status: 200, body: {} }));
        await api.deleteContext('flow', 't1', 'a b/c', 'file');
        assert.strictEqual(calls[0].path, '/editor/context/flow/t1/a%20b%2Fc?store=file');
        await api.getContext('global');
        assert.strictEqual(calls[1].path, '/editor/context/global');
    });

    it('works at the root and refuses when the admin API is disabled', async function () {
        const { api, calls } = build(() => ({ status: 200, body: [] }), { root: '/' });
        await api.getNodes();
        assert.strictEqual(calls[0].path, '/nodes');
        const off = build(() => ({ status: 200, body: [] }), { root: false }).api;
        await assert.rejects(off.getFlows(), /disabled/);
    });

    it('reports an unreachable admin API with host and port', async function () {
        const { api } = build(() => { throw new Error('ECONNREFUSED'); });
        await assert.rejects(api.getFlows(), e => e.message.includes('127.0.0.1:1880') && e.message.includes('ECONNREFUSED'));
    });
});
