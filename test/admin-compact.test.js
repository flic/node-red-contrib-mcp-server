'use strict';

const assert = require('node:assert');
const { compactNode, summarize, flowView, nodeView, find } = require('../lib/admin/compact');
const { createMasker } = require('../lib/admin/mask');

const flows = () => [
    { id: 't1', type: 'tab', label: 'Main', disabled: false },
    { id: 't2', type: 'tab', label: 'Off', disabled: true },
    { id: 'sf', type: 'subflow', name: 'Helper' },
    { id: 's1', type: 'ftb-mcp-server', name: 'Srv', path: 'x' },
    { id: 'b1', type: 'mqtt-broker', broker: 'localhost' },
    { id: 'i1', type: 'ftb-mcp-in', z: 't1', x: 10, y: 20, mcpServer: 's1', wires: [['f1']] },
    { id: 'f1', type: 'function', z: 't1', x: 30, y: 20, name: 'Build', func: 'msg.url = "https://example.com/api";\nreturn msg;', wires: [[]] },
    { id: 'm1', type: 'mqtt in', z: 't2', broker: 'b1', mcpServer: '', wires: [[]] },
    { id: 'inst', type: 'subflow:sf', z: 't1', wires: [] },
    { id: 'n1', type: 'function', z: 'sf', func: '', wires: [] }
];

describe('lib/admin/compact', function () {
    it('drops geometry and z, empty outputs, and keeps empty values', function () {
        const n = compactNode(flows()[7]);
        assert.deepStrictEqual(n, { id: 'm1', type: 'mqtt in', broker: 'b1', mcpServer: '' });
        assert.deepStrictEqual(compactNode(flows()[5]).wires, [['f1']]);
    });

    it('summarizes tabs, subflows and config nodes with who uses them', function () {
        const s = summarize(flows());
        assert.deepStrictEqual(s.tabs, [
            { id: 't1', label: 'Main', disabled: false, nodes: 3 },
            { id: 't2', label: 'Off', disabled: true, nodes: 1 }]);
        assert.deepStrictEqual(s.subflows, [{ id: 'sf', name: 'Helper', nodes: 1, instances: 1 }]);
        assert.deepStrictEqual(s.configs, [
            { id: 's1', type: 'ftb-mcp-server', name: 'Srv', scope: 'global', usedByCount: 1, usedBy: ['i1'] },
            { id: 'b1', type: 'mqtt-broker', name: undefined, scope: 'global', usedByCount: 1, usedBy: ['m1'] }]);
    });

    it('lists config nodes scoped to a flow, and caps who uses them at ten ids', function () {
        const many = flows().concat({ id: 'loc', type: 'ftb-mcp-server', z: 't1', name: 'Local' },
            ...Array.from({ length: 12 }, (_, i) => ({ id: 'u' + i, type: 'ftb-mcp-in', z: 't1', x: 1, y: 1, mcpServer: 'loc', wires: [] })));
        const loc = summarize(many).configs.find(c => c.id === 'loc');
        assert.deepStrictEqual(loc.scope, { flow: 't1', label: 'Main' });
        assert.strictEqual(loc.usedByCount, 12);
        assert.strictEqual(loc.usedBy.length, 10);
        assert.strictEqual(loc.usedByMore, 2);
    });

    it('get_node keeps the flow but drops geometry, and masks secrets', function () {
        const f = flows().concat({ id: 'ic', type: 'ical-config', url: 'https://cal.example.com/private-abc/basic.ics', password: 'hunter2', username: 'me' });
        const masker = createMasker({ extra: 'ical-config.url' });
        const [fn, ic, missing] = nodeView(f, ['f1', 'ic', 'nope'], { masker });
        assert.strictEqual(fn.x, undefined);
        assert.strictEqual(fn.z, 't1');
        assert.deepStrictEqual(fn.flow, { id: 't1', label: 'Main' });
        assert.strictEqual(ic.password, '«masked: 7 chars»');
        assert.ok(ic.url.startsWith('«masked'));
        assert.strictEqual(ic.username, 'me');
        assert.deepStrictEqual(missing, { id: 'nope', error: 'not found' });
    });

    it('views one flow with pagination, and refuses an id that is not a flow', function () {
        const v = flowView(flows(), 't1', { offset: 0, limit: 2 });
        assert.strictEqual(v.total, 3);
        assert.deepStrictEqual(v.nodes.map(n => n.id), ['i1', 'f1']);
        assert.ok(v.more.includes('offset 2'));
        assert.strictEqual(flowView(flows(), 't1', { offset: 2, limit: 2 }).more, undefined);
        assert.strictEqual(flowView(flows(), 'f1'), null);
    });

    it('finds by text in any property with an excerpt, by type, by flow and by reference', function () {
        const [hit] = find(flows(), { text: 'EXAMPLE.com' }).results;
        assert.strictEqual(hit.id, 'f1');
        assert.strictEqual(hit.match.property, 'func');
        assert.ok(hit.match.excerpt.includes('example.com'));
        assert.deepStrictEqual(hit.flow, { id: 't1', label: 'Main' });
        const ids = q => find(flows(), q).results.map(h => h.id);
        assert.deepStrictEqual(ids({ type: 'function', flow: 'sf' }), ['n1']);
        assert.deepStrictEqual(ids({ references: 's1' }), ['i1']);
        assert.deepStrictEqual(ids({ references: 'sf' }), ['inst']);
    });

    it('does not match ids, names tabs by label, and pages with a total', function () {
        const f = flows().concat({ id: 'tts-c1', type: 'function', z: 't1', func: '', wires: [] });
        assert.deepStrictEqual(find(f, { text: 'tts' }).results, []);
        assert.strictEqual(find(f, { type: 'tab' }).results[0].name, 'Main');
        const page = find(f, { type: 'function', limit: 1 });
        assert.strictEqual(page.total, 3);
        assert.strictEqual(page.results.length, 1);
        assert.ok(page.more.includes('offset 1'));
        assert.strictEqual(find(f, { type: 'function', offset: 2, limit: 1 }).more, undefined);
    });

    it('answers a hit inside a secret with where, not what', function () {
        const f = [{ id: 'h1', type: 'http request', z: 't', token: 'abc-secret-xyz' }, { id: 't', type: 'tab', label: 'T' }];
        const [hit] = find(f, { text: 'secret', masker: createMasker() }).results;
        assert.strictEqual(hit.match.property, 'token');
        assert.ok(!hit.match.excerpt.includes('abc'));
    });
});
