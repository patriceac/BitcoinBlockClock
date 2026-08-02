(function initializeBitcoinChartAutoscan(root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.BitcoinChartAutoscan = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createBitcoinChartAutoscan() {
    'use strict';

    const DEFAULT_OPTIONS = Object.freeze({
        minCandles: 30,
        maxPatterns: 3,
        minConfidence: 0.64,
        eventConfidence: 0.72,
        eventLookbackCandles: 12,
        confirmationCandles: 2,
        qualityMultiplier: 1
    });

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function mean(values) {
        if (!values.length) {
            return 0;
        }
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    function median(values) {
        if (!values.length) {
            return 0;
        }

        const sorted = [...values].sort((left, right) => left - right);
        const midpoint = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
            ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
            : sorted[midpoint];
    }

    function getTimeMs(value) {
        if (Number.isFinite(Number(value))) {
            return Number(value);
        }

        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : NaN;
    }

    function normalizeCandles(data) {
        const candlesByTime = new Map();

        (data || []).forEach(point => {
            const timeMs = getTimeMs(point?.timeMs ?? point?.x ?? point?.timestamp);
            const close = Number(point?.close ?? point?.y ?? point?.price ?? point?.value);
            if (!Number.isFinite(timeMs) || !Number.isFinite(close) || close <= 0) {
                return;
            }

            const openValue = Number(point?.open);
            const highValue = Number(point?.high);
            const lowValue = Number(point?.low);
            const open = Number.isFinite(openValue) ? openValue : close;
            const high = Number.isFinite(highValue) ? Math.max(highValue, open, close) : Math.max(open, close);
            const low = Number.isFinite(lowValue) ? Math.min(lowValue, open, close) : Math.min(open, close);

            candlesByTime.set(timeMs, {
                timeMs,
                open,
                high,
                low,
                close
            });
        });

        return [...candlesByTime.values()].sort((left, right) => left.timeMs - right.timeMs);
    }

    function aggregateCandles(data, bucketMs) {
        const candles = normalizeCandles(data);
        if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
            return candles;
        }

        const buckets = new Map();
        candles.forEach(candle => {
            const bucketTime = Math.floor(candle.timeMs / bucketMs) * bucketMs;
            const existing = buckets.get(bucketTime);
            if (!existing) {
                buckets.set(bucketTime, {
                    timeMs: bucketTime,
                    open: candle.open,
                    high: candle.high,
                    low: candle.low,
                    close: candle.close
                });
                return;
            }

            existing.high = Math.max(existing.high, candle.high);
            existing.low = Math.min(existing.low, candle.low);
            existing.close = candle.close;
        });

        return [...buckets.values()].sort((left, right) => left.timeMs - right.timeMs);
    }

    function getMedianIntervalMs(candles) {
        const intervals = [];
        for (let index = 1; index < candles.length; index += 1) {
            const interval = candles[index].timeMs - candles[index - 1].timeMs;
            if (Number.isFinite(interval) && interval > 0) {
                intervals.push(interval);
            }
        }
        return median(intervals) || 60 * 1000;
    }

    function getTrueRanges(candles) {
        return candles.map((candle, index) => {
            if (index === 0) {
                return candle.high - candle.low;
            }

            const previousClose = candles[index - 1].close;
            return Math.max(
                candle.high - candle.low,
                Math.abs(candle.high - previousClose),
                Math.abs(candle.low - previousClose)
            );
        }).filter(value => Number.isFinite(value) && value >= 0);
    }

    function getVolatility(candles) {
        const closes = candles.map(candle => candle.close);
        const priceScale = median(closes) || mean(closes) || 1;
        const trueRanges = getTrueRanges(candles).filter(value => value > 0);
        const recentRanges = trueRanges.slice(-Math.min(28, trueRanges.length));
        return Math.max(median(recentRanges), priceScale * 0.0012);
    }

    function compactPivots(pivots, minimumDistance) {
        const compacted = [];
        pivots.forEach(pivot => {
            const previous = compacted[compacted.length - 1];
            if (!previous || pivot.index - previous.index > minimumDistance) {
                compacted.push(pivot);
                return;
            }

            const shouldReplace = pivot.kind === 'high'
                ? pivot.value > previous.value
                : pivot.value < previous.value;
            if (shouldReplace) {
                compacted[compacted.length - 1] = pivot;
            }
        });
        return compacted;
    }

    function detectPivots(data, options = {}) {
        const candles = normalizeCandles(data);
        if (candles.length < 7) {
            return { highs: [], lows: [], span: 0 };
        }

        const volatility = getVolatility(candles);
        const span = clamp(
            Number.isFinite(options.span) ? Math.round(options.span) : Math.round(candles.length / 55),
            2,
            6
        );
        const minimumProminence = volatility * (Number(options.prominenceMultiplier) || 0.32);
        const highs = [];
        const lows = [];

        for (let index = span; index < candles.length - span; index += 1) {
            const candle = candles[index];
            const left = candles.slice(index - span, index);
            const right = candles.slice(index + 1, index + span + 1);
            const neighboring = [...left, ...right];
            const neighboringHigh = Math.max(...neighboring.map(item => item.high));
            const neighboringLow = Math.min(...neighboring.map(item => item.low));
            const highProminence = candle.high - Math.max(
                Math.min(...left.map(item => item.high)),
                Math.min(...right.map(item => item.high))
            );
            const lowProminence = Math.min(
                Math.max(...left.map(item => item.low)),
                Math.max(...right.map(item => item.low))
            ) - candle.low;

            if (candle.high >= neighboringHigh && highProminence >= minimumProminence) {
                highs.push({
                    kind: 'high',
                    index,
                    timeMs: candle.timeMs,
                    value: candle.high,
                    prominence: highProminence
                });
            }

            if (candle.low <= neighboringLow && lowProminence >= minimumProminence) {
                lows.push({
                    kind: 'low',
                    index,
                    timeMs: candle.timeMs,
                    value: candle.low,
                    prominence: lowProminence
                });
            }
        }

        return {
            highs: compactPivots(highs, span),
            lows: compactPivots(lows, span),
            span
        };
    }

    function fitLine(points) {
        if (!Array.isArray(points) || points.length < 2) {
            return null;
        }

        const meanX = mean(points.map(point => point.x));
        const meanY = mean(points.map(point => point.value));
        let numerator = 0;
        let denominator = 0;

        points.forEach(point => {
            const xDelta = point.x - meanX;
            numerator += xDelta * (point.value - meanY);
            denominator += xDelta * xDelta;
        });

        if (!Number.isFinite(denominator) || denominator === 0) {
            return null;
        }

        const slope = numerator / denominator;
        const intercept = meanY - (slope * meanX);
        const residuals = points.map(point => point.value - ((slope * point.x) + intercept));
        const rmse = Math.sqrt(mean(residuals.map(value => value * value)));
        const totalVariance = points.reduce((sum, point) => sum + Math.pow(point.value - meanY, 2), 0);
        const residualVariance = residuals.reduce((sum, value) => sum + (value * value), 0);
        const rSquared = totalVariance > 0 ? 1 - (residualVariance / totalVariance) : 1;

        return { slope, intercept, rmse, rSquared };
    }

    function lineValueAtX(line, x) {
        return (line.slope * x) + line.intercept;
    }

    function lineValueAtTime(line, timeMs) {
        const intervalMs = Number(line?.intervalMs);
        const baseTimeMs = Number(line?.baseTimeMs);
        if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(baseTimeMs)) {
            return NaN;
        }
        return lineValueAtX(line, (Number(timeMs) - baseTimeMs) / intervalMs);
    }

    function withLineContext(line, context) {
        return {
            ...line,
            baseTimeMs: context.baseTimeMs,
            intervalMs: context.intervalMs
        };
    }

    function hashString(value) {
        let hash = 2166136261;
        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function getPatternLabel(pattern) {
        const labels = {
            support: 'Support',
            resistance: 'Resistance',
            'rising-support': 'Rising support line',
            'falling-support': 'Falling support line',
            'rising-resistance': 'Rising resistance line',
            'falling-resistance': 'Falling resistance line',
            'ascending-channel': 'Ascending channel',
            'descending-channel': 'Descending channel',
            'horizontal-channel': 'Horizontal channel',
            'ascending-triangle': 'Ascending triangle',
            'descending-triangle': 'Descending triangle',
            'symmetrical-triangle': 'Symmetrical triangle',
            'rising-wedge': 'Rising wedge',
            'falling-wedge': 'Falling wedge'
        };
        return labels[pattern?.variant] || pattern?.label || 'Chart structure';
    }

    function finalizePattern(pattern, context, options) {
        const confidence = clamp(pattern.confidence * options.qualityMultiplier, 0, 0.99);
        const priceQuantum = Math.max(context.priceScale * 0.002, context.volatility * 0.5);
        const signature = [
            pattern.type,
            pattern.variant,
            Math.round(pattern.formation.startTimeMs / (context.intervalMs * 4)),
            ...pattern.anchors.map(anchor => Math.round(anchor.value / priceQuantum))
        ].join('|');

        return {
            ...pattern,
            id: `autoscan-${hashString(signature)}`,
            label: getPatternLabel(pattern),
            confidence,
            source: 'autoscan',
            locked: true
        };
    }

    function createContext(candles) {
        const intervalMs = getMedianIntervalMs(candles);
        const baseTimeMs = candles[0].timeMs;
        const volatility = getVolatility(candles);
        const priceScale = median(candles.map(candle => candle.close)) || 1;
        const tolerance = Math.max(volatility * 0.78, priceScale * 0.0016);
        const structureLength = Math.min(
            candles.length,
            Math.max(36, Math.min(260, Math.round(candles.length * 0.82)))
        );
        const structureStartIndex = candles.length - structureLength;
        const projectionTimeMs = candles[candles.length - 1].timeMs;
        const toX = timeMs => (timeMs - baseTimeMs) / intervalMs;
        const pivots = detectPivots(candles);

        return {
            candles,
            intervalMs,
            baseTimeMs,
            volatility,
            priceScale,
            tolerance,
            structureStartIndex,
            projectionTimeMs,
            projectionX: toX(projectionTimeMs),
            toX,
            highs: pivots.highs
                .filter(pivot => pivot.index >= structureStartIndex)
                .map(pivot => ({ ...pivot, x: toX(pivot.timeMs) })),
            lows: pivots.lows
                .filter(pivot => pivot.index >= structureStartIndex)
                .map(pivot => ({ ...pivot, x: toX(pivot.timeMs) }))
        };
    }

    function getViolationRate(context, line, side, startTimeMs) {
        const relevant = context.candles.filter(candle => candle.timeMs >= startTimeMs);
        if (!relevant.length) {
            return 1;
        }

        const violations = relevant.filter(candle => {
            const boundary = lineValueAtTime(line, candle.timeMs);
            return side === 'upper'
                ? candle.close > boundary + (context.tolerance * 1.7)
                : candle.close < boundary - (context.tolerance * 1.7);
        }).length;
        return violations / relevant.length;
    }

    function clusterPivots(pivots, tolerance) {
        const clusters = [];
        [...pivots].sort((left, right) => left.value - right.value).forEach(pivot => {
            let nearest = null;
            let nearestDistance = Infinity;
            clusters.forEach(cluster => {
                const distance = Math.abs(cluster.level - pivot.value);
                if (distance <= tolerance && distance < nearestDistance) {
                    nearest = cluster;
                    nearestDistance = distance;
                }
            });

            if (!nearest) {
                clusters.push({ level: pivot.value, pivots: [pivot] });
                return;
            }

            nearest.pivots.push(pivot);
            nearest.level = mean(nearest.pivots.map(item => item.value));
        });
        return clusters;
    }

    function detectHorizontalPatterns(context, options) {
        const patterns = [];
        [
            { pivots: context.lows, variant: 'support', side: 'lower' },
            { pivots: context.highs, variant: 'resistance', side: 'upper' }
        ].forEach(definition => {
            const candidates = clusterPivots(definition.pivots, context.tolerance * 0.72)
                .filter(cluster => cluster.pivots.length >= 3)
                .map(cluster => {
                    const sortedPivots = [...cluster.pivots].sort((left, right) => left.timeMs - right.timeMs);
                    const first = sortedPivots[0];
                    const last = sortedPivots[sortedPivots.length - 1];
                    const clusterFit = fitLine(sortedPivots.map(pivot => ({
                        ...pivot,
                        x: context.toX(pivot.timeMs)
                    })));
                    const fittedMove = clusterFit
                        ? Math.abs(clusterFit.slope * Math.max(1, last.index - first.index))
                        : Infinity;
                    if (fittedMove > context.tolerance * 1.2) {
                        return null;
                    }
                    const line = withLineContext({ slope: 0, intercept: cluster.level }, context);
                    const violationRate = getViolationRate(context, line, definition.side, first.timeMs);
                    const touchScore = clamp(0.42 + ((cluster.pivots.length - 2) * 0.2), 0, 1);
                    const recencyScore = clamp(
                        1 - ((context.projectionTimeMs - last.timeMs) / (context.intervalMs * context.candles.length * 0.55)),
                        0,
                        1
                    );
                    const durationScore = clamp((last.index - first.index) / (context.candles.length * 0.45), 0, 1);
                    const confidence = (touchScore * 0.38)
                        + (recencyScore * 0.22)
                        + (durationScore * 0.18)
                        + ((1 - clamp(violationRate * 4, 0, 1)) * 0.22);

                    return finalizePattern({
                        type: 'horizontal',
                        variant: definition.variant,
                        confidence,
                        anchors: [{ timeMs: context.projectionTimeMs, value: cluster.level }],
                        lines: { [definition.side]: line },
                        touches: { [definition.side]: cluster.pivots.length },
                        formation: {
                            startTimeMs: first.timeMs,
                            endTimeMs: last.timeMs
                        }
                    }, context, options);
                })
                .filter(pattern => pattern && pattern.confidence >= options.minConfidence)
                .sort((left, right) => right.confidence - left.confidence);

            if (candidates[0]) {
                patterns.push(candidates[0]);
            }
        });
        return patterns;
    }

    function detectTrendPatterns(context, options) {
        const patterns = [];
        [
            { pivots: context.lows, role: 'support', side: 'lower' },
            { pivots: context.highs, role: 'resistance', side: 'upper' }
        ].forEach(definition => {
            if (definition.pivots.length < 3) {
                return;
            }

            const pivots = definition.pivots.slice(-Math.min(7, definition.pivots.length));
            const fit = fitLine(pivots);
            if (!fit) {
                return;
            }

            const first = pivots[0];
            const last = pivots[pivots.length - 1];
            const durationX = Math.max(1, last.x - first.x);
            const totalChange = fit.slope * durationX;
            if (Math.abs(totalChange) < context.tolerance * 1.35 || fit.rmse > context.tolerance * 1.45) {
                return;
            }

            const line = withLineContext(fit, context);
            const violationRate = getViolationRate(context, line, definition.side, first.timeMs);
            const fitScore = 1 - clamp(fit.rmse / (context.tolerance * 1.45), 0, 1);
            const touchScore = clamp((pivots.length - 1) / 5, 0, 1);
            const durationScore = clamp((last.index - first.index) / (context.candles.length * 0.42), 0, 1);
            const confidence = (fitScore * 0.35)
                + (touchScore * 0.25)
                + (durationScore * 0.18)
                + ((1 - clamp(violationRate * 4, 0, 1)) * 0.22);
            const direction = fit.slope >= 0 ? 'rising' : 'falling';

            patterns.push(finalizePattern({
                type: 'trend',
                variant: `${direction}-${definition.role}`,
                confidence,
                anchors: [
                    { timeMs: first.timeMs, value: lineValueAtTime(line, first.timeMs) },
                    { timeMs: context.projectionTimeMs, value: lineValueAtTime(line, context.projectionTimeMs) }
                ],
                lines: { [definition.side]: line },
                touches: { [definition.side]: pivots.length },
                formation: {
                    startTimeMs: first.timeMs,
                    endTimeMs: last.timeMs
                }
            }, context, options));
        });

        return patterns
            .filter(pattern => pattern.confidence >= options.minConfidence)
            .sort((left, right) => right.confidence - left.confidence)
            .slice(0, 1);
    }

    function getPairedBoundaryFits(context) {
        if (context.highs.length < 3 || context.lows.length < 3) {
            return null;
        }

        const highs = context.highs.slice(-Math.min(8, context.highs.length));
        const lows = context.lows.slice(-Math.min(8, context.lows.length));
        const upperFit = fitLine(highs);
        const lowerFit = fitLine(lows);
        if (!upperFit || !lowerFit) {
            return null;
        }

        const upper = withLineContext(upperFit, context);
        const lower = withLineContext(lowerFit, context);
        const startTimeMs = Math.max(
            Math.min(...highs.map(pivot => pivot.timeMs)),
            Math.min(...lows.map(pivot => pivot.timeMs))
        );
        const endTimeMs = Math.min(
            Math.max(...highs.map(pivot => pivot.timeMs)),
            Math.max(...lows.map(pivot => pivot.timeMs))
        );
        if (endTimeMs <= startTimeMs) {
            return null;
        }

        const startX = context.toX(startTimeMs);
        const endX = context.toX(endTimeMs);
        const widthStart = lineValueAtX(upper, startX) - lineValueAtX(lower, startX);
        const widthEnd = lineValueAtX(upper, endX) - lineValueAtX(lower, endX);
        if (widthStart <= context.volatility || widthEnd <= context.volatility * 0.2) {
            return null;
        }

        return {
            highs,
            lows,
            upper,
            lower,
            startTimeMs,
            endTimeMs,
            startX,
            endX,
            widthStart,
            widthEnd,
            durationX: Math.max(1, endX - startX)
        };
    }

    function getBoundaryFitScore(context, paired) {
        const averageError = (paired.upper.rmse + paired.lower.rmse) / 2;
        const fitScore = 1 - clamp(averageError / (context.tolerance * 1.65), 0, 1);
        const touchScore = clamp(((paired.highs.length + paired.lows.length) - 4) / 8, 0, 1);
        const upperViolation = getViolationRate(context, paired.upper, 'upper', paired.startTimeMs);
        const lowerViolation = getViolationRate(context, paired.lower, 'lower', paired.startTimeMs);
        const respectScore = 1 - clamp(((upperViolation + lowerViolation) / 2) * 5, 0, 1);
        const durationScore = clamp(
            (paired.endTimeMs - paired.startTimeMs) / (context.intervalMs * context.candles.length * 0.45),
            0,
            1
        );
        return { fitScore, touchScore, respectScore, durationScore };
    }

    function detectChannelPattern(context, options, paired) {
        if (!paired) {
            return null;
        }

        const averageWidth = (paired.widthStart + paired.widthEnd) / 2;
        const divergence = Math.abs(paired.widthEnd - paired.widthStart) / averageWidth;
        if (averageWidth < context.volatility * 2 || divergence > 0.32) {
            return null;
        }

        const scores = getBoundaryFitScore(context, paired);
        if (scores.fitScore < 0.5 || scores.respectScore < 0.45) {
            return null;
        }
        const parallelScore = 1 - clamp(divergence / 0.32, 0, 1);
        const confidence = (scores.fitScore * 0.24)
            + (parallelScore * 0.22)
            + (scores.touchScore * 0.2)
            + (scores.respectScore * 0.2)
            + (scores.durationScore * 0.14);
        const averageSlope = (paired.upper.slope + paired.lower.slope) / 2;
        const totalMove = averageSlope * paired.durationX;
        const variant = Math.abs(totalMove) <= averageWidth * 0.14
            ? 'horizontal-channel'
            : (averageSlope > 0 ? 'ascending-channel' : 'descending-channel');
        const projectionEnd = context.projectionTimeMs;

        return finalizePattern({
            type: 'channel',
            variant,
            confidence,
            anchors: [
                { timeMs: paired.startTimeMs, value: lineValueAtTime(paired.lower, paired.startTimeMs) },
                { timeMs: projectionEnd, value: lineValueAtTime(paired.lower, projectionEnd) },
                { timeMs: paired.startTimeMs, value: lineValueAtTime(paired.upper, paired.startTimeMs) }
            ],
            lines: { upper: paired.upper, lower: paired.lower },
            touches: { upper: paired.highs.length, lower: paired.lows.length },
            formation: {
                startTimeMs: paired.startTimeMs,
                endTimeMs: paired.endTimeMs
            }
        }, context, options);
    }

    function detectConvergingPattern(context, options, paired) {
        if (!paired) {
            return null;
        }

        const convergence = 1 - (paired.widthEnd / paired.widthStart);
        if (convergence < 0.22 || convergence > 0.9) {
            return null;
        }

        const slopeDifference = paired.upper.slope - paired.lower.slope;
        if (slopeDifference >= 0 || Math.abs(slopeDifference) < Number.EPSILON) {
            return null;
        }

        const apexX = (paired.lower.intercept - paired.upper.intercept) / slopeDifference;
        if (!Number.isFinite(apexX)
            || apexX < paired.endX - (paired.durationX * 0.08)
            || apexX > paired.endX + (paired.durationX * 1.6)) {
            return null;
        }

        const flatSlopeThreshold = paired.widthStart / paired.durationX * 0.13;
        const upperFlat = Math.abs(paired.upper.slope) <= flatSlopeThreshold;
        const lowerFlat = Math.abs(paired.lower.slope) <= flatSlopeThreshold;
        let type = null;
        let variant = null;

        if (upperFlat && paired.lower.slope > flatSlopeThreshold) {
            type = 'triangle';
            variant = 'ascending-triangle';
        } else if (lowerFlat && paired.upper.slope < -flatSlopeThreshold) {
            type = 'triangle';
            variant = 'descending-triangle';
        } else if (paired.upper.slope < -flatSlopeThreshold && paired.lower.slope > flatSlopeThreshold) {
            type = 'triangle';
            variant = 'symmetrical-triangle';
        } else if (paired.upper.slope > 0 && paired.lower.slope > 0) {
            type = 'wedge';
            variant = 'rising-wedge';
        } else if (paired.upper.slope < 0 && paired.lower.slope < 0) {
            type = 'wedge';
            variant = 'falling-wedge';
        }

        if (!type) {
            return null;
        }

        const scores = getBoundaryFitScore(context, paired);
        if (scores.fitScore < 0.5 || scores.respectScore < 0.45) {
            return null;
        }
        const convergenceScore = 1 - clamp(Math.abs(convergence - 0.55) / 0.45, 0, 1);
        const confidence = (scores.fitScore * 0.26)
            + (convergenceScore * 0.2)
            + (scores.touchScore * 0.2)
            + (scores.respectScore * 0.2)
            + (scores.durationScore * 0.14);
        const apexTimeMs = context.baseTimeMs + (apexX * context.intervalMs);
        const projectionEnd = context.projectionTimeMs;
        const anchors = type === 'triangle'
            ? [
                { timeMs: paired.startTimeMs, value: lineValueAtTime(paired.upper, paired.startTimeMs) },
                { timeMs: apexTimeMs, value: lineValueAtX(paired.upper, apexX) },
                { timeMs: paired.startTimeMs, value: lineValueAtTime(paired.lower, paired.startTimeMs) }
            ]
            : [
                { timeMs: paired.startTimeMs, value: lineValueAtTime(paired.upper, paired.startTimeMs) },
                { timeMs: projectionEnd, value: lineValueAtTime(paired.upper, projectionEnd) },
                { timeMs: paired.startTimeMs, value: lineValueAtTime(paired.lower, paired.startTimeMs) },
                { timeMs: projectionEnd, value: lineValueAtTime(paired.lower, projectionEnd) }
            ];

        return finalizePattern({
            type,
            variant,
            confidence,
            anchors,
            lines: { upper: paired.upper, lower: paired.lower },
            touches: { upper: paired.highs.length, lower: paired.lows.length },
            formation: {
                startTimeMs: paired.startTimeMs,
                endTimeMs: paired.endTimeMs,
                apexTimeMs
            }
        }, context, options);
    }

    function selectPatterns(patterns, options) {
        const sorted = patterns
            .filter(pattern => pattern && pattern.confidence >= options.minConfidence)
            .sort((left, right) => {
                if (Math.abs(right.confidence - left.confidence) > 0.001) {
                    return right.confidence - left.confidence;
                }
                return left.variant.localeCompare(right.variant);
            });
        const selected = [];
        const typeCounts = {};
        let structuralCount = 0;

        for (const pattern of sorted) {
            const isStructural = ['channel', 'triangle', 'wedge'].includes(pattern.type);
            if (pattern.type === 'horizontal' && (typeCounts.horizontal || 0) >= 2) {
                continue;
            }
            if (pattern.type === 'trend' && (typeCounts.trend || 0) >= 1) {
                continue;
            }
            if (isStructural && structuralCount >= 2) {
                continue;
            }
            if (selected.some(item => item.type === pattern.type && item.variant === pattern.variant)) {
                continue;
            }

            selected.push(pattern);
            typeCounts[pattern.type] = (typeCounts[pattern.type] || 0) + 1;
            if (isStructural) {
                structuralCount += 1;
            }
            if (selected.length >= options.maxPatterns) {
                break;
            }
        }
        return selected;
    }

    function scanPatterns(data, suppliedOptions = {}) {
        const options = { ...DEFAULT_OPTIONS, ...suppliedOptions };
        const candles = normalizeCandles(data);
        if (candles.length < options.minCandles) {
            return [];
        }

        const context = createContext(candles);
        if (Number.isFinite(suppliedOptions.projectionTimeMs)) {
            context.projectionTimeMs = Number(suppliedOptions.projectionTimeMs);
            context.projectionX = context.toX(context.projectionTimeMs);
        }
        const paired = getPairedBoundaryFits(context);
        const channel = detectChannelPattern(context, options, paired);
        const converging = detectConvergingPattern(context, options, paired);
        return selectPatterns([
            ...detectHorizontalPatterns(context, options),
            ...detectTrendPatterns(context, options),
            channel,
            converging
        ], options);
    }

    function getPatternDirections(pattern) {
        const directions = [];
        if (pattern?.lines?.upper) {
            directions.push('up');
        }
        if (pattern?.lines?.lower) {
            directions.push('down');
        }
        return directions;
    }

    function isOutsidePattern(pattern, candle, direction, buffer) {
        const line = direction === 'up' ? pattern.lines.upper : pattern.lines.lower;
        const boundary = lineValueAtTime(line, candle.timeMs);
        return direction === 'up'
            ? candle.close > boundary + buffer
            : candle.close < boundary - buffer;
    }

    function isBackInsidePattern(pattern, candle, direction, buffer) {
        const line = direction === 'up' ? pattern.lines.upper : pattern.lines.lower;
        const boundary = lineValueAtTime(line, candle.timeMs);
        return direction === 'up'
            ? candle.close <= boundary + (buffer * 0.15)
            : candle.close >= boundary - (buffer * 0.15);
    }

    function findConfirmedCrossings(pattern, candles, direction, buffer, options) {
        const confirmations = Math.max(2, options.confirmationCandles);
        const startIndex = Math.max(confirmations, candles.length - options.eventLookbackCandles);
        const crossings = [];

        for (let index = startIndex; index < candles.length; index += 1) {
            let confirmed = true;
            for (let offset = 0; offset < confirmations; offset += 1) {
                if (!isOutsidePattern(pattern, candles[index - offset], direction, buffer)) {
                    confirmed = false;
                    break;
                }
            }
            if (!confirmed) {
                continue;
            }

            const beforeIndex = index - confirmations;
            if (beforeIndex >= 0 && isOutsidePattern(pattern, candles[beforeIndex], direction, buffer)) {
                continue;
            }
            crossings.push({ confirmIndex: index, firstOutsideIndex: index - confirmations + 1 });
        }
        return crossings;
    }

    function detectSignificantEvents(patterns, data, suppliedOptions = {}) {
        const options = { ...DEFAULT_OPTIONS, ...suppliedOptions };
        const candles = normalizeCandles(data);
        if (candles.length < options.minCandles) {
            return [];
        }

        const volatility = getVolatility(candles);
        const latest = candles[candles.length - 1];
        const buffer = Math.max(volatility * 0.38, latest.close * 0.0011);
        const events = [];

        (patterns || [])
            .filter(pattern => {
                const minimumConfidence = pattern?.type === 'horizontal'
                    ? Math.max(options.eventConfidence, 0.8)
                    : (pattern?.type === 'trend'
                        ? Math.max(options.eventConfidence, 0.76)
                        : options.eventConfidence);
                return pattern?.confidence >= minimumConfidence;
            })
            .forEach(pattern => {
                getPatternDirections(pattern).forEach(direction => {
                    const crossings = findConfirmedCrossings(pattern, candles, direction, buffer, options);
                    const crossing = crossings[crossings.length - 1];
                    if (!crossing) {
                        return;
                    }

                    const boundaryLine = direction === 'up' ? pattern.lines.upper : pattern.lines.lower;
                    const boundaryNow = lineValueAtTime(boundaryLine, latest.timeMs);
                    const distancePercent = Math.abs((latest.close - boundaryNow) / boundaryNow) * 100;
                    const candlesAfterConfirmation = candles.slice(crossing.confirmIndex + 1);
                    const latestTwo = candles.slice(-2);
                    const failed = candlesAfterConfirmation.length >= 2
                        && latestTwo.every(candle => isBackInsidePattern(pattern, candle, direction, buffer));
                    let retestIndex = -1;

                    if (!failed && candlesAfterConfirmation.length > 0 && isOutsidePattern(pattern, latest, direction, buffer)) {
                        candlesAfterConfirmation.forEach((candle, relativeIndex) => {
                            const boundary = lineValueAtTime(boundaryLine, candle.timeMs);
                            const touched = direction === 'up'
                                ? candle.low <= boundary + buffer && candle.close > boundary + buffer
                                : candle.high >= boundary - buffer && candle.close < boundary - buffer;
                            if (touched) {
                                retestIndex = crossing.confirmIndex + 1 + relativeIndex;
                            }
                        });
                    }

                    const kind = failed
                        ? (direction === 'up' ? 'failed-breakout' : 'failed-breakdown')
                        : (retestIndex >= 0
                            ? 'retest-held'
                            : (direction === 'up' ? 'breakout' : 'breakdown'));
                    const eventIndex = failed
                        ? candles.length - 1
                        : (retestIndex >= 0 ? retestIndex : crossing.confirmIndex);
                    const eventTimeMs = candles[eventIndex].timeMs;
                    const fingerprint = [pattern.type, pattern.variant, direction, kind, eventTimeMs].join('|');

                    events.push({
                        id: `event-${hashString(fingerprint)}`,
                        fingerprint,
                        kind,
                        direction,
                        patternId: pattern.id,
                        patternType: pattern.type,
                        patternVariant: pattern.variant,
                        patternLabel: getPatternLabel(pattern),
                        confidence: pattern.confidence,
                        eventTimeMs,
                        close: latest.close,
                        boundary: boundaryNow,
                        distancePercent,
                        confirmationCandles: options.confirmationCandles,
                        priority: failed ? 3 : (retestIndex >= 0 ? 2 : 1),
                        structurePriority: ['channel', 'triangle', 'wedge'].includes(pattern.type)
                            ? 3
                            : (pattern.type === 'trend' ? 2 : 1)
                    });
                });
            });

        return events
            .sort((left, right) => {
                if (right.priority !== left.priority) {
                    return right.priority - left.priority;
                }
                if (right.structurePriority !== left.structurePriority) {
                    return right.structurePriority - left.structurePriority;
                }
                if (right.eventTimeMs !== left.eventTimeMs) {
                    return right.eventTimeMs - left.eventTimeMs;
                }
                return right.confidence - left.confidence;
            })
            .filter((event, index, all) => all.findIndex(item => item.fingerprint === event.fingerprint) === index);
    }

    function mergeEventPattern(patterns, eventPatterns, events, options) {
        const merged = [...patterns];
        events.forEach(event => {
            if (merged.some(pattern => pattern.type === event.patternType && pattern.variant === event.patternVariant)) {
                return;
            }
            const eventPattern = eventPatterns.find(pattern => pattern.id === event.patternId);
            if (eventPattern) {
                merged.push(eventPattern);
            }
        });
        return selectPatterns(merged, options);
    }

    function scanMarketWindow(data, options) {
        const candles = normalizeCandles(data);
        if (candles.length < options.minCandles) {
            return {
                candles,
                patterns: [],
                events: [],
                diagnostics: {
                    sufficientData: false,
                    candleCount: candles.length,
                    intervalMs: getMedianIntervalMs(candles)
                }
            };
        }

        const projectionTimeMs = candles[candles.length - 1].timeMs;
        const overlayFormation = candles.length >= options.minCandles + 2
            ? candles.slice(0, -2)
            : candles;
        const eventFormation = candles.length >= options.minCandles + 8
            ? candles.slice(0, -8)
            : overlayFormation;
        const scanOptions = { ...options, projectionTimeMs };
        const patterns = scanPatterns(overlayFormation, scanOptions);
        const eventPatterns = scanPatterns(eventFormation, scanOptions);
        const events = detectSignificantEvents(eventPatterns, candles, options);

        return {
            candles,
            patterns: mergeEventPattern(patterns, eventPatterns, events, options),
            events,
            diagnostics: {
                sufficientData: true,
                candleCount: candles.length,
                intervalMs: getMedianIntervalMs(candles),
                volatility: getVolatility(candles)
            }
        };
    }

    function getScanWindowSizes(candles, options) {
        if (!Array.isArray(options.lookbackWindows) || options.lookbackWindows.length === 0) {
            return [candles.length];
        }

        const requestedWindows = options.lookbackWindows
            .map(value => Math.round(Number(value)))
            .filter(value => Number.isFinite(value)
                && value >= options.minCandles
                && value < candles.length);

        return [...new Set([...requestedWindows, candles.length])]
            .sort((left, right) => left - right);
    }

    function compareSignificantEvents(left, right) {
        if (right.priority !== left.priority) {
            return right.priority - left.priority;
        }
        if (right.structurePriority !== left.structurePriority) {
            return right.structurePriority - left.structurePriority;
        }
        if (right.eventTimeMs !== left.eventTimeMs) {
            return right.eventTimeMs - left.eventTimeMs;
        }
        return right.confidence - left.confidence;
    }

    function scanMarket(data, suppliedOptions = {}) {
        const options = { ...DEFAULT_OPTIONS, ...suppliedOptions };
        const candles = normalizeCandles(data);
        if (candles.length < options.minCandles) {
            return scanMarketWindow(candles, options);
        }

        const windowSizes = getScanWindowSizes(candles, options);
        if (windowSizes.length === 1) {
            return scanMarketWindow(candles, options);
        }

        const windowResults = windowSizes.map(windowSize => {
            const result = scanMarketWindow(candles.slice(-windowSize), options);
            return {
                windowSize,
                result,
                patterns: result.patterns.map(pattern => ({
                    ...pattern,
                    scanWindowCandles: windowSize
                })),
                events: result.events.map(event => ({
                    ...event,
                    scanWindowCandles: windowSize
                }))
            };
        });
        const patterns = selectPatterns(
            windowResults.flatMap(windowResult => windowResult.patterns),
            options
        );
        const selectedPatternVariants = new Set(
            patterns.map(pattern => `${pattern.type}|${pattern.variant}`)
        );
        const events = windowResults
            .flatMap(windowResult => windowResult.events)
            .filter(event => selectedPatternVariants.has(`${event.patternType}|${event.patternVariant}`))
            .sort(compareSignificantEvents)
            .filter((event, index, all) => (
                all.findIndex(item => item.fingerprint === event.fingerprint) === index
            ));
        const fullWindowResult = windowResults.find(windowResult => (
            windowResult.windowSize === candles.length
        ));

        return {
            candles,
            patterns,
            events,
            diagnostics: {
                ...fullWindowResult.result.diagnostics,
                windowsScanned: windowSizes
            }
        };
    }

    function formatEventCommentary(event, context = {}) {
        if (!event) {
            return '';
        }

        const rangeLabel = context.rangeLabel || 'Chart';
        const assetLabel = context.assetLabel || 'BTC';
        const candleLabel = context.candleLabel || 'closed';
        const patternLabel = (event.patternLabel || 'chart structure').toLowerCase();
        const distance = Math.max(0.1, Number(event.distancePercent) || 0).toFixed(1);

        if (event.kind === 'failed-breakout') {
            return `${rangeLabel}: The ${patternLabel} breakout failed; ${assetLabel} closed back inside the pattern.`;
        }
        if (event.kind === 'failed-breakdown') {
            return `${rangeLabel}: The ${patternLabel} breakdown failed; ${assetLabel} closed back inside the pattern.`;
        }
        if (event.kind === 'retest-held') {
            const side = event.direction === 'up' ? 'above' : 'below';
            return `${rangeLabel}: ${assetLabel} retested the ${patternLabel} boundary and held ${side} it.`;
        }
        if (event.kind === 'breakout') {
            return `${rangeLabel}: ${assetLabel} closed ${distance}% above the ${patternLabel} after ${event.confirmationCandles} ${candleLabel} candles, confirming an upside breakout.`;
        }
        if (event.kind === 'breakdown') {
            return `${rangeLabel}: ${assetLabel} closed ${distance}% below the ${patternLabel} after ${event.confirmationCandles} ${candleLabel} candles, confirming a downside breakdown.`;
        }
        return '';
    }

    return Object.freeze({
        aggregateCandles,
        detectPivots,
        detectSignificantEvents,
        formatEventCommentary,
        getPatternLabel,
        lineValueAtTime,
        normalizeCandles,
        scanMarket,
        scanPatterns
    });
}));
