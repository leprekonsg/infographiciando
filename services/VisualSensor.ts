/**
 * Visual Sensor - Three-Tier Visual Validation Stack
 * 
 * ARCHITECTURE (2026-01 Revision):
 * Qwen3-VL-Plus is the PRIMARY visual cortex (state-of-the-art leader in spatial understanding).
 * Gemini 3.0 is reserved for code-execution workflows only.
 * 
 * THREE-TIER STACK:
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │                    TIER 1: LOGIC GATE (Deterministic)                       │
 * │  • quickFitCheck (character counting, layout heuristics)                   │
 * │  • Latency: <1ms | Cost: $0 | Coverage: 100% of slides                     │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │                    TIER 2: QWEN3-VL VISUAL GATE (Spatial)                   │
 * │  • Model: qwen3-vl-plus-2025-12-19                                         │
 * │  • Task: Bounding box detection, overflow verification, OCR                │
 * │  • Latency: ~800ms-1.5s | Cost: ~$0.002/image                              │
 * │  • Coverage: High-risk layouts (100%), Medium-risk (30% sampling)          │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │                    TIER 3: GEMINI 3.0 AGENTIC (Code Execution)              │
 * │  • Reserved for "Graph Drone" custom viz (serendipitous mode only)         │
 * │  • Latency: 3-8s | Cost: ~$0.005                                           │
 * └─────────────────────────────────────────────────────────────────────────────┘
 */

import type { BrowserMetrics } from './BrowserRenderer';
import type { CostTracker } from './interactionsClient';
import type { StyleMode } from '../types/slideTypes';
import { 
    selectVisualValidationEngine, 
    getLayoutRiskLevel,
    type VisualValidationEngine 
} from './diagram/diagramOrchestrator';

// ============================================================================
// VISUAL SENSOR RESULT TYPES
// ============================================================================

export interface VisualSensorResult {
    isOvercrowded: boolean;
    suggestedAction: 'reduce_text' | 'change_layout' | 'increase_buffer' | 'pass';
    clippingDetected: boolean;
    confidence: 'high' | 'medium' | 'low';
    details?: string;
    /** Engine used for validation (tier tracking) */
    engine?: VisualValidationEngine;
}

/**
 * Qwen3-VL Spatial Analysis Result (Tier 2)
 * Native 0-1000 coordinate system for precise bounding box detection
 */
export interface Qwen3VLSpatialResult {
    overall_score: number;           // 0-100 aesthetic evaluation
    spatial_analysis: {
        text_regions: Array<{
            text: string;
            bbox: [number, number, number, number]; // [x0, y0, x1, y1] normalized 0-1
            font_size?: number;
            overflow_risk: 'none' | 'low' | 'high' | 'critical';
        }>;
        overcrowded_zones: Array<{
            region: 'title' | 'body' | 'footer';
            density_score: number;       // elements per 1000px²
            recommendation: string;
        }>;
    };
    repair_actions: Array<{
        target: string;                // Component ID or "title"
        action: 'resize' | 'reposition' | 'reflow' | 'reduce_font';
        parameters: Record<string, number>;
        confidence: number;            // 0-1
    }>;
    verdict: 'accept' | 'flag_for_review' | 'requires_repair';
    latency_ms?: number;
}

/**
 * Visual Gate Failure Codes for structured logging
 */
export type VisualGateFailureCode = 
    | 'TITLE_OVERFLOW'         // Title text exceeds zone width
    | 'BODY_WRAP_EXCEEDED'     // Body text wraps beyond acceptable lines
    | 'BULLET_TOO_LONG'        // Individual bullet exceeds char limit
    | 'TOTAL_CHARS_OVERFLOW'   // Total content chars exceed layout limit
    | 'ELEMENT_DENSITY_HIGH'   // Too many visual elements in zone
    | 'VISUAL_FIT_FAILED'      // Generic quickFitCheck failure
    | 'QWEN3VL_SPATIAL_FAIL';  // Qwen3-VL detected spatial issue

export interface VisualGateFailure {
    code: VisualGateFailureCode;
    slideIndex: number;
    layoutId: string;
    details: string;
    action: 'prune' | 'summarize' | 'change_layout';
    confidence: number;  // 0-1
}

/**
 * Extended validation result with Qwen3-VL metadata
 */
export interface VisualValidationResult {
    fits: boolean;
    failures: VisualGateFailure[];
    action: 'prune' | 'summarize' | 'change_layout' | 'pass';
    engine: VisualValidationEngine;
    qwen3vl_metadata?: {
        overall_score: number;
        processing_time: number;
        spatial_analysis?: Qwen3VLSpatialResult['spatial_analysis'];
    };
}

/**
 * Sense layout health using DOM metrics (fast path)
 * Director can call this during drafting to catch issues early
 */
export function senseLayoutHealthFromMetrics(
    metrics: BrowserMetrics
): VisualSensorResult {
    // Check for any overflow detected by browser
    if (metrics.textOverflow) {
        const worstOverflow = metrics.overflowDetails
            .sort((a, b) => b.overflowAmount - a.overflowAmount)[0];

        const suggestedAction = worstOverflow?.overflowAmount > 50
            ? 'change_layout' as const
            : 'reduce_text' as const;

        return {
            isOvercrowded: true,
            suggestedAction,
            clippingDetected: true,
            confidence: 'high',
            details: `Overflow detected: ${metrics.overflowDetails.length} zones affected, worst: ${worstOverflow?.overflowAmount}px`
        };
    }

    // Check element density
    const elementCount = metrics.elements.size;
    if (elementCount > 12) {
        return {
            isOvercrowded: true,
            suggestedAction: 'reduce_text',
            clippingDetected: false,
            confidence: 'medium',
            details: `High element density: ${elementCount} elements`
        };
    }

    return {
        isOvercrowded: false,
        suggestedAction: 'pass',
        clippingDetected: false,
        confidence: 'high'
    };
}

/**
 * Enhanced sense with Qwen-VL visual check (slow path)
 * Only call when DOM check passes but want semantic validation
 */
export async function senseLayoutHealthWithVision(
    screenshotBase64: string,
    domMetrics: BrowserMetrics,
    costTracker: CostTracker
): Promise<VisualSensorResult> {
    // First: Run cheap physics check
    const domResult = senseLayoutHealthFromMetrics(domMetrics);
    if (domResult.clippingDetected) {
        // Physics check failed, no need for expensive vision check
        return domResult;
    }

    // Second: If physics pass, optionally check with Qwen-VL
    try {
        const { isQwenVLAvailable, getVisualCritiqueFromImage } = await import('./visualCortex');

        if (!isQwenVLAvailable()) {
            // Qwen-VL not available, trust DOM check
            return domResult;
        }

        // Call Qwen-VL for semantic check (1920x1080 standard slide dimensions)
        const critique = await getVisualCritiqueFromImage(screenshotBase64, 1920, 1080, costTracker);

        if (!critique) {
            return domResult;
        }

        // Map Qwen verdict to action
        if (critique.overall_verdict === 'requires_repair') {
            const hasCrowding = critique.issues.some(
                (i: any) => i.category === 'density' || i.category === 'spacing'
            );

            return {
                isOvercrowded: hasCrowding,
                suggestedAction: hasCrowding ? 'reduce_text' : 'change_layout',
                clippingDetected: critique.issues.some((i: any) => i.category === 'text_overlap'),
                confidence: 'high',
                details: `Qwen-VL score: ${critique.overall_score}, issues: ${critique.issues.length}`
            };
        }

        // Qwen says it's fine
        return {
            isOvercrowded: false,
            suggestedAction: 'pass',
            clippingDetected: false,
            confidence: 'high',
            details: `Qwen-VL approved: score ${critique.overall_score}`
        };

    } catch (err: any) {
        console.warn('[VISUAL_SENSOR] Qwen-VL check failed:', err.message);
        // Fall back to DOM result
        return domResult;
    }
}

/**
 * Quick check if layout likely fits without full render
 * Uses character limits and heuristics
 */
export function quickFitCheck(
    textContent: string[],
    layoutId: string,
    maxCharsPerBullet: number = 60
): { fits: boolean; reason?: string } {
    const totalChars = textContent.reduce((sum, t) => sum + t.length, 0);
    const bulletCount = textContent.length;

    // Deny obvious overflows
    const longBullets = textContent.filter(t => t.length > maxCharsPerBullet);
    if (longBullets.length > 0) {
        return {
            fits: false,
            reason: `${longBullets.length} bullets exceed ${maxCharsPerBullet} char limit`
        };
    }

    // Layout-specific limits
    const layoutLimits: Record<string, { maxBullets: number; maxTotalChars: number }> = {
        'hero-centered': { maxBullets: 2, maxTotalChars: 150 },
        'bento-grid': { maxBullets: 3, maxTotalChars: 200 },
        'dashboard-tiles': { maxBullets: 3, maxTotalChars: 180 },
        'split-left-text': { maxBullets: 4, maxTotalChars: 280 },
        'split-right-text': { maxBullets: 4, maxTotalChars: 280 },
        'standard-vertical': { maxBullets: 5, maxTotalChars: 400 }
    };

    const limits = layoutLimits[layoutId] || layoutLimits['standard-vertical'];

    if (bulletCount > limits.maxBullets) {
        return { fits: false, reason: `${bulletCount} bullets exceed limit of ${limits.maxBullets}` };
    }

    if (totalChars > limits.maxTotalChars) {
        return { fits: false, reason: `${totalChars} chars exceed limit of ${limits.maxTotalChars}` };
    }

    return { fits: true };
}

// ============================================================================
// TIER 2: QWEN3-VL VISUAL GATE (Primary Visual Cortex)
// ============================================================================

/**
 * Layout quality profile for content validation
 */
export interface LayoutQualityProfile {
    minBullets: number;
    maxBullets: number;
    minTotalChars: number;
    maxTotalChars: number;
    minCharsPerPoint: number;
    maxCharsPerPoint: number;
    allowEmpty: boolean;
}

/**
 * Content plan interface for validation
 */
export interface ContentPlanForValidation {
    keyPoints?: string[];
    title?: string;
    components?: Array<{ type: string }>;
}

/**
 * Run Qwen3-VL Visual Gate for spatial analysis
 * 
 * TIER 2 in the Three-Tier Visual Validation Stack.
 * Uses Qwen3-VL-Plus for:
 * - Bounding box detection with 0-1000 normalized coordinates
 * - Overflow verification via OCR
 * - Spatial issue identification
 * - Aesthetic scoring
 * 
 * @param slideImage - PNG image base64
 * @param layoutId - Layout template ID
 * @param contentPlan - Content plan for context
 * @param profile - Layout quality profile
 * @param slideIndex - Current slide index
 * @param costTracker - Cost tracker
 * @returns Visual validation result with structured failures
 */
export async function runVisualGateQwen3VL(
    slideImage: string,
    layoutId: string,
    contentPlan: ContentPlanForValidation,
    profile: LayoutQualityProfile,
    slideIndex: number,
    costTracker?: CostTracker
): Promise<VisualValidationResult> {
    const startTime = Date.now();
    
    // Skip for low-risk layouts (unchanged logic)
    const riskLevel = getLayoutRiskLevel(layoutId);
    if (riskLevel === 'low') {
        return { 
            fits: true, 
            failures: [],
            action: 'pass', 
            engine: 'logic-gate'
        };
    }

    console.log(`[VISUAL_SENSOR] Tier 2 Qwen3-VL analysis for slide ${slideIndex} (layout: ${layoutId})`);

    try {
        const { isQwenVLAvailable, analyzeSlideLayoutSpatial } = await import('./visualCortex');

        if (!isQwenVLAvailable()) {
            console.warn('[VISUAL_SENSOR] Qwen3-VL not available, falling back to logic gate');
            return { 
                fits: true, 
                failures: [],
                action: 'pass', 
                engine: 'logic-gate'
            };
        }

        // Call Qwen3-VL for spatial analysis
        const analysis = await analyzeSlideLayoutSpatial(slideImage, {
            layoutId,
            elementCount: contentPlan.components?.length || 0,
            expectedTextZones: ['title', 'body', 'metrics']
        }, costTracker);

        if (!analysis) {
            return { 
                fits: true, 
                failures: [],
                action: 'pass', 
                engine: 'logic-gate'
            };
        }

        // Parse structured failure codes from Qwen3-VL response
        const failures: VisualGateFailure[] = [];
        
        // Check text regions for overflow
        analysis.spatial_analysis?.text_regions?.forEach(region => {
            if (region.overflow_risk === 'critical' || region.overflow_risk === 'high') {
                const isTitle = region.bbox[1] < 0.2;  // Top 20% is likely title
                failures.push({
                    code: isTitle ? 'TITLE_OVERFLOW' : 'BODY_WRAP_EXCEEDED',
                    slideIndex,
                    layoutId,
                    details: `Text "${region.text.substring(0, 20)}..." at [${region.bbox.map(n => n.toFixed(2)).join(',')}] has ${region.overflow_risk} overflow risk`,
                    action: isTitle ? 'summarize' : 'prune',
                    confidence: region.overflow_risk === 'critical' ? 0.95 : 0.8
                });
            }
        });

        // Check overcrowded zones
        analysis.spatial_analysis?.overcrowded_zones?.forEach(zone => {
            if (zone.density_score > 0.7) {  // High density threshold
                failures.push({
                    code: 'ELEMENT_DENSITY_HIGH',
                    slideIndex,
                    layoutId,
                    details: `${zone.region} zone has density score ${zone.density_score.toFixed(2)}: ${zone.recommendation}`,
                    action: 'prune',
                    confidence: Math.min(zone.density_score, 0.95)
                });
            }
        });

        const processingTime = Date.now() - startTime;
        
        // Determine action based on failures
        let action: 'prune' | 'summarize' | 'change_layout' | 'pass' = 'pass';
        if (failures.length > 0) {
            // Prioritize actions: change_layout > prune > summarize
            const needsLayoutChange = failures.some(f => f.code === 'ELEMENT_DENSITY_HIGH' && f.confidence > 0.9);
            const needsPrune = failures.some(f => f.action === 'prune');
            
            if (needsLayoutChange) {
                action = 'change_layout';
            } else if (needsPrune) {
                action = 'prune';
            } else {
                action = 'summarize';
            }
        }

        console.log(`[VISUAL_SENSOR] Tier 2 complete: score=${analysis.overall_score}, failures=${failures.length}, action=${action}, time=${processingTime}ms`);

        return {
            fits: failures.length === 0,
            failures,
            action,
            engine: 'qwen3vl-spatial',
            qwen3vl_metadata: {
                overall_score: analysis.overall_score,
                processing_time: processingTime,
                spatial_analysis: analysis.spatial_analysis
            }
        };

    } catch (err: any) {
        console.warn(`[VISUAL_SENSOR] Qwen3-VL analysis failed: ${err.message}`);
        // Graceful fallback to logic gate
        return { 
            fits: true, 
            failures: [],
            action: 'pass', 
            engine: 'logic-gate'
        };
    }
}

// ============================================================================
// THREE-TIER ORCHESTRATED VALIDATION
// ============================================================================

/**
 * Run the complete three-tier visual validation pipeline
 * 
 * Orchestrates:
 * - Tier 1: Logic Gate (always runs, <1ms)
 * - Tier 2: Qwen3-VL Spatial (risk-based sampling)
 * - Tier 3: Gemini Code (reserved for custom viz)
 * 
 * @param slideImage - PNG image base64 (for Tier 2)
 * @param textContent - Text content array (for Tier 1)
 * @param layoutId - Layout template ID
 * @param slideIndex - Current slide index
 * @param totalSlides - Total slides in deck
 * @param slideTitle - Slide title
 * @param styleMode - Style mode for threshold adjustments
 * @param costTracker - Cost tracker
 * @returns Comprehensive validation result
 */
export async function runThreeTierValidation(
    slideImage: string | null,
    textContent: string[],
    layoutId: string,
    slideIndex: number,
    totalSlides: number,
    slideTitle: string,
    styleMode: StyleMode,
    costTracker?: CostTracker
): Promise<VisualValidationResult> {
    const failures: VisualGateFailure[] = [];
    
    // =========================================================================
    // TIER 1: LOGIC GATE (Always runs, <1ms, $0)
    // =========================================================================
    console.log(`[VISUAL_SENSOR] Tier 1: Logic Gate check for slide ${slideIndex}`);
    
    const tier1Result = quickFitCheck(textContent, layoutId);
    
    if (!tier1Result.fits) {
        // Parse failure reason to determine code
        const reason = tier1Result.reason || '';
        let code: VisualGateFailureCode = 'VISUAL_FIT_FAILED';
        let action: 'prune' | 'summarize' | 'change_layout' = 'summarize';
        
        if (reason.includes('bullets exceed') || reason.includes('bullet')) {
            code = 'BULLET_TOO_LONG';
            action = 'summarize';
        } else if (reason.includes('chars exceed') || reason.includes('total')) {
            code = 'TOTAL_CHARS_OVERFLOW';
            action = 'prune';
        }
        
        failures.push({
            code,
            slideIndex,
            layoutId,
            details: reason,
            action,
            confidence: 0.9  // Logic gate is high confidence
        });
        
        console.log(`[VISUAL_SENSOR] Tier 1 FAILED: ${code} - ${reason}`);
        
        // Return early if Tier 1 fails - no need for expensive Tier 2
        return {
            fits: false,
            failures,
            action,
            engine: 'logic-gate'
        };
    }
    
    console.log(`[VISUAL_SENSOR] Tier 1 PASSED`);

    // =========================================================================
    // TIER 2: QWEN3-VL SPATIAL (Risk-based sampling)
    // =========================================================================
    const engine = selectVisualValidationEngine(
        layoutId,
        styleMode,
        slideIndex,
        totalSlides,
        slideTitle.length
    );
    
    if (engine === 'qwen3vl-spatial' && slideImage) {
        console.log(`[VISUAL_SENSOR] Tier 2: Qwen3-VL spatial analysis`);
        
        // Build profile from layout
        const profile = getLayoutQualityProfileFromId(layoutId);
        
        const tier2Result = await runVisualGateQwen3VL(
            slideImage,
            layoutId,
            { keyPoints: textContent, title: slideTitle },
            profile,
            slideIndex,
            costTracker
        );
        
        // Merge any Tier 2 failures
        if (tier2Result.failures.length > 0) {
            failures.push(...tier2Result.failures);
        }
        
        return {
            fits: failures.length === 0,
            failures,
            action: tier2Result.action,
            engine: 'qwen3vl-spatial',
            qwen3vl_metadata: tier2Result.qwen3vl_metadata
        };
    }
    
    // =========================================================================
    // TIER 3: GEMINI CODE (Not used in standard validation)
    // Reserved for custom diagram generation only
    // =========================================================================
    
    // Return Tier 1 pass result
    return {
        fits: true,
        failures: [],
        action: 'pass',
        engine: 'logic-gate'
    };
}

/**
 * Get layout quality profile from layout ID
 */
function getLayoutQualityProfileFromId(layoutId: string): LayoutQualityProfile {
    const profiles: Record<string, LayoutQualityProfile> = {
        'hero-centered': {
            minBullets: 0,
            maxBullets: 2,
            minTotalChars: 0,
            maxTotalChars: 120,
            minCharsPerPoint: 10,
            maxCharsPerPoint: 60,
            allowEmpty: true
        },
        'bento-grid': {
            minBullets: 2,
            maxBullets: 3,
            minTotalChars: 60,
            maxTotalChars: 200,
            minCharsPerPoint: 15,
            maxCharsPerPoint: 50,
            allowEmpty: false
        },
        'dashboard-tiles': {
            minBullets: 2,
            maxBullets: 3,
            minTotalChars: 60,
            maxTotalChars: 180,
            minCharsPerPoint: 15,
            maxCharsPerPoint: 50,
            allowEmpty: false
        },
        'split-left-text': {
            minBullets: 2,
            maxBullets: 4,
            minTotalChars: 80,
            maxTotalChars: 280,
            minCharsPerPoint: 20,
            maxCharsPerPoint: 70,
            allowEmpty: false
        },
        'split-right-text': {
            minBullets: 2,
            maxBullets: 4,
            minTotalChars: 80,
            maxTotalChars: 280,
            minCharsPerPoint: 20,
            maxCharsPerPoint: 70,
            allowEmpty: false
        },
        'standard-vertical': {
            minBullets: 2,
            maxBullets: 5,
            minTotalChars: 100,
            maxTotalChars: 400,
            minCharsPerPoint: 20,
            maxCharsPerPoint: 80,
            allowEmpty: false
        },
        'metrics-rail': {
            minBullets: 1,
            maxBullets: 3,
            minTotalChars: 40,
            maxTotalChars: 200,
            minCharsPerPoint: 15,
            maxCharsPerPoint: 60,
            allowEmpty: false
        },
        'timeline-horizontal': {
            minBullets: 2,
            maxBullets: 4,
            minTotalChars: 80,
            maxTotalChars: 250,
            minCharsPerPoint: 15,
            maxCharsPerPoint: 60,
            allowEmpty: false
        },
        'asymmetric-grid': {
            minBullets: 2,
            maxBullets: 4,
            minTotalChars: 80,
            maxTotalChars: 280,
            minCharsPerPoint: 15,
            maxCharsPerPoint: 60,
            allowEmpty: false
        }
    };
    
    return profiles[layoutId] || profiles['standard-vertical'];
}

