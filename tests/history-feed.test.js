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
