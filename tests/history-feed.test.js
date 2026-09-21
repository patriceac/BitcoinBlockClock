const assert = require('node:assert/strict');
const test = require('node:test');

const historyFeed = require('../app/src/main/assets/history-feed.js');

function makeKrakenResponse(rows, errors = []) {
    return {
        error: errors,
        result: {
            XXBTZUSD: rows,
            last: 123
        }
    };
}

test('maps only committed Kraken daily closes inside the requested date range', () => {
    const response = makeKrakenResponse([
        [Date.UTC(2026, 0, 1) / 1000, '90', '101', '89', '100'],
        [Date.UTC(2026, 0, 2) / 1000, '100', '112', '98', '110'],
        [Date.UTC(2026, 0, 3) / 1000, '110', '121', '109', '120'],
        [Date.UTC(2026, 0, 4) / 1000, '120', '131', '118', '130']
    ]);

    assert.deepEqual(historyFeed.mapKrakenOhlcToDailySeries(response, {
        startDate: '2026-01-02',
        endDate: '2026-01-04'
    }), {
        '2026-01-02': 110,
        '2026-01-03': 120
    });
});

test('rejects Kraken API errors instead of caching an empty fallback', () => {
    assert.throws(
        () => historyFeed.mapKrakenOhlcToDailySeries(
            makeKrakenResponse([], ['EGeneral:Temporary lockout'])
        ),
        /Kraken OHLC request failed/
    );
    assert.equal(historyFeed.hasDailySeriesValues({}), false);
    assert.equal(historyFeed.hasDailySeriesValues({ '2026-01-01': 100 }), true);
});

test('persists successful fields while preserving cached values for failed feeds', () => {
    const result = historyFeed.mergeHistoricalPriceHistory({
        dateRange: ['2026-01-01', '2026-01-02'],
        existingHistory: {
            '2026-01-01': { USD: 95, EUR: 88, HashRate: 900, Difficulty: 10 },
            '2026-01-02': { USD: 96, EUR: 89, HashRate: 901, Difficulty: 11 }
        },
        latestHistory: {
            '2026-01-02': { USD: 97, EUR: 90, HashRate: 902, Difficulty: 12 }
        },
        usdSeries: {
            '2026-01-01': 100,
            '2026-01-02': 110
        },
        difficultySeries: {
            '2026-01-01': 20
        }
    });

    assert.deepEqual(result, {
        '2026-01-01': { USD: 100, EUR: 88, HashRate: 900, Difficulty: 20 },
        '2026-01-02': { USD: 110, EUR: 90, HashRate: 902, Difficulty: 12 }
    });
});

test('returns byte-for-byte stable merged history for identical inputs', () => {
    const input = {
        dateRange: ['2026-01-01'],
        usdSeries: { '2026-01-01': 100 },
        eurSeries: { '2026-01-01': 90 },
        difficultySeries: { '2026-01-01': 10 }
    };

    assert.deepEqual(
        historyFeed.mergeHistoricalPriceHistory(input),
        historyFeed.mergeHistoricalPriceHistory(input)
    );
});

test('short moving averages use full trailing windows from the first visible point without future prices', () => {
    for (const [windowMs, bucketMs] of [[4 * 3600000, 600000], [24 * 3600000, 3600000], [7 * 86400000, 6 * 3600000]]) {
        const count = windowMs / bucketMs;
        const history = Array.from({ length: count + 3 }, (_, i) => ({ x: i * bucketMs, y: 100 + i }));
        const visible = history.slice(count - 1, count + 2);
        history.at(-1).y = 1000000;
        assert.deepEqual(historyFeed.buildSimpleMovingAverage(history, visible, { windowMs, bucketMs }),
            visible.map((point, i) => ({ x: point.x, y: 100 + (count - 1) / 2 + i })));
    }
});

test('short moving averages wait for complete history and recover only after a gap leaves the window', () => {
    const history = Array.from({ length: 8 }, (_, i) => ({ x: i * 1000, y: 100 + i }));
    const visible = history.slice();
    history.splice(3, 1);
    assert.deepEqual(historyFeed.buildSimpleMovingAverage(history, visible, { windowMs: 3000, bucketMs: 1000 }), [
        { x: 2000, y: 101 },
        { x: 6000, y: 105 },
        { x: 7000, y: 106 }
    ]);
});

test('50-week MA smoothly interpolates weekly values without following intraday noise', () => {
    const monday = Date.UTC(2026, 8, 21);
    const sundayCloses = {};
    for (let week = 1; week <= 51; week++) {
        sundayCloses[new Date(monday - (week * 7 - 6) * 86400000).toISOString().slice(0, 10)] = 100;
    }
    const points = Array.from({ length: 97 }, (_, hour) => ({
        x: monday + hour * 3600000,
        y: hour % 2 ? 500 : 50
    }));
    const latest = { x: points.at(-1).x, y: 200 };
    const smoothed = historyFeed.buildFiftyWeekMovingAverage(sundayCloses, points, latest);
    assert.equal(smoothed.length, points.length);
    assert.equal(smoothed[0].y, 100);
    assert.ok(smoothed.at(-1).y > 100 && smoothed.at(-1).y < 102);
    assert.ok(smoothed.every((point, i) => i === 0 || point.y >= smoothed[i - 1].y));
    assert.deepEqual(
        historyFeed.buildFiftyWeekMovingAverage(sundayCloses, points.slice(48), latest),
        smoothed.slice(48)
    );

    delete sundayCloses[new Date(monday - 86400000).toISOString().slice(0, 10)];
    assert.deepEqual(historyFeed.buildFiftyWeekMovingAverage(sundayCloses, points, latest), []);
});
