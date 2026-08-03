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

function makeNoisyHorizontalRange(count = 96) {
    let seed = 1;
    const random = () => {
        seed = ((seed * 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const candles = [];
    let previousClose = 104;

    for (let index = 0; index < count; index += 1) {
        const center = 104 + (Math.sin(index * 0.43) * 4) + ((random() - 0.5) * 2);
        const close = Math.max(97, Math.min(111, center));
        const open = previousClose;
        let high = Math.max(open, close) + 0.3 + (random() * 1.8);
        let low = Math.min(open, close) - 0.3 - (random() * 1.8);
        if (index % 13 === 6) {
            high = 112;
        }
        if (index % 11 === 5) {
            low = 96;
        }
        candles.push({
            timeMs: START_TIME_MS + (index * INTERVAL_MS),
            open,
            high: Math.min(112, high),
            low: Math.max(96, low),
            close
        });
        previousClose = close;
    }

    return candles;
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

function getPatternTimeRange(pattern) {
    return {
        startTimeMs: Number(pattern.formation?.startTimeMs),
        endTimeMs: Number(pattern.projectionTimeMs)
    };
}

function getMaxConcurrentPatternCount(patterns, candles) {
    return Math.max(...candles.map(candle => patterns.filter(pattern => {
        const range = getPatternTimeRange(pattern);
        return candle.timeMs >= range.startTimeMs && candle.timeMs <= range.endTimeMs;
    }).length));
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

test('groups confirmed support and resistance into one horizontal channel', () => {
    const horizontalRange = makeNoisyHorizontalRange();
    const rangePatterns = autoscan.scanPatterns(horizontalRange);
    const descendingPatterns = autoscan.scanPatterns(makeDescendingChannel());
    const horizontalChannel = rangePatterns.find(pattern => (
        pattern.type === 'channel' && pattern.variant === 'horizontal-channel'
    ));

    assert.ok(horizontalChannel);
    assert.ok(horizontalChannel.lines.upper);
    assert.ok(horizontalChannel.lines.lower);
    assert.ok(horizontalChannel.touches.upper >= 3);
    assert.ok(horizontalChannel.touches.lower >= 3);
    assert.deepEqual(horizontalChannel.components, ['support', 'resistance']);
    assert.equal(
        rangePatterns.filter(pattern => pattern.variant === 'horizontal-channel').length,
        1
    );
    assert.equal(
        rangePatterns.some(pattern => ['support', 'resistance'].includes(pattern.variant)),
        false
    );
    assert.ok(descendingPatterns.some(pattern => (
        pattern.type === 'channel' && pattern.variant === 'descending-channel'
    )));
    assert.equal(
        descendingPatterns.some(pattern => pattern.variant === 'falling-support'),
        false
    );
});

test('uses one slice-based visibility rule for boundaries and overlapping structures', () => {
    const projectionTimeMs = START_TIME_MS + (60 * INTERVAL_MS);
    const makeLine = (slope, intercept) => ({
        slope,
        intercept,
        baseTimeMs: START_TIME_MS,
        intervalMs: INTERVAL_MS
    });
    const makeBoundary = ({
        id,
        type = 'trend',
        variant,
        side,
        slope = 0,
        intercept,
        confidence = 0.9,
        source = 'autoscan',
        tentative = false
    }) => ({
        id,
        type,
        variant,
        confidence,
        source,
        tentative,
        lines: { [side]: makeLine(slope, intercept) },
        touches: { [side]: 5 },
        formation: { startTimeMs: START_TIME_MS, endTimeMs: projectionTimeMs },
        projectionTimeMs,
        anchors: [{
            timeMs: projectionTimeMs,
            value: intercept + (slope * 60)
        }]
    });
    const makeEnvelope = ({
        id,
        type = 'channel',
        variant,
        lowerSlope = 0,
        lowerIntercept,
        upperSlope = lowerSlope,
        upperIntercept,
        confidence,
        touches,
        scanWindowCandles,
        source = 'autoscan',
        tentative = false
    }) => ({
        id,
        type,
        variant,
        confidence,
        source,
        tentative,
        lines: {
            upper: makeLine(upperSlope, upperIntercept),
            lower: makeLine(lowerSlope, lowerIntercept)
        },
        touches,
        scanWindowCandles,
        formation: { startTimeMs: START_TIME_MS, endTimeMs: projectionTimeMs },
        projectionTimeMs,
        anchors: [{ timeMs: projectionTimeMs, value: lowerIntercept + (lowerSlope * 60) }]
    });
    const ascendingChannel = makeEnvelope({
        id: 'ascending-channel',
        variant: 'ascending-channel',
        lowerSlope: 0.1,
        lowerIntercept: 84,
        upperSlope: 0.1,
        upperIntercept: 94,
        confidence: 0.88,
        touches: { upper: 6, lower: 5 },
        scanWindowCandles: 45
    });
    const nestedHorizontalChannel = makeEnvelope({
        id: 'horizontal-channel',
        variant: 'horizontal-channel',
        lowerIntercept: 89,
        upperIntercept: 99,
        confidence: 0.79,
        touches: { upper: 4, lower: 3 },
        scanWindowCandles: 30
    });
    const crossingChannel = makeEnvelope({
        id: 'crossing-channel',
        variant: 'descending-channel',
        lowerSlope: -0.5,
        lowerIntercept: 120,
        upperSlope: -0.5,
        upperIntercept: 130,
        confidence: 0.82,
        touches: { upper: 5, lower: 5 },
        scanWindowCandles: 45
    });
    const earlierChannel = {
        ...makeEnvelope({
            id: 'earlier-channel',
            variant: 'horizontal-channel',
            lowerIntercept: 89,
            upperIntercept: 99,
            confidence: 0.95,
            touches: { upper: 6, lower: 6 },
            scanWindowCandles: 60
        }),
        formation: {
            startTimeMs: START_TIME_MS - (70 * INTERVAL_MS),
            endTimeMs: START_TIME_MS - (10 * INTERVAL_MS)
        },
        projectionTimeMs: START_TIME_MS - (10 * INTERVAL_MS),
        anchors: [{ timeMs: START_TIME_MS - (10 * INTERVAL_MS), value: 89 }]
    };
    const duplicateRisingSupport = makeBoundary({
        id: 'duplicate-rising-support',
        variant: 'rising-support',
        side: 'lower',
        slope: 0.1,
        intercept: 84,
        confidence: 0.91
    });
    const absorbedResistance = makeBoundary({
        id: 'absorbed-resistance',
        type: 'horizontal',
        variant: 'resistance',
        side: 'upper',
        intercept: 96,
        confidence: 0.97
    });
    const transientResistance = makeBoundary({
        id: 'transient-resistance',
        variant: 'rising-resistance',
        side: 'upper',
        slope: 0.8,
        intercept: 70,
        confidence: 0.83
    });
    const separateResistance = makeBoundary({
        id: 'separate-resistance',
        type: 'horizontal',
        variant: 'resistance',
        side: 'upper',
        intercept: 112,
        confidence: 0.84
    });

    const visible = autoscan.prioritizeVisiblePatterns([
        duplicateRisingSupport,
        absorbedResistance,
        transientResistance,
        nestedHorizontalChannel,
        crossingChannel,
        earlierChannel,
        separateResistance,
        ascendingChannel
    ]);

    assert.ok(visible.includes(ascendingChannel));
    assert.equal(visible.includes(duplicateRisingSupport), false);
    assert.equal(visible.includes(absorbedResistance), false);
    assert.ok(visible.includes(transientResistance));
    assert.equal(visible.includes(nestedHorizontalChannel), false);
    assert.ok(visible.includes(crossingChannel));
    assert.ok(visible.includes(earlierChannel));
    assert.ok(visible.includes(separateResistance));
});

test('applies confirmation, completeness, confidence, touches, and scan depth to any auto type', () => {
    const projectionTimeMs = START_TIME_MS + (60 * INTERVAL_MS);
    const makeLine = (slope, intercept) => ({
        slope,
        intercept,
        baseTimeMs: START_TIME_MS,
        intervalMs: INTERVAL_MS
    });
    const makeEnvelope = ({
        id,
        type,
        variant,
        confidence,
        touches,
        scanWindowCandles,
        tentative = false
    }) => ({
        id,
        type,
        variant,
        confidence,
        touches,
        scanWindowCandles,
        tentative,
        source: tentative ? 'autoscan-tentative' : 'autoscan',
        lines: {
            lower: makeLine(0.04, 90),
            upper: makeLine(0.04, 100)
        },
        formation: { startTimeMs: START_TIME_MS, endTimeMs: projectionTimeMs },
        projectionTimeMs,
        anchors: [{ timeMs: projectionTimeMs, value: 92.4 }]
    });
    const confirmedChannel = makeEnvelope({
        id: 'confirmed-channel',
        type: 'channel',
        variant: 'ascending-channel',
        confidence: 0.7,
        touches: { upper: 3, lower: 3 },
        scanWindowCandles: 30
    });
    const tentativeWedge = makeEnvelope({
        id: 'tentative-wedge',
        type: 'wedge',
        variant: 'rising-wedge',
        confidence: 0.9,
        touches: { upper: 8, lower: 8 },
        scanWindowCandles: 90,
        tentative: true
    });
    const confirmedSupport = {
        id: 'confirmed-support',
        type: 'trend',
        variant: 'rising-support',
        confidence: 0.95,
        touches: { lower: 7 },
        scanWindowCandles: 90,
        source: 'autoscan',
        lines: { lower: makeLine(0.04, 90) },
        formation: { startTimeMs: START_TIME_MS, endTimeMs: projectionTimeMs },
        projectionTimeMs,
        anchors: [{ timeMs: projectionTimeMs, value: 92.4 }]
    };
    const strongerTriangle = makeEnvelope({
        id: 'stronger-triangle',
        type: 'triangle',
        variant: 'symmetrical-triangle',
        confidence: 0.82,
        touches: { upper: 4, lower: 4 },
        scanWindowCandles: 45
    });
    const deeperTriangle = makeEnvelope({
        id: 'deeper-triangle',
        type: 'triangle',
        variant: 'ascending-triangle',
        confidence: 0.82,
        touches: { upper: 6, lower: 5 },
        scanWindowCandles: 60
    });

    assert.deepEqual(
        autoscan.prioritizeVisiblePatterns([tentativeWedge, confirmedChannel]),
        [confirmedChannel]
    );
    assert.deepEqual(
        autoscan.prioritizeVisiblePatterns([confirmedSupport, tentativeWedge]),
        [confirmedSupport]
    );
    assert.deepEqual(
        autoscan.prioritizeVisiblePatterns([confirmedChannel, strongerTriangle]),
        [strongerTriangle]
    );
    assert.deepEqual(
        autoscan.prioritizeVisiblePatterns([strongerTriangle, deeperTriangle]),
        [deeperTriangle]
    );
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

test('keeps a distinct lower-confidence structure in the tentative band', () => {
    const candles = makeNoisyHorizontalRange();
    const options = { qualityMultiplier: 0.65 };
    const confirmed = autoscan.scanMarket(candles, options).patterns;
    const tentative = autoscan.scanTentativePatterns(candles, options);

    assert.deepEqual(confirmed, []);
    assert.ok(tentative.some(pattern => (
        pattern.variant === 'horizontal-channel'
        && pattern.components?.includes('support')
        && pattern.components?.includes('resistance')
    )));
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

test('uses a range-specific tentative floor without reintroducing redundant lookback structures', () => {
    const candles = makeDescendingChannel();
    const options = {
        qualityMultiplier: 0.55,
        lookbackWindows: [30, 45, 60]
    };
    const defaultTentative = autoscan.scanTentativePatterns(candles, options);
    const shortRangeTentative = autoscan.scanTentativePatterns(candles, {
        ...options,
        tentativeMinConfidence: 0.46
    });

    assert.deepEqual(defaultTentative, []);
    assert.ok(shortRangeTentative.some(pattern => (
        pattern.variant === 'descending-channel'
        && pattern.scanWindowCandles === candles.length
    )));
    assert.equal(
        shortRangeTentative.some(pattern => ['support', 'resistance'].includes(pattern.variant)),
        false
    );
    assert.ok(shortRangeTentative.every(pattern => (
        pattern.confidence >= 0.46
        && pattern.confidence < 0.64
        && pattern.source === 'autoscan-tentative'
    )));
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
    assert.ok(result.diagnostics.segmentsScanned > result.diagnostics.windowsScanned.length);
    assert.ok(result.patterns.every(pattern => pattern.episodeDetectionCount >= 2));
    assert.ok(result.patterns.length <= 4);
    assert.ok(getMaxConcurrentPatternCount(result.patterns, candles) <= 2);
    assert.deepEqual(
        result,
        autoscan.scanMarket(candles, { lookbackWindows: [64, 90, 120] })
    );
});

test('detects structures in historical tranches without displacing a later range', () => {
    const earlyDescendingChannel = makeDescendingChannel(64);
    const transition = Array.from({ length: 32 }, (_, index) => {
        const center = index % 2 === 0 ? 145 : 72;
        return {
            timeMs: START_TIME_MS + ((64 + index) * INTERVAL_MS),
            open: center,
            high: center + 8 + (index % 5),
            low: center - 8 - (index % 7),
            close: center + ((index % 3) - 1)
        };
    });
    const recentHorizontalRange = makeNoisyHorizontalRange().map((candle, index) => ({
        ...candle,
        timeMs: START_TIME_MS + ((96 + index) * INTERVAL_MS)
    }));
    const candles = [
        ...earlyDescendingChannel,
        ...transition,
        ...recentHorizontalRange
    ];
    const result = autoscan.scanMarket(candles, {
        lookbackWindows: [60, 64, 90, 96, 120]
    });
    const historicalDescending = result.patterns.find(pattern => (
        pattern.variant === 'descending-channel'
        && pattern.projectionTimeMs <= earlyDescendingChannel.at(-1).timeMs
    ));
    const recentHorizontal = result.patterns.find(pattern => (
        pattern.variant === 'horizontal-channel'
        && pattern.projectionTimeMs === candles.at(-1).timeMs
    ));

    assert.ok(historicalDescending);
    assert.ok(recentHorizontal);
    assert.ok(
        historicalDescending.projectionTimeMs < recentHorizontal.formation.startTimeMs
    );
    assert.ok(result.patterns.every(pattern => pattern.episodeDetectionCount >= 2));
    assert.ok(result.patterns.length <= 4);
    assert.ok(getMaxConcurrentPatternCount(result.patterns, candles) <= 2);
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
