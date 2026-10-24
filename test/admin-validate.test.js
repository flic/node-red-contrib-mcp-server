'use strict';

const assert = require('node:assert');
const { validate, knownTypesFrom } = require('../lib/admin/validate');

const base = () => [
    { id: 't1', type: 'tab', label: 'Tab' },
    { id: 's1', type: 'ftb-mcp-server', path: 'x' },
    { id: 'i1', type: 'ftb-mcp-in', z: 't1', mcpServer: 's1', wires: [['f1']] },
    { id: 'f1', type: 'function', z: 't1', func: 'return msg;', wires: [['o1']] },
    { id: 'o1', type: 'ftb-mcp-out', z: 't1', mcpServer: 's1', wires: [] }
];
const known = new Set(['ftb-mcp-server', 'ftb-mcp-in', 'ftb-mcp-out', 'function', 'inject', 'debug']);

describe('lib/admin/validate', function () {
    it('accepts a consistent configuration', function () {
        assert.deepStrictEqual(validate(base(), base(), { knownTypes: known }), { errors: [], warnings: [] });
    });

    it('refuses a config reference a patch emptied — the mcpServer: "" case', function () {
        const after = base(); after[2].mcpServer = '';
        const { errors } = validate(base(), after, { knownTypes: known });
        assert.strictEqual(errors.length, 1);
        assert.ok(/i1 .*"mcpServer" referred to s1 and is now empty/.test(errors[0]), errors[0]);
    });

    it('refuses a dropped reference property and one aimed at a missing id', function () {
        const dropped = base(); delete dropped[2].mcpServer;
        assert.strictEqual(validate(base(), dropped).errors.length, 1);
        const missing = base(); missing[2].mcpServer = 'nope';
        assert.ok(validate(base(), missing).errors[0].includes('"nope"'));
    });

    it('allows re-pointing a reference at another existing node', function () {
        const after = base().concat({ id: 's2', type: 'ftb-mcp-server', path: 'y' });
        after[2].mcpServer = 's2';
        assert.deepStrictEqual(validate(base(), after, { knownTypes: known }).errors, []);
    });

    it('refuses removing a config node that is still used, naming once per broken reference', function () {
        const after = base().filter(n => n.id !== 's1');
        const { errors } = validate(base(), after);
        assert.strictEqual(errors.length, 2);   // i1 and o1, not duplicated by the removal check
        assert.ok(errors.every(e => e.includes('refers to s1, which this change removes')), errors.join('\n'));
    });

    it('refuses a new node pointing at a node this change removed', function () {
        const after = base().filter(n => n.id !== 's1')
            .map(n => { const c = { ...n }; delete c.mcpServer; return c; });
        after.push({ id: 'c1', type: 'ftb-mcp-out', z: 't1', mcpServer: 's1', wires: [] });
        const { errors } = validate(base(), after);
        assert.ok(errors.some(e => e.includes('s1') && e.includes('c1')), errors.join('\n'));
    });

    it('refuses wires and links into nothing', function () {
        const after = base(); after[3].wires = [['o1', 'ghost']];
        after.push({ id: 'l1', type: 'link out', z: 't1', links: ['gone'], wires: [] });
        const { errors } = validate(base(), after, { knownTypes: new Set([...known, 'link out']) });
        assert.ok(errors.some(e => e.includes('wired to ghost')));
        assert.ok(errors.some(e => e.includes('links to gone')));
    });

    it('refuses malformed wires', function () {
        const after = base(); after[3].wires = ['o1'];
        assert.ok(validate(base(), after).errors[0].includes('malformed wires'));
    });

    it('refuses a node on a flow that is not a tab or subflow, and a missing group', function () {
        const after = base(); after[3].z = 'i1'; after[4].g = 'nogroup';
        const { errors } = validate(base(), after);
        assert.ok(errors.some(e => e.includes('not a tab or subflow')));
        assert.ok(errors.some(e => e.includes('group nogroup')));
    });

    it('refuses duplicate ids and nodes without id or type', function () {
        const after = base().concat({ id: 'f1', type: 'function', z: 't1' }, { type: 'x' }, { id: 'n' });
        const { errors } = validate(base(), after);
        assert.ok(errors.some(e => e.includes('Duplicate id f1')));
        assert.ok(errors.some(e => e.includes('without an id')));
        assert.ok(errors.some(e => e.includes('n has no type')));
    });

    it('refuses an unknown new type but only warns about one already deployed', function () {
        const before = base().concat({ id: 'u1', type: 'legacy-thing', z: 't1' });
        const after = before.concat({ id: 'u2', type: 'brand-new', z: 't1' });
        const { errors, warnings } = validate(before, after, { knownTypes: known });
        assert.ok(errors.some(e => e.includes('u2') && e.includes('does not know')));
        assert.ok(warnings.some(w => w.includes('u1')));
    });

    it('accepts subflow instances of a subflow in the configuration, refuses orphans', function () {
        const after = base().concat(
            { id: 'sf', type: 'subflow', name: 'Sub' },
            { id: 'si', type: 'subflow:sf', z: 't1', wires: [] },
            { id: 'so', type: 'subflow:gone', z: 't1', wires: [] });
        const { errors } = validate(base(), after, { knownTypes: known });
        assert.strictEqual(errors.length, 1);
        assert.ok(errors[0].includes('so') && errors[0].includes('subflow that does not exist'));
    });

    it('skips the type check without knownTypes, and does not blame pre-existing breakage', function () {
        const broken = base(); broken[2].mcpServer = 'already-gone';
        assert.deepStrictEqual(validate(broken, broken).errors, []);
    });

    it('builds the known types from GET /nodes, leaving disabled sets out', function () {
        const t = knownTypesFrom([{ types: ['a', 'b'] }, { types: ['c'], enabled: false }, { types: [] }]);
        assert.deepStrictEqual([...t].sort(), ['a', 'b']);
    });
});
