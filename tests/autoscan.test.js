const assert = require('node:assert/strict');
const test = require('node:test');

const autoscan = require('../app/src/main/assets/autoscan.js');

const START_TIME_MS = Date.UTC(2026, 0, 1);
const INTERVAL_MS = 10 * 60 * 1000;

function makeStructure(count, upperAt, lowerAt) {
    const candles = [];
    let previousClose = null;

    for (let index = 0; index < count; index += 1) {
        const upper = upperAt(index);
        const lower = lowerAt(index);
        const width = upper - lower;
        const oscillation = Math.cos(index * Math.PI / 4);
        const close = ((upper + lower) / 2) + (oscillation * ((width / 2) - 0.55));
        const open = previousClose ?? close;

        candles.push({
            timeMs: START_TIME_MS + (index * INTERVAL_MS),
            open,
            high: Math.min(upper, Math.max(open, close) + 0.5),
            low: Math.max(lower, Math.min(open, close) - 0.5),
            close
        });
        previousClose = close;
    }

    return candles;
}

function makeDescendingChannel(count = 64) {
    return makeStructure(count, index => 110 - (index * 0.16), index => 98 - (index * 0.16));
}

function appendChannelCloses(candles, closes) {
    closes.forEach((closeOrFactory, relativeIndex) => {
        const index = candles.length;
        const upper = 110 - (index * 0.16);
        const lower = 98 - (index * 0.16);
        const close = typeof closeOrFactory === 'function'
            ? closeOrFactory({ index, upper, lower })
            : closeOrFactory;
        candles.push({
            timeMs: START_TIME_MS + (index * INTERVAL_MS),
            open: close - 0.1,
            high: close + 0.5,
            low: close - 0.5,
            close
        });
    });
    return candles;
}

test('aggregateCandles preserves true OHLC values within each display bucket', () => {
    const raw = [
        { timeMs: START_TIME_MS, open: 100, high: 104, low: 99, close: 103 },
        { timeMs: START_TIME_MS + (5 * 60 * 1000), open: 103, high: 106, low: 101, close: 105 },
        { timeMs: START_TIME_MS + INTERVAL_MS, open: 105, high: 108, low: 102, close: 107 }
    ];

    assert.deepEqual(autoscan.aggregateCandles(raw, INTERVAL_MS), [
        { timeMs: START_TIME_MS, open: 100, high: 106, low: 99, close: 105 },
        { timeMs: START_TIME_MS + INTERVAL_MS, open: 105, high: 108, low: 102, close: 107 }
    ]);
});

test('finds descending channels, symmetrical triangles, and rising wedges from wick extremes', () => {
    const cases = [
        {
            candles: makeDescendingChannel(),
            expectedType: 'channel',
            expectedVariant: 'descending-channel'
        },
        {
            candles: makeStructure(64, index => 112 - (index * 0.16), index => 96 + (index * 0.16)),
            expectedType: 'triangle',
            expectedVariant: 'symmetrical-triangle'
        },
        {
            candles: makeStructure(64, index => 100 + (index * 0.22), index => 88 + (index * 0.34)),
            expectedType: 'wedge',
            expectedVariant: 'rising-wedge'
        }
    ];

    cases.forEach(({ candles, expectedType, expectedVariant }) => {
        const patterns = autoscan.scanPatterns(candles);
        assert.ok(patterns.some(pattern => (
            pattern.type === expectedType && pattern.variant === expectedVariant
        )), `missing ${expectedVariant}`);
        assert.ok(patterns.length <= 3);
        assert.ok(patterns.every(pattern => pattern.source === 'autoscan' && pattern.locked));
    });
});

test('finds conservative support, resistance, and sloping trend lines', () => {
    const horizontalRange = makeStructure(64, () => 112, () => 96);
    const rangePatterns = autoscan.scanPatterns(horizontalRange);
    const descendingPatterns = autoscan.scanPatterns(makeDescendingChannel());

    assert.ok(rangePatterns.some(pattern => pattern.variant === 'support' && pattern.touches.lower >= 3));
    assert.ok(rangePatterns.some(pattern => pattern.variant === 'resistance' && pattern.touches.upper >= 3));
    assert.ok(descendingPatterns.some(pattern => (
        pattern.type === 'trend' && pattern.variant === 'falling-support'
    )));
});

test('allows a clean no-result state when there is no validated structure', () => {
    const candles = Array.from({ length: 72 }, (_, index) => {
        const close = 100 + (index * 0.1);
        return {
            timeMs: START_TIME_MS + (index * INTERVAL_MS),
            open: close,
            high: close + 0.2,
            low: close - 0.2,
            close
        };
    });

    assert.deepEqual(autoscan.scanMarket(candles).patterns, []);
    assert.deepEqual(
        autoscan.scanMarket(candles, { lookbackWindows: [30, 45, 60] }).patterns,
        []
    );
    assert.deepEqual(autoscan.scanTentativePatterns(candles), []);
});

test('keeps lower-confidence structures separate from confirmed patterns', () => {
    const candles = makeDescendingChannel();
    const options = { qualityMultiplier: 0.8 };
    const confirmed = autoscan.scanMarket(candles, options).patterns;
    const tentative = autoscan.scanTentativePatterns(candles, options);

    assert.ok(confirmed.some(pattern => pattern.variant === 'descending-channel'));
    assert.ok(tentative.some(pattern => pattern.variant === 'resistance'));
    assert.ok(tentative.length <= 2);
    assert.ok(tentative.every(pattern => (
        pattern.confidence >= 0.56
        && pattern.confidence < 0.64
        && pattern.source === 'autoscan-tentative'
        && pattern.tentative
        && pattern.confidenceBand === 'tentative'
        && pattern.locked
        && pattern.id.startsWith('autoscan-tentative-')
    )));
    assert.ok(tentative.every(pattern => (
        Object.values(pattern.touches || {}).reduce((sum, count) => sum + count, 0) >= 3
    )));
    assert.equal(
        new Set(tentative.map(pattern => `${pattern.type}|${pattern.variant}`)).size,
        tentative.length
    );
    assert.deepEqual(tentative, autoscan.scanTentativePatterns(candles, options));
});

test('merges shorter lookback windows for a long-range chart without weakening confidence', () => {
    const noisyHistory = Array.from({ length: 120 }, (_, index) => {
        const center = index % 2 === 0 ? 145 : 72;
        return {
            timeMs: START_TIME_MS + (index * INTERVAL_MS),
            open: center,
            high: center + 8 + (index % 5),
            low: center - 8 - (index % 7),
            close: center + ((index % 3) - 1)
        };
    });
    const recentChannel = makeDescendingChannel(64).map((candle, index) => ({
        ...candle,
        timeMs: START_TIME_MS + ((noisyHistory.length + index) * INTERVAL_MS)
    }));
    const candles = [...noisyHistory, ...recentChannel];
    const result = autoscan.scanMarket(candles, { lookbackWindows: [64, 90, 120] });

    assert.deepEqual(result.diagnostics.windowsScanned, [64, 90, 120, candles.length]);
    assert.equal(result.candles.length, candles.length);
    assert.ok(result.patterns.some(pattern => (
        pattern.variant === 'descending-channel'
        && pattern.scanWindowCandles === 64
        && pattern.confidence >= 0.64
    )));
    assert.ok(result.patterns.length <= 3);
    assert.equal(
        new Set(result.patterns.map(pattern => `${pattern.type}|${pattern.variant}`)).size,
        result.patterns.length
    );
    assert.deepEqual(
        result,
        autoscan.scanMarket(candles, { lookbackWindows: [64, 90, 120] })
    );
});

test('requires two closed candles before reporting a descending-channel breakout', () => {
    const oneClose = appendChannelCloses(makeDescendingChannel(), [
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper + 2.2
    ]);
    const confirmed = appendChannelCloses(makeDescendingChannel(), [
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper - 0.3,
        ({ upper }) => upper + 2.2,
        ({ upper }) => upper + 2.3
    ]);

    assert.equal(autoscan.scanMarket(oneClose).events.length, 0);
    const event = autoscan.scanMarket(confirmed).events.find(item => (
        item.patternVariant === 'descending-channel' && item.kind === 'breakout'
    ));
    assert.ok(event);
    assert.equal(
        autoscan.formatEventCommentary(event, {
            rangeLabel: 'Day',
            assetLabel: 'BTC/USD',
            candleLabel: '10-minute'
        }),
        'Day: BTC/USD closed 2.4% above the descending channel after 2 10-minute candles, confirming an upside breakout.'
    );
});

test('distinguishes a failed breakout from a boundary retest that held', () => {
    const failed = appendChannelCloses(makeDescendingChannel(), [
        ({ upper }) => upper + 2.2,
        ({ upper }) => upper + 2.3,
        ({ upper }) => upper + 1.8,
        ({ upper }) => upper + 1.7,
        ({ upper }) => upper - 1.0,
        ({ upper }) => upper - 1.1,
        ({ upper }) => upper - 1.2,
        ({ upper }) => upper - 1.3
    ]);
    const retest = appendChannelCloses(makeDescendingChannel(), [
        ({ upper }) => upper + 2.2,
        ({ upper }) => upper + 2.3,
        ({ upper }) => upper + 1.8,
        ({ upper }) => upper + 1.7,
        ({ upper }) => upper + 2.1,
        ({ upper }) => upper + 1.8,
        ({ upper }) => upper + 1.9,
        ({ upper }) => upper + 2.0
    ]);

    const retestIndex = 68;
    retest[retestIndex].low = (110 - (retestIndex * 0.16)) + 0.1;

    const failedEvent = autoscan.scanMarket(failed).events.find(item => (
        item.patternVariant === 'descending-channel' && item.kind === 'failed-breakout'
    ));
    const retestEvent = autoscan.scanMarket(retest).events.find(item => (
        item.patternVariant === 'descending-channel' && item.kind === 'retest-held'
    ));

    assert.ok(failedEvent);
    assert.ok(retestEvent);
    assert.match(autoscan.formatEventCommentary(failedEvent), /breakout failed/);
    assert.match(autoscan.formatEventCommentary(retestEvent), /retested.*held above/);
});

test('reports a confirmed downside breakdown without predictive language', () => {
    const candles = appendChannelCloses(makeDescendingChannel(), [
        ({ lower }) => lower + 0.3,
        ({ lower }) => lower + 0.3,
        ({ lower }) => lower + 0.3,
        ({ lower }) => lower + 0.3,
        ({ lower }) => lower + 0.3,
        ({ lower }) => lower + 0.3,
        ({ lower }) => lower - 2.2,
        ({ lower }) => lower - 2.3
    ]);
    const event = autoscan.scanMarket(candles).events.find(item => (
        item.patternVariant === 'descending-channel' && item.kind === 'breakdown'
    ));

    assert.ok(event);
    const commentary = autoscan.formatEventCommentary(event, {
        rangeLabel: 'Day',
        assetLabel: 'BTC/USD',
        candleLabel: '10-minute'
    });
    assert.match(commentary, /below the descending channel.*downside breakdown/);
    assert.doesNotMatch(commentary, /forecast|target|likely|should|will/i);
});

test('returns byte-for-byte stable results for the same candle series', () => {
    const candles = makeStructure(80, index => 112 - (index * 0.13), index => 96 + (index * 0.11));
    assert.deepEqual(autoscan.scanMarket(candles), autoscan.scanMarket(candles));
});
