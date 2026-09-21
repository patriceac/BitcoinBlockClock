(function initializeBitcoinHistoricalMarketData(root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.BitcoinHistoricalMarketData = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createBitcoinHistoricalMarketData() {
    'use strict';

    function getKrakenOhlcRows(responseData) {
        const errors = Array.isArray(responseData?.error) ? responseData.error : [];
        if (errors.length > 0) {
            throw new Error(`Kraken OHLC request failed: ${errors.join(', ')}`);
        }

        const result = responseData?.result;
        if (!result || typeof result !== 'object') {
            return [];
        }

        const pairKey = Object.keys(result).find(key => key !== 'last');
        return pairKey && Array.isArray(result[pairKey]) ? result[pairKey] : [];
    }

    function hasDailySeriesValues(series) {
        return Object.values(series || {}).some(value => (
            Number.isFinite(Number(value)) && Number(value) > 0
        ));
    }

    function mapKrakenOhlcToDailySeries(responseData, options = {}) {
        const rows = getKrakenOhlcRows(responseData);
        const committedRows = options.excludeIncomplete === false
            ? rows
            : (rows.length > 1 ? rows.slice(0, -1) : []);
        const startDate = typeof options.startDate === 'string' ? options.startDate : null;
        const endDate = typeof options.endDate === 'string' ? options.endDate : null;
        const valuesByDate = {};

        committedRows.forEach(row => {
            const timestampMs = Number(row?.[0]) * 1000;
            const close = Number(row?.[4]);
            if (!Number.isFinite(timestampMs) || !Number.isFinite(close) || close <= 0) {
                return;
            }

            const date = new Date(timestampMs).toISOString().slice(0, 10);
            if ((startDate && date < startDate) || (endDate && date > endDate)) {
                return;
            }
            valuesByDate[date] = close;
        });

        return valuesByDate;
    }

    function mergeHistoricalPriceHistory({
        dateRange,
        existingHistory = {},
        latestHistory = {},
        usdSeries = {},
        eurSeries = {},
        difficultySeries = {}
    }) {
        const nextHistory = {};

        (dateRange || []).forEach(date => {
            nextHistory[date] = {
                USD: usdSeries[date] ?? latestHistory[date]?.USD ?? existingHistory[date]?.USD ?? null,
                EUR: eurSeries[date] ?? latestHistory[date]?.EUR ?? existingHistory[date]?.EUR ?? null,
                HashRate: latestHistory[date]?.HashRate ?? existingHistory[date]?.HashRate ?? null,
                Difficulty: difficultySeries[date]
                    ?? latestHistory[date]?.Difficulty
                    ?? existingHistory[date]?.Difficulty
                    ?? null
            };
        });

        return nextHistory;
    }

    function buildFiftyWeekMovingAverage(dailyCloses, chartPoints, latestPoint = null) {
        const dayMs = 24 * 60 * 60 * 1000;
        const weekMs = 7 * dayMs;
        const weekStart = timeMs => {
            const dayStart = Math.floor(timeMs / dayMs) * dayMs;
            return dayStart - ((new Date(timeMs).getUTCDay() + 6) % 7) * dayMs;
        };
        const sundayCloses = new Map();

        Object.entries(dailyCloses || {}).forEach(([date, rawPrice]) => {
            const timeMs = Date.parse(`${date}T00:00:00Z`);
            const price = Number(rawPrice);
            if (Number.isFinite(timeMs) && Number.isFinite(price) && price > 0 &&
                new Date(timeMs).getUTCDay() === 0) {
                sundayCloses.set(weekStart(timeMs), price);
            }
        });

        const pointTime = point => typeof point?.x === 'number' ? point.x : Date.parse(point?.x);
        const isValidPoint = point => Number.isFinite(pointTime(point)) &&
            Number.isFinite(Number(point?.y)) && Number(point.y) > 0;
        const latest = isValidPoint(latestPoint)
            ? latestPoint
            : (chartPoints || []).filter(isValidPoint).reduce((last, point) => (
                !last || pointTime(point) > pointTime(last) ? point : last
            ), null);
        if (!latest) {
            return [];
        }
        const currentWeek = weekStart(pointTime(latest));
        const weeklyPrices = [...sundayCloses].filter(([week]) => week < currentWeek);
        weeklyPrices.push([currentWeek, Number(latest.y)]);
        weeklyPrices.sort(([left], [right]) => left - right);

        // Keep the true 50-week averages at weekly boundaries, then interpolate
        // between them instead of reproducing the chart's short-term price noise.
        const anchors = weeklyPrices.flatMap(([week, price]) => {
            let sum = price;
            for (let previousWeek = 1; previousWeek < 50; previousWeek++) {
                const close = sundayCloses.get(week - previousWeek * weekMs);
                if (close == null) {
                    return [];
                }
                sum += close;
            }
            return [{ x: week + weekMs, y: sum / 50 }];
        });
        const slopes = anchors.slice(1).map((point, i) => (point.y - anchors[i].y) / (point.x - anchors[i].x));
        const tangents = anchors.map((point, i) => {
            if (i === 0) return slopes[0] || 0;
            if (i === anchors.length - 1) return slopes[i - 1] || 0;
            const before = slopes[i - 1];
            const after = slopes[i];
            return before * after > 0 ? 2 * before * after / (before + after) : 0;
        });

        return (chartPoints || []).flatMap(point => {
            const timeMs = pointTime(point);
            const right = anchors.findIndex(anchor => anchor.x >= timeMs);
            if (right < 0) return [];
            if (anchors[right].x === timeMs) return [{ x: point.x, y: anchors[right].y }];
            if (right === 0) return [];
            const left = right - 1;
            const span = anchors[right].x - anchors[left].x;
            if (span > weekMs) return [];
            const t = (timeMs - anchors[left].x) / span;
            const t2 = t * t;
            const t3 = t2 * t;
            const y = (2 * t3 - 3 * t2 + 1) * anchors[left].y
                + (t3 - 2 * t2 + t) * span * tangents[left]
                + (-2 * t3 + 3 * t2) * anchors[right].y
                + (t3 - t2) * span * tangents[right];
            return [{ x: point.x, y }];
        });
    }

    return Object.freeze({
        getKrakenOhlcRows,
        hasDailySeriesValues,
        mapKrakenOhlcToDailySeries,
        mergeHistoricalPriceHistory,
        buildFiftyWeekMovingAverage
    });
}));
