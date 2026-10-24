'use strict';
// The admin tools against a fake admin API that behaves like Node-RED's: GET /flows answers the
// deployed configuration and its revision, POST /flows deploys only on a matching revision.

const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { GROUPS, runTool } = require('../lib/admin/tools');
const { AdminApiError } = require('../lib/admin/api');
const { createSnapshotStore } = require('../lib/admin/snapshots');

const tool = name => Object.values(GROUPS).flat().find(t => t.name === name);

function fakeRuntime(flows) {
    const state = { flows: structuredClone(flows), rev: 'r1', n: 1, posts: [], injected: [], deleted: [] };
    const api = {
        getFlows: async () => ({ rev: state.rev, flows: structuredClone(state.flows) }),
        postFlows: async (rev, next, type) => {
            if (rev !== state.rev) throw new AdminApiError(409, 'The flows changed since they were read.');
            state.posts.push({ rev, type, flows: next });
            state.flows = structuredClone(next);
            state.rev = 'r' + (++state.n);
            return { rev: state.rev };
        },
        getNodes: async () => [{ types: ['inject', 'debug', 'function', 'ftb-mcp-server', 'ftb-mcp-in', 'ftb-mcp-out'] }],
        inject: async (id, body) => { state.injected.push({ id, body }); },
        deleteContext: async (...a) => { state.deleted.push(a); },
        // Shaped like Node-RED's: { store: { key: { msg, format } } }, a single value with ?store.
        getContext: async (scope, id, key, store) => {
            const all = { memory: { a: { msg: '1', format: 'number' }, spotifyTokens: { msg: '{"access_token":"x"}', format: 'Object' } },
                filesystem: { pollen: { msg: '{"high":[],"apiKey":"k"}', format: 'Object' },
                    weather: { msg: JSON.stringify({ current: { temp: 11.25 }, forecast: Array.from({ length: 300 }, (_, i) => ({ h: i, t: 10 })) }), format: 'Object' } } };
            if (!key) return all;
            const e = all[store || 'memory'][key];
            return e ? { ...e, store } : { msg: '(undefined)', format: 'undefined' };
        }
    };
    return { api, state };
}

const deployed = () => [
    { id: 't1', type: 'tab', label: 'Main' },
    { id: 's1', type: 'ftb-mcp-server', path: 'x' },
    { id: 'in', type: 'inject', z: 't1', wires: [['f1']] },
    { id: 'f1', type: 'function', z: 't1', func: 'return msg;', wires: [['d1']] },
    { id: 'd1', type: 'debug', z: 't1', wires: [] },
    { id: 'i1', type: 'ftb-mcp-in', z: 't1', mcpServer: 's1', wires: [['o1']] },
    { id: 'o1', type: 'ftb-mcp-out', z: 't1', mcpServer: 's1', wires: [] }
];

describe('lib/admin/tools', function () {
    let dir, events, ctx, state;
    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-admin-'));
        events = [];
        const rt = fakeRuntime(deployed());
        state = rt.state;
        ctx = { api: rt.api, snapshots: createSnapshotStore({ dir, keep: 5 }), emit: e => events.push(e),
            claims: { sub: 'user-1', azp: 'client-1' } };
    });
    afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

    it('marks exactly the tools that change something as write tools', function () {
        const writes = Object.values(GROUPS).flat().filter(t => t.write).map(t => t.name).sort();
        assert.deepStrictEqual(writes, ['add_nodes', 'create_flow', 'delete_context', 'delete_flow', 'inject',
            'patch_nodes', 'remove_nodes', 'rollback', 'set_flow_enabled']);
        for (const t of GROUPS.read) assert.ok(!t.write, t.name);
    });

    it('patch_nodes changes only the named properties and deploys with the read revision', async function () {
        const out = await runTool(tool('patch_nodes'), { patches: [{ id: 'f1', set: { func: 'return null;' } }] }, ctx);
        assert.strictEqual(out.ok, true, JSON.stringify(out));
        assert.strictEqual(out.deployed, true);
        assert.deepStrictEqual(out.changed, { added: [], removed: [], modified: ['f1'] });
        assert.strictEqual(state.posts[0].rev, 'r1');
        assert.strictEqual(state.posts[0].type, 'nodes');
        const f1 = state.flows.find(n => n.id === 'f1');
        assert.deepStrictEqual(f1, { id: 'f1', type: 'function', z: 't1', func: 'return null;', wires: [['d1']] });
        assert.strictEqual(events[0].event, 'deployed');
        assert.strictEqual(events[0].sub, 'user-1');
        assert.strictEqual(events[0].client, 'client-1');
        assert.strictEqual(events[0].snapshot, out.snapshot);
    });

    it('names the instance in answers and events when one is set', async function () {
        ctx.instance = { name: 'Hemma', description: 'home automation' };
        const out = await runTool(tool('patch_nodes'), { patches: [{ id: 'f1', set: { name: 'x' } }] }, ctx);
        assert.strictEqual(out.instance, 'Hemma');
        assert.strictEqual(events[0].instance, 'Hemma');
        assert.strictEqual((await runTool(tool('patch_nodes'), { dry_run: true, patches: [{ id: 'f1', set: { name: 'y' } }] }, ctx)).instance, 'Hemma');
    });

    it('refuses a patch that empties a config reference, deploying nothing', async function () {
        const out = await runTool(tool('patch_nodes'), { patches: [{ id: 'i1', set: { mcpServer: '' } }] }, ctx);
        assert.strictEqual(out.ok, false);
        assert.ok(out.errors[0].includes('mcpServer'));
        assert.strictEqual(state.posts.length, 0);
        assert.strictEqual(ctx.snapshots.list().length, 0);
        assert.strictEqual(events[0].event, 'rejected');
        assert.strictEqual(events[0].reason, 'validation');
    });

    it('refuses to change an id, and names a missing node', async function () {
        assert.ok((await runTool(tool('patch_nodes'), { patches: [{ id: 'f1', set: { id: 'x' } }] }, ctx)).error.includes('id cannot'));
        assert.ok((await runTool(tool('patch_nodes'), { patches: [{ id: 'zz', set: {} }] }, ctx)).error.includes('zz'));
    });

    it('a dry run validates and reports without deploying or snapshotting', async function () {
        const out = await runTool(tool('patch_nodes'), { dry_run: true, patches: [{ id: 'f1', set: { name: 'x' } }] }, ctx);
        assert.strictEqual(out.dry_run, true);
        assert.deepStrictEqual(out.changed.modified, ['f1']);
        assert.strictEqual(state.posts.length, 0);
        assert.strictEqual(ctx.snapshots.list().length, 0);
    });

    it('reports a conflict when someone deployed since the read, and keeps no snapshot', async function () {
        const real = ctx.api.getFlows;
        ctx.api.getFlows = async () => { const r = await real(); state.rev = 'moved-on'; return r; };
        const out = await runTool(tool('patch_nodes'), { patches: [{ id: 'f1', set: { name: 'x' } }] }, ctx);
        assert.strictEqual(out.conflict, true);
        assert.strictEqual(ctx.snapshots.list().length, 0);
        assert.strictEqual(events[0].reason, 'conflict');
    });

    it('add_nodes places nodes on the flow and refuses a taken id', async function () {
        const out = await runTool(tool('add_nodes'), { flow: 't1', nodes: [{ id: 'n2', type: 'debug', wires: [] }] }, ctx);
        assert.strictEqual(out.ok, true, JSON.stringify(out));
        assert.strictEqual(state.flows.find(n => n.id === 'n2').z, 't1');
        assert.ok((await runTool(tool('add_nodes'), { nodes: [{ id: 'f1', type: 'debug' }] }, ctx)).error.includes('in use'));
        assert.ok((await runTool(tool('add_nodes'), { flow: 'f1', nodes: [{ type: 'debug' }] }, ctx)).error.includes('No tab'));
    });

    it('remove_nodes drops wires into removed nodes, and refuses removing a config node in use', async function () {
        const out = await runTool(tool('remove_nodes'), { ids: ['d1'] }, ctx);
        assert.strictEqual(out.ok, true, JSON.stringify(out));
        assert.deepStrictEqual(state.flows.find(n => n.id === 'f1').wires, [[]]);
        const refused = await runTool(tool('remove_nodes'), { ids: ['s1'] }, ctx);
        assert.strictEqual(refused.ok, false);
        assert.ok((await runTool(tool('remove_nodes'), { ids: ['t1'] }, ctx)).error.includes('delete_flow'));
    });

    it('create_flow and delete_flow round-trip, deleting with deployment type flows', async function () {
        const created = await runTool(tool('create_flow'), { label: 'New', nodes: [{ id: 'q1', type: 'debug', wires: [] }] }, ctx);
        assert.strictEqual(created.ok, true, JSON.stringify(created));
        const tabId = created.changed.added.find(id => id !== 'q1');
        assert.strictEqual(state.flows.find(n => n.id === 'q1').z, tabId);
        const deleted = await runTool(tool('delete_flow'), { id: tabId }, ctx);
        assert.strictEqual(deleted.ok, true, JSON.stringify(deleted));
        assert.ok(!state.flows.some(n => n.id === tabId || n.id === 'q1'));
        assert.strictEqual(state.posts[1].type, 'flows');
    });

    it('set_flow_enabled toggles a tab and only a tab', async function () {
        await runTool(tool('set_flow_enabled'), { id: 't1', enabled: false }, ctx);
        assert.strictEqual(state.flows.find(n => n.id === 't1').disabled, true);
        assert.ok((await runTool(tool('set_flow_enabled'), { id: 'f1', enabled: true }, ctx)).error);
    });

    it('rollback restores a snapshot with a full deploy, and snapshots the state it replaces', async function () {
        const first = await runTool(tool('patch_nodes'), { patches: [{ id: 'f1', set: { name: 'changed' } }] }, ctx);
        const out = await runTool(tool('rollback'), { snapshot: first.snapshot }, ctx);
        assert.strictEqual(out.ok, true, JSON.stringify(out));
        assert.strictEqual(state.flows.find(n => n.id === 'f1').name, undefined);
        assert.strictEqual(state.posts[1].type, 'nodes');
        assert.strictEqual(ctx.snapshots.list().length, 2);
        assert.ok((await runTool(tool('rollback'), { snapshot: 'nope' }, ctx)).error.includes('list_snapshots'));
    });

    it('refuses to change or remove the MCP server the tools are served by', async function () {
        ctx.serverId = 's1';
        const patched = await runTool(tool('patch_nodes'), { patches: [{ id: 's1', set: { path: 'y' } }] }, ctx);
        assert.strictEqual(patched.ok, false);
        assert.ok(patched.errors[0].includes('served by'));
        // Changing other nodes stays possible, including ones that use the server.
        const other = await runTool(tool('patch_nodes'), { patches: [{ id: 'i1', set: { name: 'x' } }] }, ctx);
        assert.strictEqual(other.ok, true, JSON.stringify(other));
        assert.strictEqual(state.posts.length, 1);
        assert.strictEqual(events[0].event, 'rejected');
        assert.strictEqual(events[0].reason, 'own-server');
    });

    it('refuses a write whose expected_rev is stale, before changing anything', async function () {
        const read = await runTool(tool('list_flows'), {}, ctx);
        assert.strictEqual(read.rev, 'r1');
        const ok = await runTool(tool('patch_nodes'), { expected_rev: 'r1', patches: [{ id: 'f1', set: { name: 'a' } }] }, ctx);
        assert.strictEqual(ok.ok, true, JSON.stringify(ok));
        const stale = await runTool(tool('patch_nodes'), { expected_rev: 'r1', patches: [{ id: 'd1', set: { name: 'b' } }] }, ctx);
        assert.strictEqual(stale.ok, false);
        assert.strictEqual(stale.conflict, true);
        assert.strictEqual(stale.rev, 'r2');
        assert.strictEqual(state.posts.length, 1);
    });

    it('answers every refusal as ok false with error, and keeps dry runs off the changes output', async function () {
        const invalid = await runTool(tool('patch_nodes'), { dry_run: true, patches: [{ id: 'i1', set: { mcpServer: '' } }] }, ctx);
        assert.strictEqual(invalid.ok, false);
        assert.ok(invalid.error.startsWith('Refused'));
        assert.ok(invalid.errors.length && invalid.dry_run === true);
        assert.strictEqual(events.length, 0);
        const missing = await runTool(tool('patch_nodes'), { patches: [{ id: 'zz', set: {} }] }, ctx);
        assert.deepStrictEqual(Object.keys(missing).sort(), ['error', 'ok']);
    });

    it('lets create_flow take its id, so a dry run and the real call agree', async function () {
        const dry = await runTool(tool('create_flow'), { id: 'abcdef0123456789', label: 'X', dry_run: true }, ctx);
        const real = await runTool(tool('create_flow'), { id: 'abcdef0123456789', label: 'X' }, ctx);
        assert.deepStrictEqual(dry.changed.added, ['abcdef0123456789']);
        assert.deepStrictEqual(real.changed.added, ['abcdef0123456789']);
        assert.ok((await runTool(tool('create_flow'), { id: '../x', label: 'Y' }, ctx)).error.includes('Invalid tab id'));
    });

    it('explains an inject that cannot run: no node, not an inject, disabled, on a disabled tab', async function () {
        assert.ok((await runTool(tool('inject'), { id: 'gone' }, ctx)).error.startsWith('No node'));
        assert.ok((await runTool(tool('inject'), { id: 'f1' }, ctx)).error.includes('function node, not an inject'));
        await runTool(tool('set_flow_enabled'), { id: 't1', enabled: false }, ctx);
        assert.ok((await runTool(tool('inject'), { id: 'in' }, ctx)).error.includes('disabled tab'));
        await runTool(tool('set_flow_enabled'), { id: 't1', enabled: true }, ctx);
        await runTool(tool('patch_nodes'), { patches: [{ id: 'in', set: { d: true } }] }, ctx);
        assert.ok((await runTool(tool('inject'), { id: 'in' }, ctx)).error.includes('is disabled'));
        assert.strictEqual(state.injected.length, 0);
    });

    it('answers "nothing changed" without deploying', async function () {
        const out = await runTool(tool('patch_nodes'), { patches: [{ id: 'f1', set: { func: 'return msg;' } }] }, ctx);
        assert.strictEqual(out.deployed, false);
        assert.strictEqual(state.posts.length, 0);
    });

    it('inject only presses inject nodes, translating props', async function () {
        const out = await runTool(tool('inject'), { id: 'in', props: { payload: { a: 1 }, topic: 't', n: 2 } }, ctx);
        assert.strictEqual(out.ok, true);
        assert.deepStrictEqual(state.injected[0].body.__user_inject_props__, [
            { p: 'payload', v: '{"a":1}', vt: 'json' }, { p: 'topic', v: 't', vt: 'str' }, { p: 'n', v: '2', vt: 'num' }]);
        assert.ok((await runTool(tool('inject'), { id: 'f1' }, ctx)).error.includes('not an inject node'));
        assert.strictEqual(events[0].event, 'injected');
    });

    it('checks context targets: an id is required and must name a flow or a node', async function () {
        assert.ok((await runTool(tool('get_context'), { scope: 'flow' }, ctx)).error.includes('id is required'));
        assert.ok((await runTool(tool('get_context'), { scope: 'flow', id: 'f1' }, ctx)).error.includes('No tab'));
        assert.ok((await runTool(tool('get_context'), { scope: 'node', id: 'gone' }, ctx)).error.includes('No node'));
        await runTool(tool('delete_context'), { scope: 'node', id: 'f1', key: 'a', store: 'memory' }, ctx);
        assert.deepStrictEqual(state.deleted[0], ['node', 'f1', 'a', 'memory']);
    });

    it('refuses to delete a context key that does not exist, saying where it is if elsewhere', async function () {
        const missing = await runTool(tool('delete_context'), { scope: 'global', key: 'nope' }, ctx);
        assert.strictEqual(missing.ok, false);
        assert.ok(missing.error.includes('Nothing was deleted'));
        const wrongStore = await runTool(tool('delete_context'), { scope: 'global', key: 'pollen', store: 'memory' }, ctx);
        assert.ok(wrongStore.error.includes('it is in: filesystem'), wrongStore.error);
        assert.strictEqual(state.deleted.length, 0);
    });

    it('lists context keys without values, and finds a key in whichever store holds it', async function () {
        ctx.masker = require('../lib/admin/mask').createMasker();
        const listing = await runTool(tool('get_context'), { scope: 'global' }, ctx);
        assert.deepStrictEqual(listing.stores.filesystem[0], { key: 'pollen', format: 'Object', size: 24 });
        assert.ok(!JSON.stringify(listing).includes('access_token'));
        const pollen = await runTool(tool('get_context'), { scope: 'global', key: 'pollen' }, ctx);
        assert.strictEqual(pollen.store, 'filesystem');
        assert.deepStrictEqual(pollen.value, { high: [], apiKey: '«masked: 1 chars»' });
        const tokens = await runTool(tool('get_context'), { scope: 'global', key: 'spotifyTokens' }, ctx);
        assert.strictEqual(tokens.value, '«masked»');
        assert.ok((await runTool(tool('get_context'), { scope: 'global', key: 'missing' }, ctx)).error.includes('No key'));
    });

    it('answers a value too long to send whole as its keys, or whole with a higher max_chars', async function () {
        const short = await runTool(tool('get_context'), { scope: 'global', key: 'weather' }, ctx);
        assert.strictEqual(short.value, undefined);
        assert.deepStrictEqual(short.keys.map(k => [k.key, k.type]), [['current', 'object'], ['forecast', 'array[300]']]);
        assert.ok(short.note.includes('"<key>.<part>"'));
        const whole = await runTool(tool('get_context'), { scope: 'global', key: 'weather', max_chars: 50000 }, ctx);
        assert.strictEqual(whole.value.current.temp, 11.25);
    });

    it('refuses to write a masked value back', async function () {
        const out = await runTool(tool('patch_nodes'), { patches: [{ id: 'f1', set: { token: '«masked: 12 chars»' } }] }, ctx);
        assert.ok(out.error && out.error.includes('masked'), JSON.stringify(out));
        assert.strictEqual(state.posts.length, 0);
    });

    it('rejects a since that is not a time', async function () {
        ctx.debug = { status: () => ({}), query: () => [] };
        assert.ok((await runTool(tool('get_debug'), { since: 'inte-ett-datum' }, ctx)).error.includes('ISO time'));
        assert.deepStrictEqual((await runTool(tool('get_debug'), { since: '2026-10-24T10:00:00Z' }, ctx)).messages, []);
    });

    it('turns admin API failures into a readable error', async function () {
        ctx.api.getFlows = async () => { throw new AdminApiError(403, 'The admin token lacks the "flows.read" permission.'); };
        assert.deepStrictEqual(await runTool(tool('list_flows'), {}, ctx),
            { ok: false, error: 'The admin token lacks the "flows.read" permission.' });
    });
});
