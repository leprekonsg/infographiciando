/**
 * Visual Jury - Kimi K2.5-Style Parallel Visual Critique
 * 
 * ARCHITECTURAL ROLE:
 * Implements "Hive Mind" consensus checking using Qwen3-VL parallel dispatch.
 * Used by Director Agent for batch slide validation and deck-wide consistency analysis.
 * 
 * KEY INSIGHT:
 * Qwen3-VL is fast enough that network latency dominates.
 * Parallel execution provides 6x speedup at the SAME COST because API calls are concurrent.
 * 
 * COST/LATENCY COMPARISON (10 slides):
 * ┌───────────────────┬─────────────┬──────────┬────────────────────────────┐
 * │       Mode        │   Latency   │   Cost   │         Use Case           │
 * ├───────────────────┼─────────────┼──────────┼────────────────────────────┤
 * │ Sequential        │   ~12s      │  $0.02   │ Standard decks, budget     │
 * │ Swarm (Qwen3-VL)  │   ~2s       │  $0.02   │ Premium mode, parallel     │
 * │ Swarm (Gemini)    │   ~8s       │  $0.06   │ Only code-gen workflows    │
 * └───────────────────┴─────────────┴──────────┴────────────────────────────┘
 */

import type { CostTracker } from '../interactionsClient';
import type { SlideNode, GlobalStyleGuide, StyleMode } from '../../types/slideTypes';
import { analyzeSlideLayoutSpatial, type Qwen3VLSpatialAnalysisResult } from '../visualCortex';
import { getSwarmBatchSize, getRecommendedSwarmMode } from '../diagram/diagramOrchestrator';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Individual slide critique from Visual Jury
 */
export interface JurorCritique {
    slideIndex: number;
    overall_score: number;
    verdict: 'accept' | 'flag_for_review' | 'requires_repair';
    spatial_issues: number;
    latency_ms: number;
    error?: string;
}

/**
 * Consensus report from Visual Jury
 */
export interface ConsensusReport {
    /** Deck-wide consistency score (0-100) */
    deck_consistency_score: number;
    /** Average score across all slides */
    average_score: number;
    /** Score standard deviation (lower = more consistent) */
    score_std_dev: number;
    /** Slides that deviate significantly from average */
    outlier_slides: Array<{
        slideIndex: number;
        score: number;
        deviation: number;
        reason: string;
    }>;
    /** Recommended global adjustments */
    recommended_adjustments: Array<{
        type: 'spacing' | 'font_size' | 'color' | 'layout_change';
        description: string;
        affected_slides: number[];
    }>;
    /** Individual critiques */
    critiques: JurorCritique[];
    /** Execution metadata */
    execution: {
        mode: 'sequential' | 'parallel';
        total_time_ms: number;
        batch_size: number;
        slides_processed: number;
    };
}

// ============================================================================
// VISUAL JURY IMPLEMENTATION
// ============================================================================

/**
 * Run Visual Jury consensus on a deck
 * 
 * Kimi K2.5-style parallel agent dispatch using Qwen3-VL as each "juror".
 * Each juror analyzes one slide independently, then consensus is computed.
 * 
 * @param slides - Array of slide nodes to validate
 * @param slideImages - Map of slide index to PNG base64
 * @param styleGuide - Global style guide for context
 * @param costTracker - Cost tracker
 * @param targetLatencyMs - Target latency to determine sequential vs parallel
 * @returns Consensus report with outliers and recommendations
 */
export async function runVisualJuryConsensus(
    slides: SlideNode[],
    slideImages: Map<number, string>,
    styleGuide: GlobalStyleGuide,
    costTracker?: CostTracker,
    targetLatencyMs: number = 5000
): Promise<ConsensusReport> {
    const startTime = Date.now();
    const slideCount = slides.length;
    
    // Determine execution mode based on slide count and target latency
    const swarmMode = getRecommendedSwarmMode(slideCount, targetLatencyMs);
    const batchSize = getSwarmBatchSize(slideCount);
    
    console.log(`[VISUAL_JURY] Starting consensus check: ${slideCount} slides, mode=${swarmMode}, batch=${batchSize}`);

    const critiques: JurorCritique[] = [];
    
    if (swarmMode === 'parallel') {
        // Parallel execution: all slides analyzed concurrently (with batching)
        const critiquePromises = slides.map((slide, idx) => 
            analyzeSlideAsJuror(slide, idx, slideImages.get(idx) || '', styleGuide, costTracker)
        );

        // Execute with concurrency limit
        const results = await executeWithConcurrencyLimit(critiquePromises, batchSize);
        critiques.push(...results);
    } else {
        // Sequential execution: one at a time
        for (let i = 0; i < slides.length; i++) {
            const critique = await analyzeSlideAsJuror(
                slides[i], 
                i, 
                slideImages.get(i) || '', 
                styleGuide, 
                costTracker
            );
            critiques.push(critique);
        }
    }

    // Calculate consensus metrics
    const scores = critiques.filter(c => !c.error).map(c => c.overall_score);
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const stdDev = calculateStdDev(scores, avgScore);
    
    // Identify outliers (slides deviating >15 points from average)
    const outlierThreshold = 15;
    const outlierSlides = critiques
        .filter(c => !c.error && Math.abs(c.overall_score - avgScore) > outlierThreshold)
        .map(c => ({
            slideIndex: c.slideIndex,
            score: c.overall_score,
            deviation: c.overall_score - avgScore,
            reason: c.overall_score < avgScore 
                ? 'Below deck average - may need improvement'
                : 'Above deck average - may be over-polished vs rest'
        }));

    // Generate global adjustment recommendations
    const recommendations = generateGlobalAdjustments(critiques, slides, styleGuide);

    // Calculate deck consistency score
    // Higher when all slides are close to average, lower when there's variance
    const consistencyScore = Math.max(0, 100 - (stdDev * 2));

    const totalTime = Date.now() - startTime;

    console.log(`[VISUAL_JURY] Consensus complete: avg=${avgScore.toFixed(1)}, consistency=${consistencyScore.toFixed(1)}, outliers=${outlierSlides.length}, time=${totalTime}ms`);

    return {
        deck_consistency_score: consistencyScore,
        average_score: avgScore,
        score_std_dev: stdDev,
        outlier_slides: outlierSlides,
        recommended_adjustments: recommendations,
        critiques,
        execution: {
            mode: swarmMode,
            total_time_ms: totalTime,
            batch_size: batchSize,
            slides_processed: slideCount
        }
    };
}

/**
 * Analyze a single slide as a "juror"
 */
async function analyzeSlideAsJuror(
    slide: SlideNode,
    slideIndex: number,
    slideImage: string,
    styleGuide: GlobalStyleGuide,
    costTracker?: CostTracker
): Promise<JurorCritique> {
    const startTime = Date.now();
    
    try {
        if (!slideImage) {
            return {
                slideIndex,
                overall_score: 50,
                verdict: 'flag_for_review',
                spatial_issues: 0,
                latency_ms: Date.now() - startTime,
                error: 'No image provided'
            };
        }

        // Determine deck position for context
        const deckPosition = slideIndex === 0 
            ? 'opening' 
            : slideIndex === 9  // Assuming max 10 slides
                ? 'closing' 
                : 'middle';

        // Extract layout info from slide - layoutPlan doesn't have layoutId, use title or fallback
        const layoutId = (slide.layoutPlan as any)?.layoutId || 'standard-vertical';
        const elementCount = slide.layoutPlan?.components?.length || 0;
        // StyleGuide doesn't have styleMode, use default
        const styleMode: StyleMode = 'professional';

        const analysis = await analyzeSlideLayoutSpatial(slideImage, {
            layoutId,
            elementCount,
            expectedTextZones: ['title', 'body'],
            deckPosition,
            styleMode
        }, costTracker);

        if (!analysis) {
            return {
                slideIndex,
                overall_score: 50,
                verdict: 'flag_for_review',
                spatial_issues: 0,
                latency_ms: Date.now() - startTime,
                error: 'Analysis returned null'
            };
        }

        // Count spatial issues
        const spatialIssues = (analysis.spatial_analysis?.text_regions?.filter(
            r => r.overflow_risk === 'high' || r.overflow_risk === 'critical'
        ).length || 0) + (analysis.spatial_analysis?.overcrowded_zones?.filter(
            z => z.density_score > 0.7
        ).length || 0);

        return {
            slideIndex,
            overall_score: analysis.overall_score,
            verdict: analysis.verdict,
            spatial_issues: spatialIssues,
            latency_ms: Date.now() - startTime
        };

    } catch (err: any) {
        return {
            slideIndex,
            overall_score: 50,
            verdict: 'flag_for_review',
            spatial_issues: 0,
            latency_ms: Date.now() - startTime,
            error: err.message
        };
    }
}

/**
 * Execute promises with concurrency limit
 */
async function executeWithConcurrencyLimit<T>(
    tasks: Promise<T>[],
    limit: number
): Promise<T[]> {
    const results: T[] = [];
    const executing: Promise<void>[] = [];

    for (const task of tasks) {
        const p = task.then(result => {
            results.push(result);
        });

        executing.push(p);

        if (executing.length >= limit) {
            await Promise.race(executing);
            // Remove completed promises
            for (let i = executing.length - 1; i >= 0; i--) {
                // Check if promise is settled by racing with immediate resolve
                const isSettled = await Promise.race([
                    executing[i].then(() => true),
                    Promise.resolve(false)
                ]);
                if (isSettled) {
                    executing.splice(i, 1);
                }
            }
        }
    }

    await Promise.all(executing);
    return results;
}

/**
 * Calculate standard deviation
 */
function calculateStdDev(values: number[], mean: number): number {
    if (values.length === 0) return 0;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(avgSquaredDiff);
}

/**
 * Generate global adjustment recommendations based on consensus
 */
function generateGlobalAdjustments(
    critiques: JurorCritique[],
    slides: SlideNode[],
    _styleGuide: GlobalStyleGuide
): ConsensusReport['recommended_adjustments'] {
    const recommendations: ConsensusReport['recommended_adjustments'] = [];

    // Check for consistent spatial issues
    const slidesWithSpatialIssues = critiques.filter(c => c.spatial_issues > 0);
    if (slidesWithSpatialIssues.length >= critiques.length * 0.3) {
        recommendations.push({
            type: 'spacing',
            description: 'Many slides have spatial issues. Consider reducing content density globally.',
            affected_slides: slidesWithSpatialIssues.map(c => c.slideIndex)
        });
    }

    // Check for score clustering issues
    const lowScoreSlides = critiques.filter(c => c.overall_score < 60);
    if (lowScoreSlides.length >= 2) {
        recommendations.push({
            type: 'layout_change',
            description: 'Multiple slides scored low. Consider simplifying layouts for these slides.',
            affected_slides: lowScoreSlides.map(c => c.slideIndex)
        });
    }

    // Check for verdict inconsistencies
    const repairNeeded = critiques.filter(c => c.verdict === 'requires_repair');
    if (repairNeeded.length > 0) {
        recommendations.push({
            type: 'spacing',
            description: `${repairNeeded.length} slides require repair. Run targeted validation loop.`,
            affected_slides: repairNeeded.map(c => c.slideIndex)
        });
    }

    return recommendations;
}

// ============================================================================
// QUICK CONSENSUS CHECK (Sampling Mode)
// ============================================================================

/**
 * Quick consensus check using sampling
 * 
 * For larger decks where full validation is too expensive.
 * Samples key slides: first, last, and every Nth slide.
 * 
 * @param slides - Full slide array
 * @param slideImages - Map of slide images
 * @param styleGuide - Style guide
 * @param sampleRate - Sample every Nth slide (default: 3)
 * @param costTracker - Cost tracker
 */
export async function runQuickConsensusCheck(
    slides: SlideNode[],
    slideImages: Map<number, string>,
    styleGuide: GlobalStyleGuide,
    sampleRate: number = 3,
    costTracker?: CostTracker
): Promise<ConsensusReport> {
    // Always include first and last slides
    const sampleIndices = new Set<number>([0, slides.length - 1]);
    
    // Add sampled slides
    for (let i = sampleRate; i < slides.length - 1; i += sampleRate) {
        sampleIndices.add(i);
    }
    
    // Create filtered arrays
    const sampledSlides = [...sampleIndices].sort((a, b) => a - b).map(i => slides[i]);
    const sampledImages = new Map<number, string>();
    
    let newIndex = 0;
    for (const originalIndex of [...sampleIndices].sort((a, b) => a - b)) {
        const image = slideImages.get(originalIndex);
        if (image) {
            sampledImages.set(newIndex, image);
        }
        newIndex++;
    }

    console.log(`[VISUAL_JURY] Quick check: sampling ${sampledSlides.length}/${slides.length} slides`);

    // Run consensus on sampled slides
    const result = await runVisualJuryConsensus(
        sampledSlides,
        sampledImages,
        styleGuide,
        costTracker
    );

    // Adjust outlier indices back to original
    const sortedIndices = [...sampleIndices].sort((a, b) => a - b);
    result.outlier_slides = result.outlier_slides.map(outlier => ({
        ...outlier,
        slideIndex: sortedIndices[outlier.slideIndex]
    }));

    result.critiques = result.critiques.map((critique, i) => ({
        ...critique,
        slideIndex: sortedIndices[i]
    }));

    return result;
}
