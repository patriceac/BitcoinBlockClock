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
        maxPatterns: 2,
        maxTotalPatterns: 4,
        minEpisodeDetections: 2,
        minConfidence: 0.64,
        eventConfidence: 0.72,
        eventLookbackCandles: 12,
        confirmationCandles: 2,
        qualityMultiplier: 1
    });
    const DEFAULT_TENTATIVE_OPTIONS = Object.freeze({
        minConfidence: 0.56,
        confirmedMinConfidence: DEFAULT_OPTIONS.minConfidence,
        maxPatterns: 2
    });
    const PRICE_TOLERANCE_RATIO = 0.0016;
    const STRUCTURE_BOUNDARY_WIDTH_TOLERANCE_RATIO = 0.12;
    const VISIBILITY_SLICE_COUNT = 7;
    const MIN_SHARED_SPAN_RATIO = 0.62;
    const MIN_ENVELOPE_OVERLAP_RATIO = 0.62;
    const MIN_REDUNDANT_SLICE_RATIO = 0.6;
    const MIN_BOUNDARY_MATCH_SLICE_RATIO = 0.7;
    const MIN_REDUNDANT_CONSECUTIVE_SLICES = 3;
    const ROLLING_SCAN_STEP_RATIO = 0.25;
    const MIN_EPISODE_SHARED_SPAN_RATIO = 0.45;
    const EPISODE_BOUNDARY_DISTANCE_RATIO = 0.008;
    const EPISODE_ENVELOPE_CENTER_WIDTH_RATIO = 0.72;
    const MIN_TENTATIVE_ALTERNATIVE_OVERLAP_RATIO = 0.45;

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

    function aggregateClosedCandles(data, bucketMs, sourceIntervalMs, nowMs = Date.now()) {
        const expected = bucketMs / sourceIntervalMs;
        if (!Number.isInteger(expected) || expected < 1) return [];
        const candles = normalizeCandles(data);
        const times = new Set(candles.map(candle => candle.timeMs));
        return aggregateCandles(candles, bucketMs).filter(candle => (
            candle.timeMs + bucketMs <= nowMs
            && Array.from({ length: expected }, (_, index) => (
                times.has(candle.timeMs + index * sourceIntervalMs)
            )).every(Boolean)
        ));
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
            availableTimeMs: context.candles[context.candles.length - 1].timeMs + context.intervalMs,
            projectionTimeMs: context.projectionTimeMs,
            source: 'autoscan',
            locked: true
        };
    }

    function createContext(candles) {
        const intervalMs = getMedianIntervalMs(candles);
        const baseTimeMs = candles[0].timeMs;
        const volatility = getVolatility(candles);
        const priceScale = median(candles.map(candle => candle.close)) || 1;
        const tolerance = Math.max(volatility * 0.78, priceScale * PRICE_TOLERANCE_RATIO);
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

    function groupHorizontalChannel(patterns, context) {
        const support = patterns.find(pattern => (
            pattern?.type === 'horizontal' && pattern.variant === 'support'
        ));
        const resistance = patterns.find(pattern => (
            pattern?.type === 'horizontal' && pattern.variant === 'resistance'
        ));
        const lower = support?.lines?.lower;
        const upper = resistance?.lines?.upper;
        if (!support || !resistance || !lower || !upper) {
            return patterns;
        }

        const startTimeMs = Math.min(
            support.formation.startTimeMs,
            resistance.formation.startTimeMs
        );
        const endTimeMs = Math.max(
            support.formation.endTimeMs,
            resistance.formation.endTimeMs
        );
        const lowerStart = lineValueAtTime(lower, startTimeMs);
        const upperStart = lineValueAtTime(upper, startTimeMs);
        const lowerEnd = lineValueAtTime(lower, context.projectionTimeMs);
        const upperEnd = lineValueAtTime(upper, context.projectionTimeMs);
        if (![lowerStart, upperStart, lowerEnd, upperEnd].every(Number.isFinite)
            || upperStart - lowerStart <= context.tolerance
            || upperEnd - lowerEnd <= context.tolerance) {
            return patterns;
        }

        const componentIds = [support.id, resistance.id].sort();
        const channel = {
            id: `autoscan-${hashString(['horizontal-channel', ...componentIds].join('|'))}`,
            type: 'channel',
            variant: 'horizontal-channel',
            label: getPatternLabel({ variant: 'horizontal-channel' }),
            confidence: Math.min(support.confidence, resistance.confidence),
            anchors: [
                { timeMs: startTimeMs, value: lowerStart },
                { timeMs: context.projectionTimeMs, value: lowerEnd },
                { timeMs: startTimeMs, value: upperStart }
            ],
            lines: { upper, lower },
            touches: {
                upper: Number(resistance.touches?.upper) || 0,
                lower: Number(support.touches?.lower) || 0
            },
            formation: { startTimeMs, endTimeMs },
            availableTimeMs: Math.max(support.availableTimeMs, resistance.availableTimeMs),
            projectionTimeMs: context.projectionTimeMs,
            components: ['support', 'resistance'],
            componentIds,
            source: 'autoscan',
            locked: true
        };

        return [
            ...patterns.filter(pattern => pattern !== support && pattern !== resistance),
            channel
        ];
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
        const eligiblePatterns = prioritizeVisiblePatterns(
            suppressTentativePatternsWithConfirmedAlternatives(
                patterns.filter(pattern => pattern && pattern.confidence >= options.minConfidence)
            )
        );
        const sorted = eligiblePatterns
            .map((pattern, index) => ({ pattern, index }))
            .sort(comparePatternVisibilityPriority)
            .map(entry => entry.pattern);
        const selected = [];

        for (const pattern of sorted) {
            if (wouldExceedPatternTrancheLimits(pattern, selected, options)) {
                continue;
            }

            selected.push(pattern);
        }
        return limitPatternsByTimeline(selected, options);
    }

    function getPatternProjectionTimeMs(pattern) {
        const explicitProjectionTimeMs = Number(pattern?.projectionTimeMs);
        if (Number.isFinite(explicitProjectionTimeMs)) {
            return explicitProjectionTimeMs;
        }

        const apexTimeMs = Number(pattern?.formation?.apexTimeMs);
        const times = [
            Number(pattern?.formation?.endTimeMs),
            ...(Array.isArray(pattern?.anchors)
                ? pattern.anchors
                    .map(anchor => Number(anchor?.timeMs))
                    .filter(timeMs => !Number.isFinite(apexTimeMs) || timeMs !== apexTimeMs)
                : [])
        ].filter(Number.isFinite);
        return times.length ? Math.max(...times) : NaN;
    }

    function getPatternTimeRange(pattern) {
        const anchorTimes = Array.isArray(pattern?.anchors)
            ? pattern.anchors.map(anchor => Number(anchor?.timeMs)).filter(Number.isFinite)
            : [];
        const formationStartTimeMs = Number(pattern?.formation?.startTimeMs);
        const startTimeMs = Number.isFinite(formationStartTimeMs)
            ? formationStartTimeMs
            : (anchorTimes.length ? Math.min(...anchorTimes) : NaN);
        const endTimeMs = getPatternProjectionTimeMs(pattern);
        if (!Number.isFinite(startTimeMs)
            || !Number.isFinite(endTimeMs)
            || endTimeMs <= startTimeMs) {
            return null;
        }

        return {
            startTimeMs,
            endTimeMs,
            durationMs: endTimeMs - startTimeMs
        };
    }

    function getPatternSlice(pattern, timeMs) {
        const upperValue = pattern?.lines?.upper
            ? lineValueAtTime(pattern.lines.upper, timeMs)
            : NaN;
        const lowerValue = pattern?.lines?.lower
            ? lineValueAtTime(pattern.lines.lower, timeMs)
            : NaN;
        const hasUpper = Number.isFinite(upperValue);
        const hasLower = Number.isFinite(lowerValue);
        if (hasUpper && hasLower) {
            const lower = Math.min(lowerValue, upperValue);
            const upper = Math.max(lowerValue, upperValue);
            const width = upper - lower;
            if (width <= Number.EPSILON) {
                return null;
            }
            return { kind: 'envelope', lower, upper, width };
        }

        if (hasUpper) {
            return { kind: 'boundary', side: 'upper', value: upperValue };
        }
        if (hasLower) {
            return { kind: 'boundary', side: 'lower', value: lowerValue };
        }
        return null;
    }

    function getVisibilitySliceTimes(left, right, minimumSharedSpanRatio = MIN_SHARED_SPAN_RATIO) {
        const leftRange = getPatternTimeRange(left);
        const rightRange = getPatternTimeRange(right);
        if (!leftRange || !rightRange) {
            return [];
        }

        const sharedStartTimeMs = Math.max(leftRange.startTimeMs, rightRange.startTimeMs);
        const sharedEndTimeMs = Math.min(leftRange.endTimeMs, rightRange.endTimeMs);
        const sharedDurationMs = sharedEndTimeMs - sharedStartTimeMs;
        const shorterDurationMs = Math.min(leftRange.durationMs, rightRange.durationMs);
        if (sharedDurationMs <= 0
            || sharedDurationMs / shorterDurationMs < minimumSharedSpanRatio) {
            return [];
        }

        return Array.from({ length: VISIBILITY_SLICE_COUNT }, (_, index) => (
            sharedStartTimeMs
            + ((sharedDurationMs * index) / Math.max(1, VISIBILITY_SLICE_COUNT - 1))
        ));
    }

    function getBoundaryProximity(leftValue, rightValue, envelopeWidth = Infinity) {
        const referencePrice = Math.max(Math.abs(leftValue), Math.abs(rightValue), 1);
        const priceProximity = referencePrice * PRICE_TOLERANCE_RATIO;
        if (!Number.isFinite(envelopeWidth) || envelopeWidth <= 0) {
            return priceProximity;
        }
        return Math.min(
            priceProximity,
            envelopeWidth * STRUCTURE_BOUNDARY_WIDTH_TOLERANCE_RATIO
        );
    }

    function areBoundarySlicesRedundant(leftSlice, rightSlice) {
        if (leftSlice.kind === 'boundary' && rightSlice.kind === 'boundary') {
            const proximity = getBoundaryProximity(leftSlice.value, rightSlice.value);
            return Math.abs(leftSlice.value - rightSlice.value) <= proximity;
        }

        const boundarySlice = leftSlice.kind === 'boundary' ? leftSlice : rightSlice;
        const envelopeSlice = boundarySlice === leftSlice ? rightSlice : leftSlice;
        const nearestEnvelopeValue = clamp(
            boundarySlice.value,
            envelopeSlice.lower,
            envelopeSlice.upper
        );
        const proximity = getBoundaryProximity(
            boundarySlice.value,
            nearestEnvelopeValue,
            envelopeSlice.width
        );
        return Math.abs(boundarySlice.value - nearestEnvelopeValue) <= proximity;
    }

    function getEnvelopeOverlapRatio(leftSlice, rightSlice) {
        const overlap = Math.max(
            0,
            Math.min(leftSlice.upper, rightSlice.upper)
                - Math.max(leftSlice.lower, rightSlice.lower)
        );
        const smallerWidth = Math.min(leftSlice.width, rightSlice.width);
        return smallerWidth > 0 ? overlap / smallerWidth : 0;
    }

    function hasRedundantSliceRun(values, predicate) {
        let runLength = 0;
        for (const value of values) {
            runLength = predicate(value) ? runLength + 1 : 0;
            if (runLength >= MIN_REDUNDANT_CONSECUTIVE_SLICES) {
                return true;
            }
        }
        return false;
    }

    function arePatternsRedundant(left, right) {
        const sliceTimes = getVisibilitySliceTimes(left, right);
        if (!sliceTimes.length) {
            return false;
        }

        const slicePairs = sliceTimes
            .map(timeMs => [getPatternSlice(left, timeMs), getPatternSlice(right, timeMs)])
            .filter(([leftSlice, rightSlice]) => leftSlice && rightSlice);
        if (slicePairs.length !== sliceTimes.length) {
            return false;
        }

        const bothEnvelopes = slicePairs.every(([leftSlice, rightSlice]) => (
            leftSlice.kind === 'envelope' && rightSlice.kind === 'envelope'
        ));
        if (bothEnvelopes) {
            const overlapRatios = slicePairs.map(([leftSlice, rightSlice]) => (
                getEnvelopeOverlapRatio(leftSlice, rightSlice)
            ));
            const overlappingSliceRatio = overlapRatios.filter(ratio => (
                ratio >= MIN_ENVELOPE_OVERLAP_RATIO
            )).length / overlapRatios.length;
            return (median(overlapRatios) >= MIN_ENVELOPE_OVERLAP_RATIO
                    && overlappingSliceRatio >= MIN_REDUNDANT_SLICE_RATIO)
                || hasRedundantSliceRun(
                    overlapRatios,
                    ratio => ratio >= MIN_ENVELOPE_OVERLAP_RATIO
                );
        }

        const hasOnlyBoundariesAndEnvelopes = slicePairs.every(([leftSlice, rightSlice]) => (
            ['boundary', 'envelope'].includes(leftSlice.kind)
            && ['boundary', 'envelope'].includes(rightSlice.kind)
            && (leftSlice.kind === 'boundary' || rightSlice.kind === 'boundary')
        ));
        if (!hasOnlyBoundariesAndEnvelopes) {
            return false;
        }

        const boundaryMatches = slicePairs.map(([leftSlice, rightSlice]) => (
            areBoundarySlicesRedundant(leftSlice, rightSlice)
        ));
        const matchingSliceRatio = boundaryMatches.filter(Boolean).length / boundaryMatches.length;
        return matchingSliceRatio >= MIN_BOUNDARY_MATCH_SLICE_RATIO
            || hasRedundantSliceRun(boundaryMatches, Boolean);
    }

    function getPatternTimeOverlapRatio(left, right) {
        const leftRange = getPatternTimeRange(left);
        const rightRange = getPatternTimeRange(right);
        if (!leftRange || !rightRange) {
            return 0;
        }

        const overlapMs = Math.max(
            0,
            Math.min(leftRange.endTimeMs, rightRange.endTimeMs)
                - Math.max(leftRange.startTimeMs, rightRange.startTimeMs)
        );
        const shorterDurationMs = Math.min(leftRange.durationMs, rightRange.durationMs);
        return shorterDurationMs > 0 ? overlapMs / shorterDurationMs : 0;
    }

    function arePatternSlicesSimilarForEpisode(left, right) {
        const sliceTimes = getVisibilitySliceTimes(
            left,
            right,
            MIN_EPISODE_SHARED_SPAN_RATIO
        );
        if (!sliceTimes.length) {
            return false;
        }

        const slicePairs = sliceTimes
            .map(timeMs => [getPatternSlice(left, timeMs), getPatternSlice(right, timeMs)])
            .filter(([leftSlice, rightSlice]) => leftSlice && rightSlice);
        if (slicePairs.length !== sliceTimes.length) {
            return false;
        }

        const bothEnvelopes = slicePairs.every(([leftSlice, rightSlice]) => (
            leftSlice.kind === 'envelope' && rightSlice.kind === 'envelope'
        ));
        if (bothEnvelopes) {
            return median(slicePairs.map(([leftSlice, rightSlice]) => {
                const leftCenter = (leftSlice.lower + leftSlice.upper) / 2;
                const rightCenter = (rightSlice.lower + rightSlice.upper) / 2;
                const referenceWidth = Math.max(
                    Math.min(leftSlice.width, rightSlice.width),
                    Math.max(Math.abs(leftCenter), Math.abs(rightCenter), 1)
                        * PRICE_TOLERANCE_RATIO
                );
                return Math.abs(leftCenter - rightCenter) / referenceWidth;
            })) <= EPISODE_ENVELOPE_CENTER_WIDTH_RATIO;
        }

        const bothBoundaries = slicePairs.every(([leftSlice, rightSlice]) => (
            leftSlice.kind === 'boundary' && rightSlice.kind === 'boundary'
        ));
        if (!bothBoundaries) {
            return false;
        }

        return median(slicePairs.map(([leftSlice, rightSlice]) => {
            const referencePrice = Math.max(
                Math.abs(leftSlice.value),
                Math.abs(rightSlice.value),
                1
            );
            return Math.abs(leftSlice.value - rightSlice.value) / referencePrice;
        })) <= EPISODE_BOUNDARY_DISTANCE_RATIO;
    }

    function arePatternsInSameEpisode(left, right) {
        return left?.type === right?.type
            && left?.variant === right?.variant
            && getPatternTimeOverlapRatio(left, right) >= MIN_EPISODE_SHARED_SPAN_RATIO
            && (arePatternsRedundant(left, right)
                || arePatternSlicesSimilarForEpisode(left, right));
    }

    function getPatternBoundaryCount(pattern) {
        return ['upper', 'lower'].filter(side => pattern?.lines?.[side]).length;
    }

    function getPatternTouchCount(pattern) {
        return Object.values(pattern?.touches || {}).reduce((sum, value) => {
            const count = Number(value);
            return sum + (Number.isFinite(count) ? count : 0);
        }, 0);
    }

    function isTentativePattern(pattern) {
        return pattern?.tentative === true
            || pattern?.confidenceBand === 'tentative'
            || pattern?.source === 'autoscan-tentative';
    }

    function comparePatternVisibilityPriority(leftEntry, rightEntry) {
        const left = leftEntry.pattern;
        const right = rightEntry.pattern;
        const confirmationDifference = Number(isTentativePattern(left)) - Number(isTentativePattern(right));
        if (confirmationDifference !== 0) {
            return confirmationDifference;
        }

        const boundaryDifference = getPatternBoundaryCount(right) - getPatternBoundaryCount(left);
        if (boundaryDifference !== 0) {
            return boundaryDifference;
        }

        const confidenceDifference = Number(right.confidence || 0) - Number(left.confidence || 0);
        if (Math.abs(confidenceDifference) > 0.001) {
            return confidenceDifference;
        }

        const touchDifference = getPatternTouchCount(right) - getPatternTouchCount(left);
        if (touchDifference !== 0) {
            return touchDifference;
        }

        const scanWindowDifference = Number(right.scanWindowCandles || 0)
            - Number(left.scanWindowCandles || 0);
        if (scanWindowDifference !== 0) {
            return scanWindowDifference;
        }

        const leftDurationMs = getPatternTimeRange(left)?.durationMs || 0;
        const rightDurationMs = getPatternTimeRange(right)?.durationMs || 0;
        if (rightDurationMs !== leftDurationMs) {
            return rightDurationMs - leftDurationMs;
        }

        const variantDifference = String(left.variant || '').localeCompare(String(right.variant || ''));
        return variantDifference || leftEntry.index - rightEntry.index;
    }

    function suppressTentativePatternsWithConfirmedAlternatives(patterns) {
        const confirmedPatterns = patterns.filter(pattern => !isTentativePattern(pattern));
        if (!confirmedPatterns.length) {
            return patterns;
        }

        return patterns.filter(pattern => (
            !isTentativePattern(pattern)
            || !confirmedPatterns.some(confirmed => (
                getPatternTimeOverlapRatio(pattern, confirmed)
                    >= MIN_TENTATIVE_ALTERNATIVE_OVERLAP_RATIO
            ))
        ));
    }

    function getPatternScanKey(pattern) {
        const windowSize = Number(pattern?.scanWindowCandles);
        const startIndex = Number(pattern?.scanStartIndex);
        const endIndex = Number(pattern?.scanEndIndex);
        if (![windowSize, startIndex, endIndex].every(Number.isFinite)) {
            return null;
        }
        return `${windowSize}:${startIndex}:${endIndex}`;
    }

    function consolidatePersistentPatternEpisodes(patterns, options) {
        const requestedDetectionCount = Math.round(Number(options.minEpisodeDetections));
        const minEpisodeDetections = clamp(
            Number.isFinite(requestedDetectionCount)
                ? requestedDetectionCount
                : DEFAULT_OPTIONS.minEpisodeDetections,
            1,
            6
        );
        const episodes = [];

        (patterns || []).filter(Boolean).forEach(pattern => {
            const matchingIndexes = episodes
                .map((episode, index) => (
                    episode.some(member => arePatternsInSameEpisode(pattern, member))
                        ? index
                        : -1
                ))
                .filter(index => index >= 0);
            if (!matchingIndexes.length) {
                episodes.push([pattern]);
                return;
            }

            const mergedEpisode = [pattern];
            [...matchingIndexes].reverse().forEach(index => {
                mergedEpisode.push(...episodes[index]);
                episodes.splice(index, 1);
            });
            episodes.push(mergedEpisode);
        });

        return episodes
            .map((episode, episodeIndex) => {
                const scanKeys = new Set(episode.map(getPatternScanKey).filter(Boolean));
                const currentMembers = episode.filter(pattern => pattern.scanIsCurrent === true);
                const representativePool = currentMembers.length ? currentMembers : episode;
                const representative = representativePool
                    .map((pattern, index) => ({ pattern, index }))
                    .sort(comparePatternVisibilityPriority)[0]?.pattern;
                return {
                    representative,
                    episodeIndex,
                    detectionCount: scanKeys.size,
                    windowSizes: [...new Set(episode
                        .map(pattern => Number(pattern.scanWindowCandles))
                        .filter(Number.isFinite))]
                        .sort((left, right) => left - right)
                };
            })
            .filter(episode => (
                episode.representative
                && episode.detectionCount >= minEpisodeDetections
            ))
            .map(episode => ({
                ...episode.representative,
                episodeDetectionCount: episode.detectionCount,
                episodeWindowSizes: episode.windowSizes
            }));
    }

    function isPatternActiveAtTime(pattern, timeMs) {
        const range = getPatternTimeRange(pattern);
        return range
            ? timeMs >= range.startTimeMs && timeMs <= range.endTimeMs
            : false;
    }

    function wouldExceedPatternTrancheLimits(candidate, selected, options) {
        const candidateRange = getPatternTimeRange(candidate);
        if (!candidateRange) {
            return selected.length >= options.maxPatterns;
        }

        const overlappingRanges = selected
            .map(pattern => ({ pattern, range: getPatternTimeRange(pattern) }))
            .filter(entry => entry.range
                && entry.range.endTimeMs >= candidateRange.startTimeMs
                && entry.range.startTimeMs <= candidateRange.endTimeMs);
        const sampleTimes = new Set([candidateRange.startTimeMs]);
        overlappingRanges.forEach(({ range }) => {
            if (range.startTimeMs >= candidateRange.startTimeMs
                && range.startTimeMs <= candidateRange.endTimeMs) {
                sampleTimes.add(range.startTimeMs);
            }
        });

        return [...sampleTimes].some(timeMs => {
            const activePatterns = [
                candidate,
                ...overlappingRanges
                    .map(entry => entry.pattern)
                    .filter(pattern => isPatternActiveAtTime(pattern, timeMs))
            ];
            const structuralCount = activePatterns.filter(pattern => (
                ['channel', 'triangle', 'wedge'].includes(pattern.type)
            )).length;
            const trendCount = activePatterns.filter(pattern => pattern.type === 'trend').length;
            const horizontalCount = activePatterns.filter(pattern => pattern.type === 'horizontal').length;
            return activePatterns.length > options.maxPatterns
                || structuralCount > 2
                || trendCount > 1
                || horizontalCount > 2;
        });
    }

    function limitPatternsByTimeline(patterns, options) {
        const requestedMaxTotal = Math.round(Number(options.maxTotalPatterns));
        const maxTotalPatterns = clamp(
            Number.isFinite(requestedMaxTotal)
                ? requestedMaxTotal
                : DEFAULT_OPTIONS.maxTotalPatterns,
            1,
            12
        );
        if (patterns.length <= maxTotalPatterns) {
            return patterns;
        }

        const patternRanges = patterns
            .map(pattern => ({ pattern, range: getPatternTimeRange(pattern) }))
            .filter(entry => entry.range);
        const suppliedStartTimeMs = Number(options.displayStartTimeMs);
        const suppliedEndTimeMs = Number(options.displayEndTimeMs);
        const startTimeMs = Number.isFinite(suppliedStartTimeMs)
            ? suppliedStartTimeMs
            : Math.min(...patternRanges.map(entry => entry.range.startTimeMs));
        const endTimeMs = Number.isFinite(suppliedEndTimeMs)
            ? suppliedEndTimeMs
            : Math.max(...patternRanges.map(entry => entry.range.endTimeMs));
        if (!Number.isFinite(startTimeMs)
            || !Number.isFinite(endTimeMs)
            || endTimeMs <= startTimeMs) {
            return patterns.slice(0, maxTotalPatterns);
        }

        const durationMs = endTimeMs - startTimeMs;
        const chosenPatterns = new Set();
        for (let binIndex = 0; binIndex < maxTotalPatterns; binIndex += 1) {
            const binStartTimeMs = startTimeMs + ((durationMs * binIndex) / maxTotalPatterns);
            const binEndTimeMs = startTimeMs + ((durationMs * (binIndex + 1)) / maxTotalPatterns);
            const candidates = patternRanges
                .filter(entry => {
                    const midpointTimeMs = entry.range.startTimeMs + (entry.range.durationMs / 2);
                    return midpointTimeMs >= binStartTimeMs
                        && (binIndex === maxTotalPatterns - 1
                            ? midpointTimeMs <= binEndTimeMs
                            : midpointTimeMs < binEndTimeMs);
                })
                .map((entry, index) => ({ pattern: entry.pattern, index }))
                .sort(comparePatternVisibilityPriority);
            if (candidates[0]) {
                chosenPatterns.add(candidates[0].pattern);
            }
        }

        patterns.forEach(pattern => {
            if (chosenPatterns.size < maxTotalPatterns) {
                chosenPatterns.add(pattern);
            }
        });
        return patterns.filter(pattern => chosenPatterns.has(pattern));
    }

    function prioritizeVisiblePatterns(patterns) {
        const availableEntries = (patterns || [])
            .map((pattern, index) => ({ pattern, index }))
            .filter(entry => entry.pattern);
        const priorityOrder = [...availableEntries].sort(comparePatternVisibilityPriority);
        const visibleEntries = [];

        priorityOrder.forEach(entry => {
            if (visibleEntries.some(visibleEntry => (
                arePatternsRedundant(entry.pattern, visibleEntry.pattern)
            ))) {
                return;
            }
            visibleEntries.push(entry);
        });

        const visibleIndexes = new Set(visibleEntries.map(entry => entry.index));
        return availableEntries
            .filter(entry => visibleIndexes.has(entry.index))
            .map(entry => entry.pattern);
    }

    function selectVisiblePatterns(patterns, suppliedOptions = {}) {
        const requestedMaxPatterns = Math.round(Number(suppliedOptions.maxPatterns));
        const maxPatterns = clamp(
            Number.isFinite(requestedMaxPatterns)
                ? requestedMaxPatterns
                : DEFAULT_OPTIONS.maxPatterns,
            1,
            12
        );
        const requestedMinConfidence = Number(suppliedOptions.minConfidence);
        return selectPatterns(patterns || [], {
            ...DEFAULT_OPTIONS,
            ...suppliedOptions,
            minConfidence: Number.isFinite(requestedMinConfidence)
                ? requestedMinConfidence
                : 0,
            maxPatterns
        });
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
        const horizontalPatterns = groupHorizontalChannel(
            detectHorizontalPatterns(context, options),
            context
        );
        return selectPatterns([
            ...horizontalPatterns,
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
            if (candles[index - confirmations + 1].timeMs < (pattern.availableTimeMs || 0)) continue;
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

        const latest = candles[candles.length - 1];
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
                const availableTimeMs = pattern.availableTimeMs || pattern.formation.endTimeMs + getMedianIntervalMs(candles);
                const formation = candles.filter(candle => candle.timeMs < availableTimeMs);
                const referencePrice = formation[formation.length - 1]?.close || candles[0].close;
                const buffer = Math.max(getVolatility(formation) * 0.38, referencePrice * 0.0011);
                getPatternDirections(pattern).forEach(direction => {
                    const crossings = findConfirmedCrossings(pattern, candles, direction, buffer, options);
                    const crossing = crossings[crossings.length - 1];
                    if (!crossing) {
                        return;
                    }

                    const boundaryLine = direction === 'up' ? pattern.lines.upper : pattern.lines.lower;
                    const candlesAfterConfirmation = candles.slice(crossing.confirmIndex + 1);
                    const failedIndex = candles.findIndex((candle, index) => (
                        index >= crossing.confirmIndex + 2
                        && isBackInsidePattern(pattern, candle, direction, buffer)
                        && isBackInsidePattern(pattern, candles[index - 1], direction, buffer)
                    ));
                    const failed = failedIndex >= 0;
                    let retestIndex = -1;

                    if (!failed && candlesAfterConfirmation.length > 0 && isOutsidePattern(pattern, latest, direction, buffer)) {
                        candlesAfterConfirmation.forEach((candle, relativeIndex) => {
                            const boundary = lineValueAtTime(boundaryLine, candle.timeMs);
                            const touched = direction === 'up'
                                ? candle.low <= boundary + buffer && candle.close > boundary + buffer
                                : candle.high >= boundary - buffer && candle.close < boundary - buffer;
                            if (touched && retestIndex < 0) {
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
                        ? failedIndex
                        : (retestIndex >= 0 ? retestIndex : crossing.confirmIndex);
                    const eventTimeMs = candles[eventIndex].timeMs;
                    const eventClose = candles[eventIndex].close;
                    const eventBoundary = lineValueAtTime(boundaryLine, eventTimeMs);
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
                        close: eventClose,
                        boundary: eventBoundary,
                        distancePercent: Math.abs((eventClose - eventBoundary) / eventBoundary) * 100,
                        availableTimeMs: pattern.availableTimeMs,
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
            currentPatterns: patterns,
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

    function getScanWindowSegments(candles, options) {
        const windowSizes = getScanWindowSizes(candles, options);
        if (windowSizes.length === 1) {
            return [{
                windowSize: candles.length,
                startIndex: 0,
                endIndex: candles.length,
                isCurrent: true
            }];
        }

        return windowSizes
            .flatMap(windowSize => {
                if (windowSize >= candles.length) {
                    return [{
                        windowSize: candles.length,
                        startIndex: 0,
                        endIndex: candles.length,
                        isCurrent: true
                    }];
                }

                const step = Math.max(1, Math.floor(windowSize * ROLLING_SCAN_STEP_RATIO));
                const endIndexes = [];
                for (let endIndex = windowSize; endIndex < candles.length; endIndex += step) {
                    endIndexes.push(endIndex);
                }
                endIndexes.push(candles.length);
                return [...new Set(endIndexes)].map(endIndex => ({
                    windowSize,
                    startIndex: endIndex - windowSize,
                    endIndex,
                    isCurrent: endIndex === candles.length
                }));
            })
            .sort((left, right) => (
                left.endIndex - right.endIndex
                || left.windowSize - right.windowSize
                || left.startIndex - right.startIndex
            ));
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

        const windowSegments = getScanWindowSegments(candles, options);
        if (windowSegments.length === 1) {
            return scanMarketWindow(candles, options);
        }

        const windowResults = windowSegments.map(segment => {
            const segmentCandles = candles.slice(segment.startIndex, segment.endIndex);
            const result = scanMarketWindow(segmentCandles, options);
            const scanStartTimeMs = segmentCandles[0]?.timeMs ?? null;
            const scanEndTimeMs = segmentCandles[segmentCandles.length - 1]?.timeMs ?? null;
            return {
                ...segment,
                result,
                patterns: result.patterns.map(pattern => ({
                    ...pattern,
                    scanWindowCandles: segment.windowSize,
                    scanStartIndex: segment.startIndex,
                    scanEndIndex: segment.endIndex,
                    scanIsCurrent: segment.isCurrent,
                    scanStartTimeMs,
                    scanEndTimeMs
                })),
                events: result.events.map(event => ({
                    ...event,
                    scanWindowCandles: segment.windowSize,
                    scanStartTimeMs,
                    scanEndTimeMs
                }))
            };
        });
        const selectionOptions = {
            ...options,
            displayStartTimeMs: candles[0]?.timeMs,
            displayEndTimeMs: candles[candles.length - 1]?.timeMs
        };
        const persistentPatterns = consolidatePersistentPatternEpisodes(
            windowResults.flatMap(windowResult => windowResult.patterns),
            selectionOptions
        );
        const patterns = selectPatterns(
            persistentPatterns,
            selectionOptions
        );
        const events = windowResults
            .filter(windowResult => windowResult.isCurrent)
            .flatMap(windowResult => windowResult.events)
            .sort(compareSignificantEvents)
            .filter((event, index, all) => (
                all.findIndex(item => item.fingerprint === event.fingerprint) === index
            ));
        const fullWindowResult = windowResults.find(windowResult => (
            windowResult.windowSize === candles.length
            && windowResult.startIndex === 0
            && windowResult.endIndex === candles.length
        ));
        const windowSizes = getScanWindowSizes(candles, options);

        return {
            candles,
            patterns,
            currentPatterns: windowResults.filter(window => window.isCurrent)
                .flatMap(window => window.result.currentPatterns),
            events,
            diagnostics: {
                ...fullWindowResult.result.diagnostics,
                windowsScanned: windowSizes,
                segmentsScanned: windowSegments.length,
                persistentEpisodes: persistentPatterns.length
            }
        };
    }

    function scanTentativePatterns(data, suppliedOptions = {}) {
        const confirmedMinConfidenceValue = Number(suppliedOptions.confirmedMinConfidence);
        const confirmedMinConfidence = clamp(
            Number.isFinite(confirmedMinConfidenceValue)
                ? confirmedMinConfidenceValue
                : DEFAULT_TENTATIVE_OPTIONS.confirmedMinConfidence,
            0.01,
            0.99
        );
        const tentativeMinConfidenceValue = Number(suppliedOptions.tentativeMinConfidence);
        const tentativeMinConfidence = clamp(
            Number.isFinite(tentativeMinConfidenceValue)
                ? tentativeMinConfidenceValue
                : DEFAULT_TENTATIVE_OPTIONS.minConfidence,
            0,
            Math.max(0, confirmedMinConfidence - 0.01)
        );
        const maxPatternsValue = Number(suppliedOptions.maxTentativePatterns);
        const maxPatterns = clamp(
            Number.isFinite(maxPatternsValue)
                ? Math.round(maxPatternsValue)
                : DEFAULT_TENTATIVE_OPTIONS.maxPatterns,
            0,
            4
        );
        if (maxPatterns === 0 || tentativeMinConfidence >= confirmedMinConfidence) {
            return [];
        }

        const {
            confirmedMinConfidence: ignoredConfirmedMinConfidence,
            tentativeMinConfidence: ignoredTentativeMinConfidence,
            maxTentativePatterns: ignoredMaxTentativePatterns,
            ...scanOptions
        } = suppliedOptions;
        const candidateResult = scanMarket(data, {
            ...scanOptions,
            minConfidence: tentativeMinConfidence,
            maxPatterns: Math.max(DEFAULT_OPTIONS.maxPatterns + maxPatterns, Number(scanOptions.maxPatterns) || 0),
            eventConfidence: 1
        });

        const tentativeCandidates = candidateResult.patterns
            .filter(pattern => (
                pattern.confidence >= tentativeMinConfidence
                && pattern.confidence < confirmedMinConfidence
            ));
        return selectPatterns(tentativeCandidates, {
            ...DEFAULT_OPTIONS,
            ...scanOptions,
            minConfidence: tentativeMinConfidence,
            maxPatterns
        })
            .map(pattern => ({
                ...pattern,
                id: pattern.id.replace(/^autoscan-/, 'autoscan-tentative-'),
                source: 'autoscan-tentative',
                tentative: true,
                confidenceBand: 'tentative',
                locked: true
            }));
    }

    function buildMarketContext(data, scanResult, options = {}) {
        const candles = normalizeCandles(data);
        const latest = candles[candles.length - 1];
        if (candles.length < DEFAULT_OPTIONS.minCandles) return null;
        const price = Number.isFinite(Number(options.price)) && Number(options.price) > 0 ? Number(options.price) : latest.close;
        const intervalMs = getMedianIntervalMs(candles);
        const volatility = getVolatility(candles);
        const tolerance = Math.max(volatility * 0.45, price * 0.0016);
        const pivots = detectPivots(candles.slice(-160));
        const zones = [{ side: 'support', pivots: pivots.lows }, { side: 'resistance', pivots: pivots.highs }]
            .flatMap(definition => clusterPivots(definition.pivots, tolerance).map(cluster => {
                const values = cluster.pivots.map(pivot => pivot.value);
                const lastTestTimeMs = Math.max(...cluster.pivots.map(pivot => pivot.timeMs));
                const halfWidth = Math.max(Math.max(...values) - cluster.level, cluster.level - Math.min(...values), tolerance * 0.35);
                return {
                    level: cluster.level,
                    low: cluster.level - halfWidth,
                    high: cluster.level + halfWidth,
                    touches: new Set(cluster.pivots.map(pivot => pivot.timeMs)).size,
                    startTimeMs: Math.min(...cluster.pivots.map(pivot => pivot.timeMs)),
                    lastTestTimeMs,
                    distancePercent: (cluster.level - price) / price * 100,
                    side: definition.side
                };
            }))
            .filter(zone => zone.touches >= 2 && latest.timeMs - zone.lastTestTimeMs <= intervalMs * 60)
            .filter(zone => zone.side === 'support' ? zone.level <= price : zone.level >= price)
            .sort((left, right) => Math.abs(left.distancePercent) - Math.abs(right.distancePercent));
        const nearestZones = ['support', 'resistance'].map(side => zones.find(zone => zone.side === side)).filter(Boolean);
        const candidates = (scanResult?.currentPatterns || scanResult?.patterns || [])
            .filter(pattern => ['trend', 'channel'].includes(pattern.type)
                && !isTentativePattern(pattern) && pattern.scanIsCurrent !== false
                && latest.timeMs - pattern.formation.endTimeMs <= intervalMs * 24)
            .filter(pattern => {
                const boundaries = Object.values(pattern.lines).map(line => lineValueAtTime(line, latest.timeMs));
                const nearPrice = Math.min(...boundaries) - volatility * 3 <= price
                    && Math.max(...boundaries) + volatility * 3 >= price;
                return nearPrice && !getPatternDirections(pattern).some(direction => (
                    candles.slice(-2).every(candle => isOutsidePattern(pattern, candle, direction, tolerance))
                ));
            })
            .sort((left, right) => right.formation.endTimeMs - left.formation.endTimeMs
                || right.confidence - left.confidence);
        const activePattern = candidates[0] || null;
        const highs = pivots.highs.slice(-2);
        const lows = pivots.lows.slice(-2);
        let trend = 'mixed';
        if (highs.length === 2 && lows.length === 2) {
            if (highs[1].value > highs[0].value + tolerance && lows[1].value > lows[0].value + tolerance) trend = 'rising';
            else if (highs[1].value < highs[0].value - tolerance && lows[1].value < lows[0].value - tolerance) trend = 'falling';
            else if (Math.abs(highs[1].value - highs[0].value) <= tolerance
                && Math.abs(lows[1].value - lows[0].value) <= tolerance) trend = 'ranging';
        }
        if (activePattern?.variant === 'horizontal-channel') trend = 'ranging';
        const events = [...(scanResult?.events || [])]
            .filter(event => event.eventTimeMs <= latest.timeMs && latest.timeMs - event.eventTimeMs <= intervalMs * 12)
            .sort((left, right) => right.eventTimeMs - left.eventTimeMs || right.priority - left.priority)
            .filter((event, index, all) => !all.slice(0, index).some(previous => (
                previous.kind === event.kind && previous.direction === event.direction
                && Math.abs(previous.eventTimeMs - event.eventTimeMs) <= intervalMs * 2
            ))).slice(0, 3);
        return { price, trend, zones: nearestZones, activePattern, events,
            intervalMs, asOfTimeMs: latest.timeMs + intervalMs };
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
        aggregateClosedCandles,
        buildMarketContext,
        detectPivots,
        detectSignificantEvents,
        formatEventCommentary,
        getPatternLabel,
        lineValueAtTime,
        normalizeCandles,
        prioritizeVisiblePatterns,
        scanMarket,
        scanPatterns,
        scanTentativePatterns,
        selectVisiblePatterns
    });
}));
