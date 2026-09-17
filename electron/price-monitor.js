'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { evaluate, initialState, normalizeState, validPrice, formatAlert } = require('./price-alert-engine');

const QUOTE_URL = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD';
const POLL_MS = 30_000;

async function fetchPrice() {
    // One provider on both platforms avoids spurious crossings on source switches.
    const response = await fetch(QUOTE_URL, { signal: AbortSignal.timeout(12_000), cache: 'no-store' });
    if (!response.ok) throw new Error(`Price provider returned HTTP ${response.status}`);
    const data = await response.json();
    const price = Number(Object.values(data.result || {})[0]?.c?.[0]);
    if (data.error?.length || !validPrice(price)) throw new Error('Price provider returned an invalid quote');
    return price;
}

function fileStore(filename) {
    return {
        async read() {
            try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        async write(value) {
            await fs.mkdir(path.dirname(filename), { recursive: true });
            const temporary = `${filename}.tmp`;
            await fs.writeFile(temporary, JSON.stringify(value), 'utf8');
            await fs.rename(temporary, filename);
        }
    };
}

class PriceMonitor {
    constructor({ store, quote = fetchPrice, notify, now = Date.now }) {
        this.store = store;
        this.quote = quote;
        this.notify = notify;
        this.now = now;
        this.data = { version: 1, enabled: true, engine: initialState(), lastAlert: null, pending: null, lastCheckAt: null };
        this.error = null;
        this.queue = Promise.resolve();
        this.timer = null;
    }

    async load() {
        const saved = await this.store.read();
        if (saved) {
            if (saved.version !== 1) throw new Error('Unsupported alert state version');
            this.data = { ...this.data, ...saved, enabled: saved.enabled !== false, engine: normalizeState(saved.engine) };
        }
    }

    serial(action) {
        const result = this.queue.then(action);
        this.queue = result.catch(() => {});
        return result;
    }

    async save(data) {
        await this.store.write(data);
        this.data = data;
    }

    async deliverPending() {
        if (!this.data.pending) return;
        await this.notify(this.data.pending);
        await this.save({ ...this.data, lastAlert: this.data.pending, pending: null });
    }

    poll() {
        return this.serial(async () => {
            if (!this.data.enabled) return;
            try {
                await this.deliverPending();
                const price = await this.quote();
                if (!validPrice(price)) throw new Error('Price provider returned an invalid quote');
                const result = evaluate(this.data.engine, price);
                const time = this.now();
                const pending = result.alert ? { ...result.alert, ...formatAlert(result.alert), at: time, id: `btc-${time}` } : null;
                // Persist the reference, hysteresis and pending notification together.
                await this.save({ ...this.data, engine: result.state, pending, lastCheckAt: time });
                await this.deliverPending();
                this.error = null;
            } catch (error) {
                this.error = this.data.pending ? 'Notification delivery failed. Retrying.' : 'Monitoring interrupted. Retrying when the connection returns.';
            }
        });
    }

    async setEnabled(enabled) {
        await this.serial(async () => {
            const changed = this.data.enabled !== enabled;
            await this.save({ ...this.data, enabled, engine: changed ? initialState() : this.data.engine, pending: changed ? null : this.data.pending, lastCheckAt: changed ? null : this.data.lastCheckAt });
            this.error = null;
        });
        if (enabled) await this.poll();
        return this.status();
    }

    status() {
        const stale = this.data.lastCheckAt && this.now() - this.data.lastCheckAt > POLL_MS * 3;
        return {
            enabled: this.data.enabled,
            status: !this.data.enabled ? 'paused' : this.error || stale ? 'interrupted' : this.data.engine.reference === null ? 'connecting' : 'monitoring',
            message: this.error || (stale ? 'Waiting for a fresh quote.' : null),
            lastCheckAt: this.data.lastCheckAt,
            lastAlert: this.data.lastAlert,
            platform: 'desktop'
        };
    }

    start() {
        if (this.timer) return;
        void this.poll();
        this.timer = setInterval(() => void this.poll(), POLL_MS);
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
        return this.queue;
    }
}

module.exports = { PriceMonitor, fileStore, fetchPrice, POLL_MS };
