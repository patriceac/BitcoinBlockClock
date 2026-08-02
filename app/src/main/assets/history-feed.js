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

    return Object.freeze({
        getKrakenOhlcRows,
        hasDailySeriesValues,
        mapKrakenOhlcToDailySeries,
        mergeHistoricalPriceHistory
    });
}));
