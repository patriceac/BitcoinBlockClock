'use strict';

// Keep this pure reducer in sync with PriceAlertEngine.kt and the shared vectors.
const STEP = 5000;
const MOVEMENT = 0.02;
const REARM = 0.01;
const EPSILON = 1e-10;

function initialState() {
    return { reference: null, previous: null, blocked: [] };
}

function validPrice(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeState(value) {
    if (!validPrice(value?.reference) || !validPrice(value?.previous)) return initialState();
    return {
        reference: value.reference,
        previous: value.previous,
        blocked: [...new Set((Array.isArray(value.blocked) ? value.blocked : [])
            .filter(level => validPrice(level) && level % STEP === 0))]
    };
}

function evaluate(state, price) {
    const next = normalizeState(state);
    if (!validPrice(price)) return { state: next, alert: null };
    if (next.reference === null) {
        return { state: { reference: price, previous: price, blocked: [] }, alert: null };
    }
    const blocked = new Set(next.blocked);
    const levels = [];
    const up = price > next.previous;
    const low = Math.min(price, next.previous);
    const high = Math.max(price, next.previous);
    for (let level = Math.ceil(low / STEP) * STEP; level <= high; level += STEP) {
        if (level <= 0 || blocked.has(level)) continue;
        if ((next.previous < level && price >= level) || (next.previous > level && price <= level)) {
            levels.push(level);
        }
    }
    if (!up) levels.reverse();

    // A crossing while still blocked cannot rearm itself retroactively. Once a
    // sample is >=1% away, the *following* crossing can alert. An overshooting
    // first crossing already establishes that distance for the next sample.
    for (const level of [...blocked, ...levels]) {
        if (Math.abs(price - level) / level + EPSILON >= REARM) blocked.delete(level);
        else blocked.add(level);
    }
    const changePercent = (price / next.reference - 1) * 100;
    const percentageTriggered = Math.abs(price - next.reference) / next.reference + EPSILON >= MOVEMENT;
    const alert = percentageTriggered || levels.length ? {
        price,
        reference: next.reference,
        changePercent,
        direction: levels.length ? (up ? 'up' : 'down') : (changePercent >= 0 ? 'up' : 'down'),
        levels,
        percentageTriggered
    } : null;
    return {
        state: { reference: alert ? price : next.reference, previous: price, blocked: [...blocked].sort((a, b) => a - b) },
        alert
    };
}

function formatAlert(alert) {
    const usd = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
    const level = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
    const arrow = alert.direction === 'up' ? '↑' : '↓';
    const percent = `${alert.changePercent >= 0 ? '+' : ''}${alert.changePercent.toFixed(2)}%`;
    return {
        title: `Bitcoin ${arrow} · ${usd(alert.price)}`,
        body: `${alert.levels.length ? `Crossed ${alert.levels.map(level).join(', ')} ${arrow} · ` : ''}${percent} since last reference`
    };
}

module.exports = { evaluate, initialState, normalizeState, validPrice, formatAlert };
