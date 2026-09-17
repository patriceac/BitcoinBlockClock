'use strict';

const DEFAULT_TOOLTIP = 'Bitcoin Block Clock';

class TrayAttention {
    constructor({ store, render = () => {} }) {
        this.store = store;
        this.render = render;
        this.alert = null;
        this.lastAcknowledgedId = null;
        this.queue = Promise.resolve();
    }

    serial(action) {
        const result = this.queue.then(action);
        this.queue = result.catch(() => {});
        return result;
    }

    load() {
        return this.serial(async () => {
            const saved = await this.store.read();
            if (saved && saved.version !== 1) throw new Error('Unsupported tray attention state');
            this.alert = saved?.alert || null;
            this.lastAcknowledgedId = saved?.lastAcknowledgedId || null;
            this.render();
        });
    }

    mark(alert) {
        return this.serial(async () => {
            // A monitor retry after a crash must not resurrect an already-read alert.
            if (alert.id && alert.id === this.lastAcknowledgedId) {
                this.render();
                return;
            }
            await this.store.write({ version: 1, alert, lastAcknowledgedId: this.lastAcknowledgedId });
            this.alert = alert;
            this.render();
        });
    }

    acknowledge() {
        return this.serial(async () => {
            if (!this.alert) return;
            const lastAcknowledgedId = this.alert.id;
            await this.store.write({ version: 1, alert: null, lastAcknowledgedId });
            this.alert = null;
            this.lastAcknowledgedId = lastAcknowledgedId;
            this.render();
        });
    }

    tooltip() {
        return this.alert ? `${this.alert.title}\n${this.alert.body}`.slice(0, 127) : DEFAULT_TOOLTIP;
    }
}

module.exports = { TrayAttention, DEFAULT_TOOLTIP };
