const test = require('node:test');
const assert = require('node:assert/strict');
const vectors = require('../app/src/test/resources/price-alert-vectors.json');
const { evaluate, initialState, formatAlert } = require('../electron/price-alert-engine');
const { PriceMonitor } = require('../electron/price-monitor');

for (const vector of vectors) {
    test(vector.name, () => {
        let state = initialState();
        const alerts = [];
        vector.prices.forEach((price, index) => {
            const result = evaluate(state, price);
            // Round-trip every sample, covering process restart persistence.
            state = JSON.parse(JSON.stringify(result.state));
            if (result.alert) alerts.push({ index, levels: result.alert.levels, percentage: result.alert.percentageTriggered, direction: result.alert.direction });
        });
        assert.deepEqual(alerts, vector.alerts);
        assert.equal(state.reference, vector.reference);
    });
}

test('invalid quotes neither initialize nor mutate the reference', () => {
    const state = evaluate(initialState(), 80000).state;
    for (const price of [NaN, Infinity, -1, 0, null, undefined, '82000']) {
        assert.deepEqual(evaluate(state, price), { state, alert: null });
        assert.equal(evaluate(initialState(), price).state.reference, null);
    }
});

test('notification contains the quote, direction, reference change and crossed boundary', () => {
    const { alert } = evaluate(evaluate(initialState(), 78400).state, 80050);
    assert.deepEqual(formatAlert(alert), { title: 'Bitcoin ↑ · $80,050.00', body: 'Crossed $80,000 ↑ · +2.10% since last reference' });
});

function harness(prices) {
    let saved = null;
    let clock = 1700000000000;
    const notifications = [];
    const store = { read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); } };
    const options = { store, quote: async () => { const p = prices.shift(); if (p instanceof Error) throw p; return p; }, notify: async alert => { notifications.push(alert); }, now: () => ++clock };
    return { monitor: new PriceMonitor(options), options, notifications, saved: () => saved };
}

test('monitor delivers one combined alert and resumes from persisted state', async () => {
    const h = harness([78400, 80050, 80051]);
    await h.monitor.load();
    await h.monitor.poll();
    assert.equal(h.notifications.length, 0);
    await h.monitor.poll();
    const restarted = new PriceMonitor(h.options);
    await restarted.load();
    await restarted.poll();
    assert.equal(h.notifications.length, 1);
    assert.equal(restarted.data.engine.reference, 80050);
    assert.deepEqual(h.notifications[0].levels, [80000]);
});

test('offline and invalid samples preserve state, recovery uses the original reference', async () => {
    const h = harness([80000, new Error('offline'), NaN, 81600]);
    await h.monitor.poll();
    const before = structuredClone(h.monitor.data.engine);
    await h.monitor.poll();
    assert.equal(h.monitor.status().status, 'interrupted');
    assert.deepEqual(h.monitor.data.engine, before);
    await h.monitor.poll();
    assert.deepEqual(h.monitor.data.engine, before);
    await h.monitor.poll();
    assert.equal(h.monitor.status().status, 'monitoring');
    assert.equal(h.notifications.length, 1);
});

test('pausing stops checks; restarting establishes a fresh reference silently', async () => {
    const h = harness([80000, 100000]);
    await h.monitor.poll();
    await h.monitor.setEnabled(false);
    await h.monitor.poll();
    assert.equal(h.monitor.status().status, 'paused');
    await h.monitor.setEnabled(true);
    assert.equal(h.monitor.data.engine.reference, 100000);
    assert.equal(h.notifications.length, 0);
});

test('failed delivery is persisted and retried after restart without a second alert', async () => {
    const h = harness([80000, 81600, 81601]);
    h.monitor.notify = async () => { throw new Error('notifications unavailable'); };
    await h.monitor.poll();
    await h.monitor.poll();
    assert.ok(h.saved().pending);
    assert.equal(h.monitor.data.lastAlert, null);
    const restarted = new PriceMonitor(h.options);
    await restarted.load();
    await restarted.poll();
    assert.equal(h.notifications.length, 1);
    assert.equal(restarted.data.pending, null);
    assert.equal(restarted.data.engine.reference, 81600);
});

test('overlapping polls serialize to avoid duplicate alerts', async () => {
    const h = harness([80000, 81600, 81600]);
    await Promise.all([h.monitor.poll(), h.monitor.poll(), h.monitor.poll()]);
    assert.equal(h.notifications.length, 1);
});

test('failed persistence prevents notification and reference advance', async () => {
    const h = harness([80000, 81600]);
    await h.monitor.poll();
    h.options.store.write = async () => { throw new Error('disk full'); };
    await h.monitor.poll();
    assert.equal(h.notifications.length, 0);
    assert.equal(h.monitor.data.engine.reference, 80000);
    assert.equal(h.monitor.status().status, 'interrupted');
});
