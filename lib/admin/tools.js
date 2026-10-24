'use strict';
// The admin node's tools: definitions and implementations, as plain functions of (args, ctx).
// The node (nodes/mcp-admin.js) only registers them and carries results back; everything that
// decides anything is here, testable against a mocked admin API.
//
//   ctx = { api, snapshots, debug, claims, emit, serverId, instance }
//     api       — lib/admin/api.js
//     snapshots — lib/admin/snapshots.js
//     debug     — lib/admin/comms.js (absent when the Test group is off)
//     claims    — the caller's verified token claims (null from mcp-call)
//     emit      — emit({ event, tool, ... }) to the node's output
//     serverId  — the mcp-server node these tools are served by
//     instance  — { name, description } of this Node-RED, named in answers that change something
//
// Every write follows one path, writeFlows(): read the flows with their revision, change a copy,
// validate it against what was deployed, snapshot the deployed state, deploy with that revision.
// A deploy in between is refused (409) rather than overwritten, and nothing is retried silently.

const { validate, knownTypesFrom } = require('./validate');
const { summarize, flowView, nodeView, find } = require('./compact');
const { isContainer, indexById, newId } = require('./graph');
const { containsMask, MARK } = require('./mask');
const { AdminApiError, ID_RE } = require('./api');

class ToolError extends Error {}

const caller = claims => ({
    sub   : (claims && claims.sub) || null,
    client: (claims && (claims.azp || claims.client_id)) || null
});

function diff(before, after) {
    const a = indexById(before), b = indexById(after);
    const added = [], removed = [], modified = [];
    for (const id of b.keys()) if (!a.has(id)) added.push(id);
    for (const id of a.keys()) {
        if (!b.has(id)) removed.push(id);
        else if (JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id))) modified.push(id);
    }
    return { added, removed, modified };
}

async function knownTypes(api) {
    try { return knownTypesFrom(await api.getNodes()); }
    catch { return undefined; }   // without nodes.read the type check is skipped, not failed
}

// The one write path. `change(flows)` mutates the copy it is given and returns a one-line summary.
async function writeFlows(ctx, tool, args, change, { deploymentType = 'nodes', checkReferences = true } = {}) {
    const { api, snapshots } = ctx;
    const instance = ctx.instance && ctx.instance.name;
    const who = { instance, ...caller(ctx.claims) };
    const dryRun = args.dry_run === true;
    // A dry run changes nothing, so nothing goes out on the changes output for it — refused or not.
    const emit = dryRun ? () => {} : ctx.emit;
    const refuse = (extra, event) => {
        if (event) emit({ event: 'rejected', tool, ...who, ...event });
        return { ok: false, instance, deployed: false, dry_run: dryRun || undefined, ...extra };
    };
    const current = await api.getFlows();

    // Optimistic locking from the caller's side: what it read is not what is deployed now, so the
    // change it worked out may no longer fit — refused before anything is changed, even when the
    // change itself would not collide.
    if (args.expected_rev !== undefined && args.expected_rev !== current.rev) {
        return refuse({ conflict: true, rev: current.rev,
            error: 'The flows changed since revision ' + args.expected_rev + ' (now ' + current.rev
                + '). Nothing was changed; read them again and redo the change.' },
            { reason: 'conflict', summary: 'expected_rev ' + args.expected_rev + ' is stale' });
    }

    const next = structuredClone(current.flows);
    const summary = change(next, current.flows);
    const changed = diff(current.flows, next);

    // A masked value read back and sent on would replace the real secret with its placeholder.
    const byId = indexById(next);
    const masked = [...changed.added, ...changed.modified].filter(id => containsMask(byId.get(id)));
    if (masked.length) {
        throw new ToolError('The change carries a masked value (' + MARK + '…») on ' + masked.join(', ')
            + '. Leave masked properties out of set and nodes: properties not named are kept as they are.');
    }

    // The server answering this call restarts when it is changed, and the answer is lost with
    // it; a wrong path, issuer or token setting would also lock every client out of the tools
    // that could put it right. That change belongs in the editor.
    if (ctx.serverId && (changed.modified.includes(ctx.serverId) || changed.removed.includes(ctx.serverId))) {
        const errors = ['This change modifies the MCP server these tools are served by (' + ctx.serverId
            + '). Make it in the editor: deployed from here, it would restart the server mid-answer, '
            + 'and a mistake would lock every client out of these tools.'];
        return refuse({ summary, error: errors[0], errors }, { summary, reason: 'own-server', errors });
    }

    const { errors, warnings } = validate(checkReferences ? current.flows : [], next,
        { knownTypes: await knownTypes(api) });
    if (errors.length) {
        return refuse({ summary, error: 'Refused: the change would leave ' + errors.length + ' problem(s); see errors.',
            errors, warnings }, { summary, reason: 'validation', errors });
    }
    if (!changed.added.length && !changed.removed.length && !changed.modified.length) {
        return { ok: true, instance, deployed: false, summary, note: 'Nothing changed.', rev: current.rev, warnings };
    }
    if (dryRun) {
        return { ok: true, instance, deployed: false, dry_run: true, summary, changed, rev: current.rev, warnings };
    }

    const snapshot = snapshots.save({ rev: current.rev, flows: current.flows,
        meta: { tool, ...who, summary } });
    let rev;
    try {
        ({ rev } = await api.postFlows(current.rev, next, deploymentType));
    } catch (e) {
        snapshots.remove(snapshot);
        if (e instanceof AdminApiError && e.status === 409) {
            return refuse({ summary, conflict: true,
                error: 'The flows were deployed by someone else since they were read. Nothing was changed; read them again and redo the change.' },
                { summary, reason: 'conflict' });
        }
        throw e;
    }
    emit({ event: 'deployed', tool, ...who, summary, changed, rev, snapshot });
    return { ok: true, instance, deployed: true, summary, changed, warnings, rev, snapshot };
}

// Wires and link lists pointing at removed nodes are dropped with them; inferred references
// (a config node a remaining node still uses) are left for validation to refuse.
function dropStructuralRefs(flows, removed) {
    for (const n of flows) {
        if (Array.isArray(n.wires)) n.wires = n.wires.map(p => Array.isArray(p) ? p.filter(t => !removed.has(t)) : p);
        if (Array.isArray(n.links)) n.links = n.links.filter(t => !removed.has(t));
    }
}

function requireArray(v, what) {
    if (!Array.isArray(v) || !v.length) throw new ToolError(what + ' must be a non-empty array.');
    return v;
}

const dryRun = { type: 'boolean', description: 'Validate and report what would change, without deploying.' };
const expectedRev = { type: 'string', description: 'The rev your reads answered. If the flows have changed since, the write is refused as a conflict instead of applied.' };

// ── Read ────────────────────────────────────────────────────────────────────────────────────
// Every read passes through ctx.masker: secrets stored as plain properties or context values are
// answered as «masked: N chars».

const passMask = { node: n => n, value: v => v, keyed: (k, v) => v };
const maskerOf = ctx => ctx.masker || passMask;

// The context API answers { <store>: { <key>: { msg, format } } }; msg is the value encoded as
// text. Decoded back where it is JSON, so a model reads a value rather than an escaped string.
function decodeContext(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.msg !== 'string') return entry;
    if (entry.format === 'undefined') return undefined;
    try { return JSON.parse(entry.msg); } catch { return entry.msg; }
}

const CONTEXT_VALUE_MAX = 4000;

// A value too long to answer whole: an object is answered as its keys (each with type and size),
// so the next call can ask for the one it needs; anything else as its start.
function capValue(value, max) {
    const text = JSON.stringify(value);
    if (text === undefined || text.length <= max) return { value };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { size: text.length, keys: Object.entries(value).map(([k, v]) => ({ key: k,
            type: Array.isArray(v) ? 'array[' + v.length + ']' : v === null ? 'null' : typeof v,
            size: (JSON.stringify(v) || '').length })),
            note: 'Too long to answer whole (' + text.length + ' characters). Ask for one part with key "<key>.<part>" and the store.' };
    }
    return { value: text.slice(0, max) + '…', truncated: text.length + ' characters as JSON; this is the start. Raise max_chars for more.' };
}

// A scope id must name what the scope says: the context API itself answers empty stores for
// any id, which reads as "no context" rather than "no such flow".
function checkContextTarget(flows, scope, id) {
    if (scope === 'global') return;
    if (!id) throw new ToolError('id is required for ' + scope + ' context.');
    const n = flows.find(m => m.id === id);
    if (scope === 'flow' && !isContainer(n)) throw new ToolError('No tab or subflow with id ' + JSON.stringify(id) + '.');
    if (scope === 'node' && (!n || isContainer(n))) throw new ToolError('No node with id ' + JSON.stringify(id) + '.');
}

const READ = [
    {
        name: 'list_flows',
        description: 'Overview of this Node-RED: every tab (flow) and subflow with its node count, and every config node — global or scoped to one flow — with how many nodes use it (usedByCount) and the first ids of those (usedBy; wires, links and config references all count). Start here. Tab labels are not unique: use ids.',
        inputSchema: { type: 'object', properties: {} },
        run: async (args, { api }) => { const { rev, flows } = await api.getFlows(); return { rev, ...summarize(flows) }; }
    },
    {
        name: 'get_flow',
        description: 'The nodes of one tab or subflow, with every property except editor geometry, including function code. Paginated: large flows say how to get the rest. raw: true gives the export as stored, geometry included. Secrets stored as plain properties are masked.',
        inputSchema: { type: 'object', required: ['id'], properties: {
            id    : { type: 'string', description: 'Tab or subflow id (from list_flows).' },
            offset: { type: 'integer', minimum: 0 },
            limit : { type: 'integer', minimum: 1, maximum: 200, description: 'Nodes per page (default 50).' },
            raw   : { type: 'boolean', description: 'As stored: geometry and z included.' }
        } },
        run: async (args, ctx) => {
            const masker = maskerOf(ctx);
            const { rev, flows } = await ctx.api.getFlows();
            const view = { rev, ...flowView(flows, args.id, { offset: args.offset || 0, limit: args.limit || 50, masker }) };
            if (!view.flow) throw new ToolError('No tab or subflow with id ' + JSON.stringify(args.id) + '. Use list_flows.');
            if (args.raw === true) {
                const ids = new Set(view.nodes.map(n => n.id));
                view.flow = masker.node(flows.find(n => n.id === args.id));
                view.nodes = flows.filter(n => ids.has(n.id)).map(masker.node);
            }
            return view;
        }
    },
    {
        name: 'get_node',
        description: 'Configuration of one or more nodes by id (config nodes included) without editor geometry, each with the flow it is on and the nodes that refer to it (wires, links and config references all count). raw: true gives them as stored. Secrets stored as plain properties are masked.',
        inputSchema: { type: 'object', required: ['ids'], properties: {
            ids: { type: 'array', items: { type: 'string' }, maxItems: 50 },
            raw: { type: 'boolean' }
        } },
        run: async (args, ctx) => {
            const { rev, flows } = await ctx.api.getFlows();
            return { rev, nodes: nodeView(flows, requireArray(args.ids, 'ids'), { masker: maskerOf(ctx), raw: args.raw === true }) };
        }
    },
    {
        name: 'find_nodes',
        description: 'Search nodes by type, by text in names and any other string property (function code, templates, URLs …; not ids), by what they refer to, or within one flow. Filters combine. Paginated: answers give the total.',
        inputSchema: { type: 'object', properties: {
            type      : { type: 'string', description: 'Exact node type, e.g. "function".' },
            text      : { type: 'string', description: 'Case-insensitive text in any string property except ids.' },
            references: { type: 'string', description: 'Id of a node: return the nodes that refer to it.' },
            flow      : { type: 'string', description: 'Only nodes on this tab or subflow.' },
            offset    : { type: 'integer', minimum: 0 },
            limit     : { type: 'integer', minimum: 1, maximum: 100, description: 'Results per page (default 25).' }
        } },
        run: async (args, ctx) => {
            const { rev, flows } = await ctx.api.getFlows();
            return { rev, ...find(flows, { ...args, offset: args.offset || 0, limit: args.limit || 25, masker: maskerOf(ctx) }) };
        }
    },
    {
        name: 'get_context',
        description: 'Read context — global, or of one flow or node. Without key: the keys in each context store, with format and size, no values. With key: that value, from `store` or from whichever store holds the key; nested parts with a dotted key (a.b.c) and the store. A value over max_chars is answered as its keys (an object) or its start. Values whose name suggests a secret are masked.',
        inputSchema: { type: 'object', required: ['scope'], properties: {
            scope: { type: 'string', enum: ['global', 'flow', 'node'] },
            id   : { type: 'string', description: 'Flow or node id (not for global).' },
            key  : { type: 'string' },
            store: { type: 'string', description: 'Context store, e.g. "memory" or "filesystem". Found automatically when omitted.' },
            max_chars: { type: 'integer', minimum: 200, maximum: 50000, description: 'Longest value answered whole (default 4000).' }
        } },
        run: async (args, ctx) => {
            const { api } = ctx, masker = maskerOf(ctx);
            checkContextTarget((await api.getFlows()).flows, args.scope, args.id);
            const target = { scope: args.scope, id: args.id };
            if (!args.key) {
                const listing = await api.getContext(args.scope, args.id);
                const stores = {};
                for (const [store, keys] of Object.entries(listing || {})) {
                    stores[store] = Object.entries(keys || {}).map(([key, e]) => ({ key, format: e && e.format,
                        size: e && typeof e.msg === 'string' ? e.msg.length : undefined }));
                }
                return { ...target, stores };
            }
            let stores = args.store ? [args.store] : [];
            if (!stores.length) {
                const listing = await api.getContext(args.scope, args.id);
                stores = Object.entries(listing || {}).filter(([, keys]) => keys && Object.prototype.hasOwnProperty.call(keys, args.key)).map(([s]) => s);
                if (!stores.length) {
                    throw new ToolError('No key ' + JSON.stringify(args.key) + ' in ' + args.scope + ' context (stores: '
                        + Object.keys(listing || {}).join(', ') + '). Keys are matched exactly; nested paths need the store.');
                }
            }
            const values = [];
            for (const store of stores) {
                const value = decodeContext(await api.getContext(args.scope, args.id, args.key, store));
                values.push({ store, key: args.key, ...capValue(masker.keyed(args.key, value), args.max_chars || CONTEXT_VALUE_MAX) });
            }
            return values.length === 1 ? { ...target, ...values[0] } : { ...target, values };
        }
    },
    {
        name: 'get_runtime',
        description: 'Which Node-RED instance this is; Node-RED and Node.js versions; when this Node-RED process started (and the host\'s own uptime, separately); whether flows are running; the flow file, whether projects are on, and the context stores; installed node modules with versions.',
        inputSchema: { type: 'object', properties: {} },
        run: async (args, { api, instance }) => {
            const settled = await Promise.allSettled([api.getSettings(), api.getFlowsState(), api.getNodes(), api.getDiagnostics(),
                api.request('GET', '/projects')]);
            const val = i => settled[i].status === 'fulfilled' ? settled[i].value : { error: settled[i].reason.message };
            const settings = val(0), state = val(1), nodes = val(2), diag = val(3), projects = val(4);
            const modules = {};
            for (const set of Array.isArray(nodes) ? nodes : []) {
                const m = modules[set.module] || (modules[set.module] = { module: set.module, version: set.version, enabled: true, types: 0 });
                m.types += (set.types || []).length;
                if (set.enabled === false) m.enabled = false;
            }
            const rs = (diag.runtime && diag.runtime.settings) || {};
            const theme = rs.editorTheme || {};
            // These tools run inside the Node-RED process, so its uptime is this process's.
            const up = Math.round(process.uptime());
            return {
                instance,
                nodeRed : settings.version || (diag.runtime && diag.runtime.version),
                nodejs  : diag.nodejs ? diag.nodejs.version : process.version,
                process : { startedAt: new Date(Date.now() - up * 1000).toISOString(), uptimeSeconds: up },
                host    : diag.os ? { uptimeSeconds: Math.round(diag.os.uptime), containerised: diag.os.containerised,
                    platform: diag.os.platform, arch: diag.os.arch, release: diag.os.release } : undefined,
                flows   : state.state || state,
                // With projects on, the flow file in settings is not what runs: the active project's is.
                flowFile: projects.active ? 'projects/' + projects.active + '/' + (rs.flowFile || 'flows.json') : rs.flowFile,
                projects: theme.projects ? { enabled: !!theme.projects.enabled,
                    active: projects.active || (projects.error ? 'unknown (needs projects.read)' : undefined) } : undefined,
                contextStores: rs.contextStorage ? Object.keys(rs.contextStorage).filter(s => s !== 'default') : undefined,
                modules : Array.isArray(nodes) ? Object.values(modules) : nodes
            };
        }
    },
    {
        name: 'validate',
        description: 'Check the deployed flows for broken wires and links, references to nodes that do not exist, nodes outside any flow, duplicate ids and types the runtime does not know. Every write runs the same checks before deploying. `checked` says how much was looked at.',
        inputSchema: { type: 'object', properties: {} },
        run: async (args, { api }) => {
            const { flows } = await api.getFlows();
            const types = await knownTypes(api);
            return { checked: { nodes: flows.length, tabs: flows.filter(n => n.type === 'tab').length,
                subflows: flows.filter(n => n.type === 'subflow').length,
                knownTypes: types ? types.size : 'not checked (needs nodes.read)' },
                ...validate([], flows, { knownTypes: types }) };
        }
    },
    {
        name: 'list_snapshots',
        description: 'The configuration snapshots taken before each write, newest first: id, time, which tool, who, and a summary. Use an id with rollback.',
        inputSchema: { type: 'object', properties: {} },
        run: async (args, { snapshots }) => snapshots.list()
    }
];

// ── Flows: write ────────────────────────────────────────────────────────────────────────────
const FLOWS = [
    {
        name: 'patch_nodes',
        write: true,
        description: 'Change properties of existing nodes, config nodes included, without resending whole flows: per node, `set` writes properties and `unset` removes them. Everything not named is kept. Only the changed nodes restart.',
        inputSchema: { type: 'object', required: ['patches'], properties: {
            patches: { type: 'array', items: { type: 'object', required: ['id'], properties: {
                id   : { type: 'string' },
                set  : { type: 'object', description: 'Property → new value, e.g. { "func": "…", "name": "…" }.' },
                unset: { type: 'array', items: { type: 'string' } }
            } } },
            dry_run: dryRun,
            expected_rev: expectedRev
        } },
        run: (args, ctx) => writeFlows(ctx, 'patch_nodes', args, flows => {
            const byId = indexById(flows);
            const patches = requireArray(args.patches, 'patches');
            for (const p of patches) {
                const n = byId.get(p && p.id);
                if (!n) throw new ToolError('No node with id ' + JSON.stringify(p && p.id) + '.');
                const set = p.set || {};
                if ('id' in set) throw new ToolError('A node id cannot be changed.');
                Object.assign(n, set);
                for (const k of p.unset || []) { if (k !== 'id' && k !== 'type') delete n[k]; }
            }
            return 'Patched ' + patches.map(p => p.id).join(', ');
        })
    },
    {
        name: 'add_nodes',
        write: true,
        description: 'Add nodes. Give each an id of your own (16 hex characters) so wires between new nodes can name each other; nodes without one get one generated. `flow` places nodes that have no z on that tab or subflow; a global config node has z "".',
        inputSchema: { type: 'object', required: ['nodes'], properties: {
            flow   : { type: 'string', description: 'Tab or subflow id for nodes without z.' },
            nodes  : { type: 'array', items: { type: 'object', required: ['type'] } },
            dry_run: dryRun,
            expected_rev: expectedRev
        } },
        run: (args, ctx) => writeFlows(ctx, 'add_nodes', args, flows => {
            const byId = indexById(flows);
            if (args.flow !== undefined && !isContainer(byId.get(args.flow))) {
                throw new ToolError('No tab or subflow with id ' + JSON.stringify(args.flow) + '.');
            }
            const added = requireArray(args.nodes, 'nodes').map(n => {
                const node = { ...n, id: n.id || newId() };
                if (byId.has(node.id)) throw new ToolError('Id ' + node.id + ' is already in use.');
                if (node.z === undefined && args.flow !== undefined) node.z = args.flow;
                return node;
            });
            flows.push(...added);
            return 'Added ' + added.map(n => n.id + ' (' + n.type + ')').join(', ');
        })
    },
    {
        name: 'remove_nodes',
        write: true,
        description: 'Remove nodes by id. Wires and links into them are removed too. Refused if something still uses one of them (for example a config node in use); remove or re-point those first. Tabs and subflows go with delete_flow.',
        inputSchema: { type: 'object', required: ['ids'], properties: {
            ids    : { type: 'array', items: { type: 'string' } },
            dry_run: dryRun,
            expected_rev: expectedRev
        } },
        run: (args, ctx) => writeFlows(ctx, 'remove_nodes', args, flows => {
            const byId = indexById(flows);
            const ids = new Set(requireArray(args.ids, 'ids'));
            for (const id of ids) {
                const n = byId.get(id);
                if (!n) throw new ToolError('No node with id ' + JSON.stringify(id) + '.');
                if (isContainer(n)) throw new ToolError(id + ' is a ' + n.type + '; use delete_flow.');
            }
            const keep = flows.filter(n => !ids.has(n.id));
            flows.length = 0; flows.push(...keep);
            dropStructuralRefs(flows, ids);
            return 'Removed ' + [...ids].join(', ');
        })
    },
    {
        name: 'create_flow',
        write: true,
        description: 'Create a new tab, optionally with nodes on it (same rules as add_nodes). Give it an id of your own (16 hex characters) to have a dry run and the real call agree on it; without one an id is generated each time. The new tab id is in changed.added.',
        inputSchema: { type: 'object', required: ['label'], properties: {
            id      : { type: 'string', description: 'Id for the new tab; generated if omitted.' },
            label   : { type: 'string' },
            info    : { type: 'string' },
            disabled: { type: 'boolean' },
            nodes   : { type: 'array', items: { type: 'object', required: ['type'] } },
            dry_run : dryRun,
            expected_rev: expectedRev
        } },
        run: (args, ctx) => writeFlows(ctx, 'create_flow', args, flows => {
            const byId = indexById(flows);
            if (args.id !== undefined && (typeof args.id !== 'string' || !ID_RE.test(args.id))) throw new ToolError('Invalid tab id ' + JSON.stringify(args.id) + '.');
            if (args.id !== undefined && byId.has(args.id)) throw new ToolError('Id ' + args.id + ' is already in use.');
            const tab = { id: args.id || newId(), type: 'tab', label: String(args.label), disabled: args.disabled === true, info: args.info || '' };
            const nodes = (args.nodes || []).map(n => {
                const node = { ...n, id: n.id || newId(), z: tab.id };
                if (byId.has(node.id)) throw new ToolError('Id ' + node.id + ' is already in use.');
                return node;
            });
            flows.push(tab, ...nodes);
            return 'Created tab ' + tab.id + ' "' + tab.label + '"' + (nodes.length ? ' with ' + nodes.length + ' node(s)' : '');
        })
    },
    {
        name: 'delete_flow',
        write: true,
        description: 'Delete a tab or subflow and every node on it. Refused if anything elsewhere still uses one of its nodes, or if instances of the subflow remain.',
        inputSchema: { type: 'object', required: ['id'], properties: {
            id     : { type: 'string' },
            dry_run: dryRun,
            expected_rev: expectedRev
        } },
        run: (args, ctx) => writeFlows(ctx, 'delete_flow', args, flows => {
            const container = indexById(flows).get(args.id);
            if (!isContainer(container)) throw new ToolError('No tab or subflow with id ' + JSON.stringify(args.id) + '.');
            const ids = new Set([args.id, ...flows.filter(n => n.z === args.id).map(n => n.id)]);
            const keep = flows.filter(n => !ids.has(n.id));
            flows.length = 0; flows.push(...keep);
            dropStructuralRefs(flows, ids);
            return 'Deleted ' + container.type + ' ' + args.id + ' "' + (container.label || container.name || '') + '" (' + (ids.size - 1) + ' node(s))';
        }, { deploymentType: 'flows' })
    },
    {
        name: 'set_flow_enabled',
        write: true,
        description: 'Enable or disable a tab. A disabled tab stays in the configuration but none of its nodes run.',
        inputSchema: { type: 'object', required: ['id', 'enabled'], properties: {
            id     : { type: 'string' },
            enabled: { type: 'boolean' },
            dry_run: dryRun,
            expected_rev: expectedRev
        } },
        run: (args, ctx) => writeFlows(ctx, 'set_flow_enabled', args, flows => {
            const tab = indexById(flows).get(args.id);
            if (!tab || tab.type !== 'tab') throw new ToolError('No tab with id ' + JSON.stringify(args.id) + '.');
            tab.disabled = args.enabled !== true;
            return (args.enabled ? 'Enabled' : 'Disabled') + ' tab ' + args.id + ' "' + tab.label + '"';
        }, { deploymentType: 'flows' })
    },
    {
        name: 'rollback',
        write: true,
        description: 'Restore the WHOLE configuration from a snapshot (list_snapshots) — every change since it, by anyone, is undone. Run it with dry_run: true first and read changed: it lists every node the rollback would touch. Only the nodes that differ restart. The current state is snapshotted first, so a rollback can itself be undone. Credentials of nodes that still exist are kept; nodes recreated by the rollback come back without theirs.',
        inputSchema: { type: 'object', required: ['snapshot'], properties: {
            snapshot: { type: 'string' },
            dry_run : dryRun,
            expected_rev: expectedRev
        } },
        run: (args, ctx) => {
            const snap = ctx.snapshots.load(args.snapshot);
            if (!snap) throw new ToolError('No snapshot ' + JSON.stringify(args.snapshot) + '. Use list_snapshots.');
            return writeFlows(ctx, 'rollback', args, flows => {
                flows.length = 0; flows.push(...structuredClone(snap.flows));
                return 'Rolled back to snapshot ' + snap.id + ' (' + snap.time + ')';
            // `nodes`, not `full`: a full deploy restarts the server this call is answered through.
            }, { checkReferences: false });
        }
    }
];

// ── Test ────────────────────────────────────────────────────────────────────────────────────
const toInjectProp = (p, v) => {
    if (typeof v === 'string')  return { p, v, vt: 'str' };
    if (typeof v === 'number')  return { p, v: String(v), vt: 'num' };
    if (typeof v === 'boolean') return { p, v: String(v), vt: 'bool' };
    return { p, v: JSON.stringify(v), vt: 'json' };
};

const TEST = [
    {
        name: 'inject',
        write: true,
        description: 'Press the button of an inject node, optionally with your own message properties instead of its configured ones. Follow with get_debug to see what came out.',
        inputSchema: { type: 'object', required: ['id'], properties: {
            id   : { type: 'string', description: 'Id of an inject node.' },
            props: { type: 'object', description: 'Message properties to send instead, e.g. { "payload": { "a": 1 }, "topic": "t" }.' }
        } },
        run: async (args, ctx) => {
            const { flows } = await ctx.api.getFlows();
            const node = flows.find(n => n.id === args.id);
            if (!node) throw new ToolError('No node with id ' + JSON.stringify(args.id) + '.');
            if (node.type !== 'inject') throw new ToolError(args.id + ' is a ' + node.type + ' node, not an inject node.');
            // The runtime does not start disabled nodes, so there is nothing to press.
            if (node.d === true) throw new ToolError('Inject node ' + args.id + ' is disabled.');
            const tab = flows.find(n => n.id === node.z);
            if (tab && tab.disabled) throw new ToolError('Inject node ' + args.id + ' is on the disabled tab ' + tab.id + ' "' + tab.label + '"; enable the tab first.');
            const body = args.props && typeof args.props === 'object'
                ? { __user_inject_props__: Object.entries(args.props).map(([p, v]) => toInjectProp(p, v)) } : {};
            await ctx.api.inject(args.id, body);
            const instance = ctx.instance && ctx.instance.name;
            ctx.emit({ event: 'injected', tool: 'inject', instance, ...caller(ctx.claims), summary: 'Injected ' + args.id, node: args.id });
            return { ok: true, instance, injected: args.id, time: new Date().toISOString() };
        }
    },
    {
        name: 'get_debug',
        description: 'Recent debug-sidebar messages: output of active debug nodes, and warnings and errors raised by any node. Filter by node, flow or level; `since` (ISO time, e.g. from inject) returns only newer ones. The answer says since when the buffer has listened and how much it holds, so an empty answer can be told apart from one that came too early.',
        inputSchema: { type: 'object', properties: {
            node : { type: 'string' },
            flow : { type: 'string' },
            level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
            since: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200 }
        } },
        run: async (args, { debug }) => {
            if (args.since !== undefined && Number.isNaN(Date.parse(args.since))) {
                throw new ToolError('since must be an ISO time, e.g. the time inject answered; got ' + JSON.stringify(args.since) + '.');
            }
            const since = args.since !== undefined ? new Date(Date.parse(args.since)).toISOString() : undefined;
            return { ...debug.status(), messages: debug.query({ ...args, since }) };
        }
    }
];

// ── Context ─────────────────────────────────────────────────────────────────────────────────
const CONTEXT = [
    {
        name: 'delete_context',
        write: true,
        description: 'Delete one context key (global, flow or node). The admin API can delete context but not set it.',
        inputSchema: { type: 'object', required: ['scope', 'key'], properties: {
            scope: { type: 'string', enum: ['global', 'flow', 'node'] },
            id   : { type: 'string', description: 'Flow or node id (not for global).' },
            key  : { type: 'string' },
            store: { type: 'string', description: 'Context store, when more than one is configured.' }
        } },
        run: async (args, ctx) => {
            checkContextTarget((await ctx.api.getFlows()).flows, args.scope, args.id);
            // The API answers a delete of a key that does not exist like any other; checked here,
            // so "deleted" means something was.
            const listing = await ctx.api.getContext(args.scope, args.id);
            const holders = Object.entries(listing || {}).filter(([, keys]) => keys && Object.prototype.hasOwnProperty.call(keys, args.key)).map(([st]) => st);
            if (args.store ? !holders.includes(args.store) : !holders.length) {
                throw new ToolError('No key ' + JSON.stringify(args.key) + ' in ' + (args.store ? 'store ' + args.store + ' of ' : '')
                    + args.scope + ' context' + (holders.length ? ' (it is in: ' + holders.join(', ') + ')' : '') + '. Nothing was deleted.');
            }
            await ctx.api.deleteContext(args.scope, args.id, args.key, args.store);
            const summary = 'Deleted ' + args.scope + (args.id ? ' ' + args.id : '') + ' context key ' + args.key;
            const instance = ctx.instance && ctx.instance.name;
            ctx.emit({ event: 'context-deleted', tool: 'delete_context', instance, ...caller(ctx.claims), summary });
            return { ok: true, instance, summary };
        }
    }
];

// No runtime group: stopping the flows over MCP stops the server serving MCP, and starting them
// again is then out of reach. That stays an editor action.
const GROUPS = { read: READ, flows: FLOWS, test: TEST, context: CONTEXT };

// What the server tells a client about these tools on connect, for the groups that are on. How
// they are meant to be used together is not in any one tool's description.
function instructionsFor(groups, instance) {
    const name = instance && instance.name, description = instance && instance.description;
    const parts = [(name ? 'These tools administer the Node-RED instance "' + name + '"'
            + (description ? ' — ' + description.replace(/\s*\.?\s*$/, '') : '') + '. Other servers may offer the same tools for other instances; '
            + 'every answer that changes something names the instance it changed.'
            : 'These tools administer a Node-RED instance.')
        + ' Start with list_flows for an overview, then get_flow, get_node or find_nodes for detail. '
        + 'Ids from those answers are what every other tool takes; tab labels are not unique. '
        + 'get_context without a key lists keys only; ask for one key at a time. Values that look like secrets '
        + 'are masked as «masked: N chars»: leave them out of any write.'];
    if (groups.flows) {
        parts.push('Change flows with patch_nodes (edit properties of existing nodes), add_nodes and remove_nodes '
            + 'rather than recreating flows. Every change is validated and refused if it would break wires or '
            + 'references; dry_run: true shows what would change first. Each deployed change is snapshotted: '
            + 'list_snapshots and rollback undo it; run rollback with dry_run first, since it restores everything. '
            + 'Reads answer a rev: pass it as expected_rev so a write is refused if the flows changed since you looked. '
            + 'A conflict means someone else deployed in between: read again and redo it. '
            + 'The MCP server these tools are served by cannot be changed from here.');
    }
    if (groups.test) {
        parts.push('To test a flow, inject an inject node, then call get_debug with since set to the time inject '
            + 'returned, to see debug output and node warnings and errors.');
    }
    return parts.join(' ');
}

// The arguments of a call as the call log records them: enough to see what was asked, not a copy
// of every function body a patch carried. Strings are cut, long arrays counted, depth bounded.
function summarizeArgs(value, depth = 0) {
    if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) + '… (' + value.length + ' chars)' : value;
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 5) return Array.isArray(value) ? '[' + value.length + ' items]' : '{…}';
    if (Array.isArray(value)) {
        const head = value.slice(0, 10).map(v => summarizeArgs(v, depth + 1));
        return value.length > 10 ? head.concat('… ' + (value.length - 10) + ' more') : head;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = summarizeArgs(v, depth + 1);
    return out;
}

// Whether an answer reports success, and if not, why — for the call log.
function outcome(result) {
    if (!result || typeof result !== 'object') return { ok: true };
    if (result.ok === false || result.error) return { ok: false, error: result.error || (result.errors || [])[0] || 'refused' };
    return { ok: true };
}

// Runs one tool and answers with something JSON-serialisable; failures become { error } so the
// caller reads the reason instead of a generic tool failure.
async function runTool(tool, args, ctx) {
    try {
        return await tool.run(args && typeof args === 'object' ? args : {}, ctx);
    } catch (e) {
        // One failure shape for every tool: ok false and the reason in error. Refusals add detail
        // (errors from validation, conflict on a stale revision), but always in this envelope.
        if (e instanceof ToolError || e instanceof AdminApiError) return { ok: false, error: e.message };
        return { ok: false, error: 'Unexpected error in ' + tool.name + ': ' + e.message };
    }
}

module.exports = { GROUPS, runTool, writeFlows, diff, ToolError, instructionsFor, summarizeArgs, outcome, caller };
