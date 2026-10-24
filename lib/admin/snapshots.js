'use strict';
// The configuration as it was before each write, kept as local files so a change can be undone.
// Deliberately small — save, list, load, remove — so that another backing (Node-RED projects,
// say) can stand in later without the tools noticing.
//
// Each file holds the whole GET /flows answer, which never contains credentials. A rollback
// therefore restores configuration only; the runtime keeps the stored credentials of every node
// whose id is still there.

const fs = require('fs');
const path = require('path');

const SNAPSHOT_ID = /^\d{13}-[0-9a-f]{6}$/;

function createSnapshotStore({ dir, keep = 20 }) {
    const file = id => path.join(dir, id + '.json');
    // Ids sort by their time part, and rotation trusts that order: two saves in one millisecond
    // must still get increasing ids, or trimming could drop the newer one.
    let lastTime = 0;

    function ids() {
        let names;
        try { names = fs.readdirSync(dir); } catch { return []; }
        return names.map(f => f.replace(/\.json$/, '')).filter(id => SNAPSHOT_ID.test(id)).sort();
    }

    function save({ rev, flows, meta }) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        lastTime = Math.max(Date.now(), lastTime + 1);
        const id = lastTime + '-' + require('crypto').randomBytes(3).toString('hex');
        const record = { id, time: new Date().toISOString(), rev, meta: meta || {}, flows };
        fs.writeFileSync(file(id), JSON.stringify(record), { mode: 0o600 });
        // Oldest first, so trimming keeps the most recent `keep`.
        const all = ids();
        for (const old of all.slice(0, Math.max(0, all.length - keep))) {
            try { fs.unlinkSync(file(old)); } catch { /* already gone */ }
        }
        return id;
    }

    function load(id) {
        if (!SNAPSHOT_ID.test(String(id))) return null;
        try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
    }

    // Newest first, without the flows themselves.
    function list() {
        return ids().reverse().map(id => {
            const r = load(id);
            return r ? { id, time: r.time, rev: r.rev, nodes: (r.flows || []).length, ...r.meta } : null;
        }).filter(Boolean);
    }

    function remove(id) {
        if (!SNAPSHOT_ID.test(String(id))) return;
        try { fs.unlinkSync(file(id)); } catch { /* already gone */ }
    }

    return { save, load, list, remove };
}

module.exports = { createSnapshotStore, SNAPSHOT_ID };
