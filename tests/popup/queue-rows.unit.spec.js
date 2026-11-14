const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSettingsSchema } = require('../_settings-schema.js');

// What a job says in the queue (ui/popup_queue_rows.js), from its record and the
// storage snapshot. Real store, lease and filters behind it. How the strips move
// and fold runs live in tests/popup/queue.spec.js.

const ROOT = path.join(__dirname, '..', '..');

function loadRows(over) {
    const sandbox = { window: { ILAP: {} }, chrome: { storage: { local: {} } }, Date, Math, JSON, setTimeout };
    vm.createContext(sandbox);
    const run = (file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox);
    run('src/escape.js');
    loadSettingsSchema(sandbox);
    run('src/curator/lease.js');
    run('src/curator/store.js');
    run('src/curator/filters.js');
    run('ui/icons.js');
    const W = sandbox.window;
    W.ILAP.t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);
    run('ui/popup_queue_rows.js');
    const deps = Object.assign({
        store: W.ILAP.Curator.Store,
        lease: W.ILAP.Curator.Lease,
        filters: W.ILAP_Filters,
        presetLabel: (key) => `list:${key}`,
    }, over);
    return { rows: W.ILAP_QueueRows.create(deps), W, Store: W.ILAP.Curator.Store, Lease: W.ILAP.Curator.Lease };
}

const NO_SKIPS = { unavailable: 0, wishlisted: 0, owned: 0 };
const state = (extra) => Object.assign({ cur: null, status: 'pending', cursor: 0, skipped: NO_SKIPS }, extra);

test.describe('Queue rows — what a job says (unit)', () => {
    test('a missing collaborator refuses construction', () => {
        const { W } = loadRows();
        expect(() => W.ILAP_QueueRows.create({ lease: {}, filters: {}, presetLabel: () => '' }))
            .toThrow('needs opts.store');
    });

    test('a curator\'s name from the record is escaped everywhere it lands', () => {
        const { rows } = loadRows();
        const html = rows.strip({ id: 'j"1', type: 'curator', curatorId: '5', filter: 'informational',
            curatorName: '<img src=x onerror=alert(1)>' }, state());
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
        expect(html).not.toContain('data-job-id="j"1"');
        expect(html).toContain('data-job-id="j&quot;1"');
    });

    test('the status comes from the lease: only a live lease naming this job runs', () => {
        const { rows, Lease } = loadRows();
        const job = { id: 'a', type: 'curator', curatorId: '5', status: 'pending' };
        const key = Lease.LOCK_PREFIX + '5';
        const now = 1000;
        expect(rows.statusOf(job, {}, now)).toBe('pending');
        expect(rows.statusOf(job, { [key]: { expiresAt: now + 1, jobId: 'a' } }, now)).toBe('running');
        expect(rows.statusOf(job, { [key]: { expiresAt: now + 1, jobId: 'b' } }, now)).toBe('pending');
        expect(rows.statusOf(job, { [key]: { expiresAt: now - 1, jobId: 'a' } }, now)).toBe('pending');
        expect(rows.statusOf(Object.assign({}, job, { status: 'paused' }),
            { [key]: { expiresAt: now + 1, jobId: 'a' } }, now)).toBe('paused');
    });

    test('its numbers come from the job\'s own keys, an old record\'s cursor from the record', () => {
        const { rows, Store } = loadRows();
        const job = { id: 'a', cursor: 2 };
        expect(rows.doneOf(job, {})).toBe(2);
        expect(rows.doneOf(job, { [Store.CURSOR_PREFIX + 'a']: 7 })).toBe(7);
        const skipped = rows.skippedOf(job, { [Store.SKIPPED_PREFIX + 'a']: 1, [Store.OWNED_PREFIX + 'a']: 3 });
        expect(JSON.parse(JSON.stringify(skipped))).toEqual({ unavailable: 1, wishlisted: 0, owned: 3 });
    });

    test('a gesture job shows what remains, any other job its percent', () => {
        const { rows, Store } = loadRows();
        const gesture = rows.strip({ id: Store.MI_ID, type: 'mi', total: 10 }, state({ status: 'running', cursor: 3 }));
        expect(gesture).toContain('queue-job-count');
        expect(gesture).toContain('>7</span>');
        expect(gesture).not.toContain('queue-mini');
        const list = rows.strip({ id: 'p', type: 'preset', presetKey: 'vr', total: 10 }, state({ status: 'running', cursor: 3 }));
        expect(list).toContain('queue-job-pct');
        expect(list).toContain('>30%</span>');
        expect(list).toContain('list:vr');
    });

    test('each type has its name, glyph and class', () => {
        const { rows } = loadRows();
        const parts = (job) => rows.parts(Object.assign({ id: 'x', curatorName: 'Rec', curatorId: '5', filter: 'informational' }, job), state());
        expect(parts({ type: 'curator' }).nameBox).toContain('Rec');
        expect(parts({ type: 'curator' }).glyph).toContain('queue-job-filter');
        expect(parts({ type: 'curator' }).open).toContain(' curator');
        expect(parts({ type: 'preset', presetKey: 'vr' }).nameBox).toContain('list:vr');
        expect(parts({ type: 'preset', presetKey: 'vr' }).glyph).toContain('presets_title');
        expect(parts({ type: 'preset', presetKey: 'vr' }).open).toContain(' preset');
        expect(parts({ type: 'bundle' }).nameBox).toContain('Rec');
        expect(parts({ type: 'bundle' }).glyph).toContain('queue-job-glyph');
        expect(parts({ type: 'mi' }).nameBox).toContain('mi_job_name');
        expect(parts({ type: 'mi' }).glyph).toBe('');
        expect(parts({ type: 'miundo' }).nameBox).toContain('miundo_job_name');
        expect(parts({ type: 'creator' }).nameBox).toContain('creator_job_name');
        expect(parts({ type: 'creator' }).glyph).toContain('queue-job-glyph');
        expect(parts({ type: 'undo' }).nameBox).toContain('undo_job_name');
        expect(parts({ type: 'undo', scope: { n: 3, unit: 'h' } }).nameBox).toContain('undo_job_hours');
    });

    test('a job type this build does not know keeps its record\'s name, with no prototype hit', () => {
        const { rows } = loadRows();
        const parts = rows.parts({ id: 'x', type: 'constructor', curatorName: 'Odd job' }, state());
        expect(parts.nameBox).toContain('Odd job');
        expect(parts.glyph).toBe('');
    });

    test('the current curator is marked, and only on its own curator jobs', () => {
        const { rows } = loadRows();
        const job = { id: 'a', type: 'curator', curatorId: '5', filter: 'informational' };
        expect(rows.parts(job, state({ cur: '5' })).open).toContain(' current');
        expect(rows.parts(job, state({ cur: '6' })).open).not.toContain(' current');
        expect(rows.parts(Object.assign({}, job, { type: 'preset' }), state({ cur: '5' })).open).not.toContain(' current');
    });

    test('a skip count shows as the warning mark, a pending job as the clock with the same lines', () => {
        const { rows } = loadRows();
        const job = { id: 'a', type: 'curator', curatorId: '5', filter: 'informational' };
        const skipped = { unavailable: 2, wishlisted: 0, owned: 1 };
        const running = rows.parts(job, state({ status: 'running', skipped })).skipBadge;
        expect(running).toContain('queue_skipped_unavailable');
        expect(running).toContain('queue_skipped_owned');
        expect(running).not.toContain('queue_skipped_wishlisted');
        expect(running).not.toContain('queue-job-wait');
        const pending = rows.parts(job, state({ skipped })).skipBadge;
        expect(pending).toContain('queue-job-wait');
        expect(pending).toContain('queue_skipped_owned');
        expect(rows.parts(job, state({ status: 'running' })).skipBadge).toBe('');
    });

    // A row out of room takes a slot's width from its name column, so a slot on
    // some strips only puts their mini bars out of line with the rest. This runs
    // on CI, unlike the two layout tests that measure the bars.
    test('every strip has the ⚠/clock slot, empty when there is nothing to show', () => {
        const { rows } = loadRows();
        const job = { id: 'a', type: 'curator', curatorId: '5', filter: 'informational' };
        const slot = (html) => (html.match(/class="queue-job-skip[ "]/g) || []).length;
        expect(rows.strip(job, state({ status: 'running' }))).toContain('<span class="queue-job-skip"></span>');
        expect(slot(rows.strip(job, state({ status: 'running' })))).toBe(1);
        expect(slot(rows.strip(job, state()))).toBe(1);
        expect(slot(rows.strip(job, state({ status: 'running', skipped: { unavailable: 2, wishlisted: 0, owned: 0 } })))).toBe(1);
    });

    test('Remove asks first: the job in question shows the two answers', () => {
        const { rows } = loadRows();
        const job = { id: 'a', type: 'curator', curatorId: '5', filter: 'informational' };
        expect(rows.parts(job, state()).actions).toContain('data-act="remove"');
        const asking = rows.parts(job, state({ asking: true })).actions;
        expect(asking).toContain('data-act="confirm"');
        expect(asking).toContain('data-act="cancel"');
        expect(asking).not.toContain('data-act="remove"');
    });

    test('with the extension off only Remove stays live', () => {
        const { rows } = loadRows();
        const job = { id: 'a', type: 'curator', curatorId: '5', filter: 'informational' };
        expect(rows.parts(job, state()).actions).not.toContain(' disabled');
        const off = rows.parts(job, state({ masterOff: true })).actions;
        expect(off).toMatch(/data-act="pause"[^>]* disabled/);
        expect(off).not.toMatch(/data-act="remove"[^>]* disabled/);
    });
});
