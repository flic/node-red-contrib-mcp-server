'use strict';
// How the read tools describe flows to a model: what a flow is made of and how it connects, at a
// fraction of the raw export's size. Editor geometry (x, y, w, h) is dropped; everything else is
// kept, empty values included — an empty config reference is exactly the kind of thing a reader
// needs to see. Values pass through the masker (lib/admin/mask.js) on the way out.

const { isContainer, indexById, usersIndex } = require('./graph');
const { isSensitiveName } = require('./mask');

const GEOMETRY = new Set(['x', 'y', 'w', 'h']);
// Not searched as text: an id or wire matching a word is noise, not a hit.
const NOT_TEXT = new Set(['id', 'z', 'g', 'wires', 'links']);
// How many referring ids list_flows and get_node name before counting the rest.
const USERS_SHOWN = 10;

const passThrough = { node: n => n };

// A node without geometry. `keepZ` for answers about single nodes, where which flow a node is on
// is not implied by the question.
function compactNode(n, { keepZ = false } = {}) {
    const out = {};
    for (const [k, v] of Object.entries(n)) {
        if (GEOMETRY.has(k) || (k === 'z' && !keepZ)) continue;
        // An output with nothing on it is noise; which port goes where is not.
        if (k === 'wires' && Array.isArray(v) && v.every(p => Array.isArray(p) && p.length === 0)) continue;
        out[k] = v;
    }
    return out;
}

// A node is a config node when it has neither a position nor wires: it lives in the config
// sidebar, globally (no z) or scoped to one flow (z set).
const isConfigNode = n => n && n.x === undefined && n.wires === undefined
    && !isContainer(n) && n.type !== 'group' && n.type !== 'junction';

const flowLabel = n => n && (n.label || n.name);

function usersOf(users, id) {
    const all = users.get(id) || [];
    return all.length > USERS_SHOWN
        ? { usedByCount: all.length, usedBy: all.slice(0, USERS_SHOWN), usedByMore: all.length - USERS_SHOWN }
        : { usedByCount: all.length, usedBy: all };
}

// list_flows: tabs, subflows and config nodes, with what refers to each config node.
function summarize(flows) {
    const byId = indexById(flows);
    const users = usersIndex(flows);
    const count = id => flows.filter(n => n.z === id).length;
    const tabs = [], subflows = [], configs = [];
    for (const n of flows) {
        if (n.type === 'tab') {
            tabs.push({ id: n.id, label: n.label, disabled: !!n.disabled, nodes: count(n.id) });
        } else if (n.type === 'subflow') {
            subflows.push({ id: n.id, name: n.name, nodes: count(n.id),
                instances: flows.filter(m => m.type === 'subflow:' + n.id).length });
        } else if (isConfigNode(n)) {
            const z = n.z ? byId.get(n.z) : null;
            configs.push({ id: n.id, type: n.type, name: n.name || undefined,
                scope: z ? { flow: z.id, label: flowLabel(z) } : 'global', ...usersOf(users, n.id) });
        }
    }
    return { tabs, subflows, configs };
}

// get_flow: one tab or subflow, paginated by node.
function flowView(flows, id, { offset = 0, limit = 50, masker = passThrough } = {}) {
    const container = flows.find(n => n.id === id);
    if (!isContainer(container)) return null;
    const nodes = flows.filter(n => n.z === id);
    const page = nodes.slice(offset, offset + limit).map(n => compactNode(masker.node(n)));
    return {
        flow : compactNode(masker.node(container)),
        total: nodes.length,
        offset,
        nodes: page,
        more : offset + page.length < nodes.length ? 'Call again with offset ' + (offset + page.length) + ' for the rest.' : undefined
    };
}

// get_node: single nodes, with the flow they are on and who refers to them.
function nodeView(flows, ids, { masker = passThrough, raw = false } = {}) {
    const byId = indexById(flows), users = usersIndex(flows);
    return ids.map(id => {
        const n = byId.get(id);
        if (!n) return { id, error: 'not found' };
        const z = n.z ? byId.get(n.z) : null;
        const shown = masker.node(n);
        return { ...(raw ? shown : compactNode(shown, { keepZ: true })),
            flow: z ? { id: z.id, label: flowLabel(z) } : undefined, ...usersOf(users, id) };
    });
}

// find_nodes: a case-insensitive match over names and every string property — which is where a
// flow's code lives (func, template, initialize, finalize) — but not over ids. Paginated.
function find(flows, { type, text, references, flow, offset = 0, limit = 25, masker = passThrough } = {}) {
    const byId = indexById(flows);
    const users = references ? new Set(usersIndex(flows).get(references) || []) : null;
    const needle = text ? String(text).toLowerCase() : null;
    const hits = [];
    for (const n of flows) {
        if (type && n.type !== type) continue;
        if (flow && n.z !== flow) continue;
        if (users && !users.has(n.id)) continue;
        let match;
        if (needle) {
            for (const [k, v] of Object.entries(n)) {
                if (NOT_TEXT.has(k) || typeof v !== 'string') continue;
                const i = v.toLowerCase().indexOf(needle);
                if (i === -1) continue;
                // A hit inside a masked property says where, not what.
                const shown = masker.node(n)[k];
                if (shown !== v || isSensitiveName(k)) { match = { property: k, excerpt: typeof shown === 'string' ? shown : '«masked»' }; break; }
                const start = Math.max(0, i - 60);
                match = { property: k, excerpt: (start ? '…' : '') + v.slice(start, i + needle.length + 60) + (i + needle.length + 60 < v.length ? '…' : '') };
                break;
            }
            if (!match) continue;
        }
        const z = byId.get(n.z);
        hits.push({ id: n.id, type: n.type, name: n.name || n.label || undefined,
            flow: z ? { id: z.id, label: flowLabel(z) } : undefined, match });
    }
    const page = hits.slice(offset, offset + limit);
    return { total: hits.length, offset, results: page,
        more: offset + page.length < hits.length ? 'Call again with offset ' + (offset + page.length) + ' for the rest.' : undefined };
}

module.exports = { compactNode, summarize, flowView, nodeView, find, isConfigNode, USERS_SHOWN };
