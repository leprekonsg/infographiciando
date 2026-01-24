/**
 * Visual Sensor - Lightweight facade for visual layout health checks
 * 
 * Renamed from visualCortex.ts concept to "Sensor" role.
 * Used by Director during drafting phase, NOT just as QA gate.
 * 
 * Two-tier approach:
 * 1. DOM metrics check (cheap physics) - instant
 * 2. Qwen-VL visual check (expensive semantic) - optional
 */

import type { BrowserMetrics } from './BrowserRenderer';
import type { CostTracker } from './interactionsClient';

export interface VisualSensorResult {
    isOvercrowded: boolean;
    suggestedAction: 'reduce_text' | 'change_layout' | 'increase_buffer' | 'pass';
    clippingDetected: boolean;
    confidence: 'high' | 'medium' | 'low';
    details?: string;
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
