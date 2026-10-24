'use strict';

const assert = require('node:assert');
const { LEGACY_TYPES, migrateFlows } = require('../resources/migrate');

describe('resources/migrate', function () {
    it('renames every 2.x type to its ftb- counterpart and reports the ids', function () {
        const flows = [
            { id: 't1', type: 'tab', label: 'Tab' },
            { id: 's1', type: 'mcp-server', path: 'x' },
            { id: 'i1', type: 'mcp-in', z: 't1', mcpServer: 's1', wires: [['o1']] },
            { id: 'o1', type: 'mcp-out', z: 't1', mcpServer: 's1', wires: [] },
            { id: 'c1', type: 'mcp-call', z: 't1', mcpServer: 's1', wires: [[]] },
            { id: 'f1', type: 'function', z: 't1', wires: [[]] }
        ];
        const { flows: out, changed } = migrateFlows(flows);
        assert.deepStrictEqual(changed, ['s1', 'i1', 'o1', 'c1']);
        assert.deepStrictEqual(out.map(n => n.type),
            ['tab', 'ftb-mcp-server', 'ftb-mcp-in', 'ftb-mcp-out', 'ftb-mcp-call', 'function']);
    });

    it('keeps ids and every other property, so wires and config references still resolve', function () {
        const node = { id: 'i1', type: 'mcp-in', z: 't1', mcpServer: 's1', toolName: 't', wires: [['o1']] };
        const [out] = migrateFlows([node]).flows;
        assert.deepStrictEqual(out, Object.assign({}, node, { type: 'ftb-mcp-in' }));
    });

    it('does not mutate its input', function () {
        const node = { id: 's1', type: 'mcp-server' };
        migrateFlows([node]);
        assert.strictEqual(node.type, 'mcp-server');
    });

    it('changes nothing in flows that are already converted', function () {
        const flows = [{ id: 's1', type: 'ftb-mcp-server' }, { id: 'i1', type: 'ftb-mcp-in' }];
        const { flows: out, changed } = migrateFlows(flows);
        assert.deepStrictEqual(changed, []);
        assert.deepStrictEqual(out, flows);
    });

    it('does not resolve inherited names as legacy types', function () {
        const { changed } = migrateFlows([{ id: 'x', type: 'constructor' }, { id: 'y', type: '__proto__' }]);
        assert.deepStrictEqual(changed, []);
    });

    it('maps exactly the four 2.x node types', function () {
        assert.deepStrictEqual(Object.keys(LEGACY_TYPES).sort(),
            ['mcp-call', 'mcp-in', 'mcp-out', 'mcp-server']);
    });
});
