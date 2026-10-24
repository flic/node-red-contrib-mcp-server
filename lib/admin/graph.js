'use strict';
// What a flow configuration says about itself as a graph: which nodes contain others, which
// properties point at another node, and who points at whom. Shared by the compact view and by
// validation, which must agree on what a reference is.
//
// Node-RED keeps no schema of which properties are references, so one is inferred: a top-level
// string property whose value is the id of another node in the same configuration. The few
// structural fields are handled explicitly instead.

// Fields with a fixed meaning, never treated as an inferred reference.
const STRUCTURAL = new Set(['id', 'type', 'z', 'g', 'wires', 'links', 'x', 'y', 'w', 'h', 'name', 'label', 'info']);

// Nodes that hold others through `z`. Groups hold through `g`, junctions hold nothing.
const isContainer = n => n && (n.type === 'tab' || n.type === 'subflow');

function indexById(flows) {
    const byId = new Map();
    for (const n of flows || []) { if (n && typeof n.id === 'string') byId.set(n.id, n); }
    return byId;
}

// The inferred references of one node: [{ prop, target }].
function refsOf(node, byId) {
    const out = [];
    for (const [prop, value] of Object.entries(node || {})) {
        if (STRUCTURAL.has(prop) || typeof value !== 'string' || value === node.id) continue;
        if (byId.has(value)) out.push({ prop, target: value });
    }
    return out;
}

// Every target a node points at, structural and inferred, for "who uses X" answers.
function targetsOf(node, byId) {
    const t = new Set(refsOf(node, byId).map(r => r.target));
    for (const port of Array.isArray(node.wires) ? node.wires : []) {
        for (const id of Array.isArray(port) ? port : []) t.add(id);
    }
    for (const id of Array.isArray(node.links) ? node.links : []) t.add(id);
    if (typeof node.type === 'string' && node.type.startsWith('subflow:')) t.add(node.type.slice(8));
    return t;
}

// target id → [ids of nodes pointing at it].
function usersIndex(flows) {
    const byId = indexById(flows);
    const users = new Map();
    for (const n of flows || []) {
        for (const t of targetsOf(n, byId)) {
            if (!users.has(t)) users.set(t, []);
            users.get(t).push(n.id);
        }
    }
    return users;
}

// Node-RED-shaped ids: 16 hex characters.
function newId() {
    return require('crypto').randomBytes(8).toString('hex');
}

module.exports = { STRUCTURAL, isContainer, indexById, refsOf, targetsOf, usersIndex, newId };
