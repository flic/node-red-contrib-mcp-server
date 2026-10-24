'use strict';

const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSnapshotStore } = require('../lib/admin/snapshots');
const { createDebugBuffer } = require('../lib/admin/comms');

describe('lib/admin/snapshots', function () {
    let dir;
    beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-snap-')); });
    afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

    it('saves, lists newest first without flows, and loads', function () {
        const store = createSnapshotStore({ dir: path.join(dir, 'n1'), keep: 5 });
        const a = store.save({ rev: 'r1', flows: [{ id: 'x' }], meta: { tool: 'patch_nodes', sub: 'u' } });
        const b = store.save({ rev: 'r2', flows: [], meta: { tool: 'rollback' } });
        const list = store.list();
        assert.deepStrictEqual(list.map(s => s.id), [b, a].sort().reverse());
        assert.strictEqual(list.find(s => s.id === a).tool, 'patch_nodes');
        assert.strictEqual(list.find(s => s.id === a).nodes, 1);
        assert.ok(!('flows' in list[0]));
        assert.deepStrictEqual(store.load(a).flows, [{ id: 'x' }]);
    });

    it('keeps only the newest `keep`', function () {
        const store = createSnapshotStore({ dir, keep: 2 });
        const ids = [1, 2, 3].map(i => store.save({ rev: 'r' + i, flows: [] }));
        assert.deepStrictEqual(store.list().map(s => s.rev).sort(), ['r2', 'r3']);
        assert.strictEqual(store.load(ids[0]), null);
    });

    it('never loads or removes outside its own id format', function () {
        const store = createSnapshotStore({ dir });
        fs.writeFileSync(path.join(dir, 'evil.json'), '{}');
        assert.strictEqual(store.load('../evil'), null);
        assert.strictEqual(store.load('evil'), null);
        store.remove('evil');
        assert.ok(fs.existsSync(path.join(dir, 'evil.json')));
        assert.deepStrictEqual(store.list(), []);
    });
});

describe('lib/admin/comms', function () {
    // A socket that records what was sent and lets the test play the server.
    function fakeSocketClass() {
        const sockets = [];
        class FakeSocket {
            constructor(url) { this.url = url; this.sent = []; sockets.push(this); setImmediate(() => this.onopen && this.onopen()); }
            send(d) { this.sent.push(JSON.parse(d)); }
            close() { this.closed = true; }
            serve(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
        }
        return { FakeSocket, sockets };
    }
    const tick = () => new Promise(r => setImmediate(r));

    it('authenticates, subscribes to debug and buffers batches by level', async function () {
        const { FakeSocket, sockets } = fakeSocketClass();
        const buf = createDebugBuffer({ url: 'ws://127.0.0.1:1880/editor/comms', getToken: () => 'tok', WebSocketImpl: FakeSocket });
        buf.start();
        await tick();
        const ws = sockets[0];
        assert.deepStrictEqual(ws.sent, [{ auth: 'tok' }]);
        ws.serve({ auth: 'ok' });
        assert.deepStrictEqual(ws.sent[1], { subscribe: 'debug' });
        ws.serve([
            { topic: 'debug', data: { id: 'd1', z: 't1', msg: '"hi"', format: 'string[2]' } },
            { topic: 'debug', data: { id: 'f1', z: 't1', level: 30, msg: 'careful' } },
            { topic: 'status/x', data: {} }
        ]);
        assert.deepStrictEqual(buf.query().map(e => [e.id, e.level]), [['d1', 'debug'], ['f1', 'warn']]);
        assert.deepStrictEqual(buf.query({ level: 'warn' }).map(e => e.id), ['f1']);
        assert.deepStrictEqual(buf.query({ node: 'd1' }).map(e => e.msg), ['"hi"']);
        assert.strictEqual(buf.status().connected, true);
        buf.stop();
        assert.strictEqual(ws.closed, true);
    });

    it('reports a refused token instead of buffering nothing silently', async function () {
        const { FakeSocket, sockets } = fakeSocketClass();
        const buf = createDebugBuffer({ url: 'ws://x', getToken: () => 'bad', WebSocketImpl: FakeSocket });
        buf.start(); await tick();
        sockets[0].serve({ auth: 'fail' });
        assert.ok(buf.status().error.includes('status.read'));
        buf.stop();
    });

    it('caps the buffer and long messages', function () {
        const buf = createDebugBuffer({ url: 'ws://x', size: 3, WebSocketImpl: null });
        for (let i = 0; i < 5; i++) buf._push({ id: 'n' + i, msg: 'x'.repeat(i === 4 ? 5000 : 1) });
        const all = buf.query({ limit: 10 });
        assert.deepStrictEqual(all.map(e => e.id), ['n2', 'n3', 'n4']);
        assert.ok(all[2].msg.length < 2100 && all[2].msg.includes('5000 chars'));
    });

    it('says why there is nothing when no WebSocket implementation exists', function () {
        const buf = createDebugBuffer({ url: 'ws://x', WebSocketImpl: undefined });
        // globalThis.WebSocket is the default; force its absence explicitly.
        const buf2 = createDebugBuffer({ url: 'ws://x', WebSocketImpl: 'none' });
        buf2.start();
        assert.ok(buf2.status().error.includes('Node.js 22'));
        buf.stop(); buf2.stop();
    });
});
