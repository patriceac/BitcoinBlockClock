const test = require('node:test');
const assert = require('node:assert/strict');
const { TrayAttention, DEFAULT_TOOLTIP } = require('../electron/tray-attention');
const { PriceMonitor } = require('../electron/price-monitor');

function memoryStore() {
    let saved = null;
    return { read: async () => structuredClone(saved), write: async data => { saved = structuredClone(data); } };
}

const alert = { id: 'first', title: 'Bitcoin ↑ · $80,050.00', body: 'Crossed $80,000 ↑ · +2.10% since last reference' };

test('no alert means the plain icon and no price tooltip', async () => {
    const attention = new TrayAttention({ store: memoryStore() });
    await attention.load();
    await attention.acknowledge();
    assert.equal(attention.alert, null);
    assert.equal(attention.tooltip(), DEFAULT_TOOLTIP);
});

test('tray badge color follows the latest alert direction across restart and acknowledgement', async () => {
    const store = memoryStore();
    const attention = new TrayAttention({ store });
    await attention.load();
    assert.equal(attention.iconName(), 'bitcoin-logo');

    await attention.mark({ ...alert, direction: 'up' });
    assert.equal(attention.iconName(), 'bitcoin-alert-up');

    const restarted = new TrayAttention({ store });
    await restarted.load();
    assert.equal(restarted.iconName(), 'bitcoin-alert-up');

    await restarted.mark({ ...alert, id: 'down', direction: 'down' });
    assert.equal(restarted.iconName(), 'bitcoin-alert');
    await restarted.acknowledge();
    assert.equal(restarted.iconName(), 'bitcoin-logo');
});

test('unread alert survives restart and acknowledgement stays cleared after restart', async () => {
    const store = memoryStore();
    const attention = new TrayAttention({ store });
    await attention.mark(alert);
    const restarted = new TrayAttention({ store });
    await restarted.load();
    assert.deepEqual(restarted.alert, alert);
    assert.equal(restarted.tooltip(), `${alert.title}\n${alert.body}`);
    await restarted.acknowledge();
    const reopened = new TrayAttention({ store });
    await reopened.load();
    assert.equal(reopened.alert, null);
});

test('multiple movements retain one dot with the latest alert details', async () => {
    const attention = new TrayAttention({ store: memoryStore() });
    await attention.mark(alert);
    const next = { ...alert, id: 'second', title: 'Bitcoin ↓ · $78,400.00' };
    await attention.mark(next);
    assert.deepEqual(attention.alert, next);
    assert.ok(attention.tooltip().includes(next.title));
});

test('a pending delivery retry after restart cannot resurrect an acknowledged alert', async () => {
    const store = memoryStore();
    const attention = new TrayAttention({ store });
    await attention.mark(alert);
    await attention.acknowledge();
    const restarted = new TrayAttention({ store });
    await restarted.load();
    await restarted.mark(alert);
    assert.equal(restarted.alert, null);
    await restarted.mark({ ...alert, id: 'new-movement' });
    assert.equal(restarted.alert.id, 'new-movement');
});

test('opening the dashboard during persistence clears that alert; a later alert marks again', async () => {
    const rendered = [];
    const attention = new TrayAttention({ store: memoryStore(), render: () => rendered.push(attention.alert?.id || null) });
    const marked = attention.mark(alert);
    const cleared = attention.acknowledge();
    const remarked = attention.mark({ ...alert, id: 'later' });
    await Promise.all([marked, cleared, remarked]);
    assert.deepEqual(rendered, ['first', null, 'later']);
    assert.equal(attention.alert.id, 'later');
});

test('a failed acknowledgement keeps attention visible for retry', async () => {
    const store = memoryStore();
    const attention = new TrayAttention({ store });
    await attention.mark(alert);
    store.write = async () => { throw new Error('disk full'); };
    await assert.rejects(attention.acknowledge(), /disk full/);
    assert.deepEqual(attention.alert, alert);
});

test('only qualifying movement marks attention; failed delivery retries without losing the alert', async () => {
    const attentionStore = memoryStore();
    const attention = new TrayAttention({ store: attentionStore });
    const prices = [79900, 79910, 80050, 80051];
    const monitor = new PriceMonitor({ store: memoryStore(), quote: async () => prices.shift(), notify: value => attention.mark(value) });
    await monitor.poll();
    await monitor.poll();
    assert.equal(attention.alert, null);
    const write = attentionStore.write;
    attentionStore.write = async () => { throw new Error('disk full'); };
    await monitor.poll();
    assert.equal(attention.alert, null);
    assert.ok(monitor.data.pending);
    attentionStore.write = write;
    await monitor.poll();
    assert.deepEqual(attention.alert.levels, [80000]);
    assert.equal(monitor.data.pending, null);
    assert.equal(monitor.data.engine.reference, 80050);
});
