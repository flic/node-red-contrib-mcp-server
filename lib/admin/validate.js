'use strict';
// The checks every write runs before it is deployed, and the validate tool runs on demand. The
// point is to refuse a change that would leave the flows broken in a way Node-RED itself would
// accept silently: a wire into nothing, a config reference emptied by a patch that dropped a
// field (an MCP node with mcpServer: "" is how this was first learned), a node outside any tab.
//
// Errors stop the write. Warnings travel with the answer.

const { isContainer, indexById, refsOf } = require('./graph');

// Types that exist without any module providing them.
const STRUCTURAL_TYPES = new Set(['tab', 'subflow', 'group', 'junction', 'unknown']);

// validate(before, after, { knownTypes }) → { errors: [], warnings: [] }
//   before     — the deployed configuration the change was made against ([] for "just check")
//   after      — the configuration about to be deployed
//   knownTypes — Set of node types the runtime has registered; omitted skips the type check
function validate(before, after, { knownTypes } = {}) {
    const errors = [], warnings = [];
    const err  = m => errors.push(m);
    const warn = m => warnings.push(m);

    const prev = indexById(before);
    const next = new Map();
    for (const n of after || []) {
        if (!n || typeof n !== 'object') { err('A node that is not an object: ' + JSON.stringify(n)); continue; }
        if (typeof n.id !== 'string' || !n.id) { err('A node without an id (type ' + JSON.stringify(n.type) + ').'); continue; }
        if (typeof n.type !== 'string' || !n.type) { err('Node ' + n.id + ' has no type.'); continue; }
        if (next.has(n.id)) { err('Duplicate id ' + n.id + '.'); continue; }
        next.set(n.id, n);
    }

    const label = n => n.id + ' (' + n.type + (n.name ? ' "' + n.name + '"' : '') + ')';
    const prevTypes = new Set([...prev.values()].map(n => n.type));

    for (const n of next.values()) {
        // A type the runtime does not know keeps every flow from starting. One that was already
        // deployed is only a warning: refusing it would block every unrelated change.
        if (knownTypes && !STRUCTURAL_TYPES.has(n.type) && !knownTypes.has(n.type)) {
            const sub = n.type.startsWith('subflow:') ? next.get(n.type.slice(8)) : null;
            if (sub && sub.type === 'subflow') { /* an instance of a subflow in this configuration */ }
            else if (n.type.startsWith('subflow:')) err(label(n) + ' is an instance of a subflow that does not exist.');
            else if (prevTypes.has(n.type)) warn(label(n) + ' has a type the runtime does not know (it was already deployed).');
            else err(label(n) + ' has a type the runtime does not know. Is the module installed?');
        }

        if (n.z !== undefined && n.z !== '' && n.type !== 'tab' && n.type !== 'subflow') {
            const z = next.get(n.z);
            if (!isContainer(z)) err(label(n) + ' is on flow ' + n.z + ', which is not a tab or subflow.');
        }
        if (n.g !== undefined && n.g !== '') {
            const g = next.get(n.g);
            if (!g || g.type !== 'group') err(label(n) + ' is in group ' + n.g + ', which does not exist.');
        }

        if (n.wires !== undefined) {
            if (!Array.isArray(n.wires) || n.wires.some(p => !Array.isArray(p))) {
                err(label(n) + ' has malformed wires: an array of arrays of node ids is expected.');
            } else {
                n.wires.forEach((port, i) => port.forEach(t => {
                    if (!next.has(t)) err(label(n) + ' output ' + (i + 1) + ' is wired to ' + t + ', which does not exist.');
                }));
            }
        }
        if (Array.isArray(n.links)) {
            for (const t of n.links) {
                if (!next.has(t)) err(label(n) + ' links to ' + t + ', which does not exist.');
            }
        }

        // Inferred references the change broke: a property that pointed at an existing node in
        // the deployed configuration and now points at nothing — emptied, removed, or aimed at
        // an id that is gone. Compared against `before`, so a reference that was already broken
        // is not blamed on this change.
        const old = prev.get(n.id);
        if (old) {
            for (const { prop, target } of refsOf(old, prev)) {
                const now = n[prop];
                if (now === target && next.has(target)) continue;
                if (typeof now === 'string' && next.has(now)) continue;   // re-pointed elsewhere
                err(label(n) + ' property "' + prop + '" '
                    + (now === target ? 'refers to ' + target + ', which this change removes.'
                        : 'referred to ' + target + (now === undefined || now === ''
                            ? ' and is now empty.' : ' and now refers to ' + JSON.stringify(now) + ', which does not exist.')));
            }
        }
    }

    // Removed nodes a node added by this change points at. Nodes that were already deployed are
    // covered by the reference check above, which saw the target exist before.
    for (const [id, old] of prev) {
        if (next.has(id)) continue;
        for (const n of next.values()) {
            if (prev.has(n.id)) continue;
            for (const [prop, value] of Object.entries(n)) {
                if (value === id && prop !== 'id') err(label(old) + ' is removed but ' + label(n) + ' still refers to it in "' + prop + '".');
            }
        }
    }

    return { errors, warnings };
}

// The set validate's type check accepts: everything registered in GET /nodes.
function knownTypesFrom(nodeSets) {
    const types = new Set();
    for (const set of Array.isArray(nodeSets) ? nodeSets : []) {
        if (set && set.enabled !== false) for (const t of set.types || []) types.add(t);
    }
    return types;
}

module.exports = { validate, knownTypesFrom };
