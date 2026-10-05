'use strict';
// node --test examples/sl/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib.js');

// Fake deps: routes by URL prefix, records every request.
function fakeDeps(routes, now = '2026-10-05T08:30:00+02:00') {
    const store = {};
    const seen = [];
    return {
        seen,
        get: async (url) => {
            seen.push(url);
            const hit = Object.entries(routes).find(([k]) => url.includes(k));
            return hit ? { status: 200, body: hit[1] } : { status: 404, body: null };
        },
        cache: L.contextCache({ get: (k) => store[k], set: (k, v) => { store[k] = v; } }),
        now: () => new Date(now),
    };
}

const STOPS = {
    locations: [
        { id: '9091001000001079', name: 'Stockholm, Stockholm Odenplan', disassembledName: 'Stockholm Odenplan', type: 'stop', matchQuality: 948, isBest: false },
        { id: '9091001000009117', name: 'Stockholm, Odenplan', disassembledName: 'Odenplan', type: 'stop', matchQuality: 1000, isBest: true },
        { id: '9091001000007861', name: 'Södertälje, Åby', type: 'stop', matchQuality: 325, isBest: false },
    ],
};

const dep = (line, mode, dir, sched, exp, extra = {}) => ({
    destination: 'X', direction_code: dir, state: 'EXPECTED', display: 'Nu',
    scheduled: sched, expected: exp,
    stop_area: { name: 'Odenplan' }, stop_point: { designation: '2' },
    line: { designation: line, transport_mode: mode }, deviations: [], ...extra,
});

test('time: Swedish offset in summer and winter, UTC input converted', () => {
    assert.equal(L.localIso(new Date('2026-10-05T06:28:48Z')), '2026-10-05T08:28:48+02:00');
    assert.equal(L.localIso(new Date('2026-12-01T06:00:00Z')), '2026-12-01T07:00:00+01:00');
    assert.equal(L.localIso(L.fromLocal('2026-10-05T08:27:00')), '2026-10-05T08:27:00+02:00');
    assert.equal(L.localIso(L.fromLocal('2026-01-05T08:27:00')), '2026-01-05T08:27:00+01:00');
    assert.equal(L.localIso(L.fromLocal('2024-01-03T07:45:54.66+01:00')), '2024-01-03T07:45:54+01:00');
});

test('ids: site <-> journey id stays exact past MAX_SAFE_INTEGER', () => {
    assert.deepEqual(L.stopId('9117'), { site_id: 9117, journey_id: '9091001000009117' });
    assert.deepEqual(L.stopId('9091001000001079'), { site_id: 1079, journey_id: '9091001000001079' });
    assert.equal(L.siteOf('9025001000001132'), null);
    assert.equal(L.stopId('Odenplan'), null);
});

test('validation rejects injection before any request', async () => {
    const d = fakeDeps({});
    for (const [tool, args] of [
        ['sl_departures', { stop: 'Odenplan', line: '19&x=1' }],
        ['sl_departures', { stop: 'Odenplan', transport_mode: 'ROCKET' }],
        ['sl_departures', {}],
        ['sl_plan_trip', { from: 'a', to: 'b', date: 'igår' }],
        ['sl_plan_trip', { from: 'a', to: 'b', time: '25:00' }],
        ['sl_plan_trip', { from: 'a', to: 'b', arrive_by: true }],
        ['sl_plan_trip', { from: '91,18', to: 'b' }],
        ['sl_find_stop', { query: 'x', types: ['planet'] }],
    ]) {
        const r = await L.run(tool, args, d);
        assert.ok(r.error, `${tool} ${JSON.stringify(args)} should fail`);
    }
    assert.equal(d.seen.length, 0);
});

test('find_stop: best first, weak guesses dropped', async () => {
    const r = await L.run('sl_find_stop', { query: 'odenplan' }, fakeDeps({ 'stop-finder': STOPS }));
    assert.deepEqual(r.results.map((x) => x.site_id), [9117, 1079]);
    assert.equal(r.results[0].best, true);
});

test('departures: resolves name, filters, drops departed, sorts, caches', async () => {
    const d = fakeDeps({
        'stop-finder': STOPS,
        '/sites/9117/departures': {
            departures: [
                dep('19', 'METRO', 2, '2026-10-05T08:35:00', '2026-10-05T08:37:00'),
                dep('18', 'METRO', 2, '2026-10-05T08:20:00', '2026-10-05T08:22:00', { state: 'CANCELLED' }),
                dep('17', 'METRO', 2, '2026-10-05T08:32:00', '2026-10-05T08:32:00'),
                dep('41', 'TRAIN', 1, '2026-10-05T08:31:00', '2026-10-05T08:31:00'),
                dep('2', 'BUS', 2, '2026-10-05T08:40:00', '2026-10-05T08:40:00'),
            ],
            stop_deviations: [{ message: 'Hissen är avstängd' }],
        },
    });
    const r = await L.run('sl_departures', { stop: 'Odenplan', transport_mode: 'metro', direction: 2 }, d);
    assert.equal(r.stop.site_id, 9117);
    assert.deepEqual(r.departures.map((x) => x.line), ['17', '19']);
    assert.equal(r.departures[1].in_min, 7);
    assert.equal(r.departures[1].delay_min, 2);
    assert.equal(r.departures[0].delay_min, undefined);
    assert.deepEqual(r.stop_deviations, ['Hissen är avstängd']);
    assert.deepEqual(r.alternatives, [{ name: 'Stockholm Odenplan', site_id: 1079 }]);

    await L.run('sl_departures', { stop: 'Odenplan', line: '41' }, d);
    assert.equal(d.seen.length, 2, 'second call served from cache');
});

test('departures: unknown name is an error, not a guess', async () => {
    const r = await L.run('sl_departures', { stop: 'xyzzy' }, fakeDeps({ 'stop-finder': { locations: [STOPS.locations[2]] } }));
    assert.match(r.error, /No SL stop matches/);
});

test('deviations: one shared unfiltered request, filtered and ranked here', async () => {
    const msg = (id, imp, linesArr, from) => ({
        deviation_case_id: id, publish: { from, upto: '2026-10-09T06:31:00+02:00' },
        priority: { importance_level: imp, influence_level: 3, urgency_level: 1 },
        message_variants: [{ header: `h${id}`, details: 'd', scope_alias: 'a', language: 'sv' }],
        scope: { stop_areas: [{ name: 'Alvik' }, { name: 'Alvik' }], lines: linesArr },
    });
    const d = fakeDeps({
        'deviations.integration': [
            msg(1, 2, [{ designation: '19', transport_mode: 'METRO' }], '2026-10-02T05:31:38+02:00'),
            msg(2, 7, [{ designation: '57', transport_mode: 'BUS' }], '2026-10-01T05:00:00+02:00'),
            msg(3, 5, [{ designation: '13', transport_mode: 'METRO' }], '2026-10-05T07:49:02+02:00'),
        ],
    });
    const metro = await L.run('sl_deviations', { transport_mode: 'METRO' }, d);
    assert.deepEqual(metro.deviations.map((x) => x.header), ['h3', 'h1']);
    assert.deepEqual(metro.deviations[1].stops, ['Alvik']);
    const l19 = await L.run('sl_deviations', { line: ['19'] }, d);
    assert.equal(l19.total, 1);
    assert.equal(d.seen.length, 1);
    assert.ok(!d.seen[0].includes('site='));
});

test('plan_trip: exclusion becomes an allowlist; walks merge; alternates reported', async () => {
    const d = fakeDeps({
        'stop-finder': {
            locations: [
                { id: 'streetID:1', name: 'Danderyd, Sveavägen 50', type: 'singlehouse', matchQuality: 900, isBest: true },
                { id: 'streetID:2', name: 'Stockholm, Sveavägen 50', type: 'singlehouse', matchQuality: 880, isBest: false },
            ],
        },
        '/trips': {
            systemMessages: [],
            journeys: [{
                tripDuration: 600, tripRtDuration: 660, interchanges: 0,
                legs: [
                    {
                        duration: 240, origin: { name: 'Odenplan', disassembledName: '2', departureTimePlanned: '2026-10-05T06:30:00Z', departureTimeEstimated: '2026-10-05T06:31:00Z' },
                        destination: { name: 'S:t Eriksplan', arrivalTimePlanned: '2026-10-05T06:34:00Z' },
                        transportation: { disassembledName: '19', product: { class: 2, name: 'Tunnelbana' }, destination: { name: 'Alvik' } },
                        infos: [{ subtitle: 'Hiss ur drift' }, { subtitle: 'Hiss ur drift' }],
                    },
                    { duration: 120, origin: { name: 'S:t Eriksplan' }, destination: { name: 'S:t Eriksplan' }, transportation: { product: { class: 99, name: 'footpath' } } },
                    { duration: 300, origin: { name: 'S:t Eriksplan' }, destination: { name: 'Sveavägen 50', arrivalTimePlanned: '2026-10-05T06:41:00Z' }, transportation: { product: { class: 100, name: 'footpath' } } },
                ],
            }],
        },
    });
    const r = await L.run('sl_plan_trip', { from: '9117', to: 'Sveavägen 50', exclude_modes: ['METRO'], time: '08:30' }, d);
    const tripUrl = d.seen.find((u) => u.includes('/trips'));
    assert.ok(!tripUrl.includes('incl_mot_2'));
    for (const k of [0, 4, 5, 9, 10, 14, 19]) assert.ok(tripUrl.includes(`incl_mot_${k}=true`), `incl_mot_${k}`);
    assert.ok(tripUrl.includes('itd_time=0830'));
    assert.ok(tripUrl.includes('itd_date=20261005'));
    assert.ok(tripUrl.includes('name_origin=9091001000009117'));

    const j = r.journeys[0];
    assert.equal(j.depart, '2026-10-05T08:31:00+02:00');
    assert.equal(j.arrive, '2026-10-05T08:41:00+02:00');
    assert.equal(j.duration_min, 11);
    assert.deepEqual(j.legs.map((l) => l.mode), ['METRO', 'WALK']);
    assert.equal(j.legs[1].minutes, 7);
    assert.deepEqual(j.legs[0].infos, ['Hiss ur drift']);
    assert.deepEqual(r.also_matched, { to: ['Stockholm, Sveavägen 50'] });
});

test('plan_trip: coordinates are lon:lat and need no lookup', async () => {
    const d = fakeDeps({ '/trips': { journeys: [] } });
    const r = await L.run('sl_plan_trip', { from: '59.3429,18.0491', to: '9192' }, d);
    assert.equal(d.seen.length, 1);
    assert.ok(d.seen[0].includes('name_origin=' + encodeURIComponent('18.0491:59.3429:WGS84[dd.ddddd]')));
    assert.equal(r.note, 'No journeys found.');
});

test('http failure surfaces as error text', async () => {
    const d = fakeDeps({});
    const r = await L.run('sl_departures', { stop: '9117' }, d);
    assert.match(r.error, /HTTP 404/);
});
