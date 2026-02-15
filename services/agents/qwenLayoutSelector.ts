import {
    SlideNode,
    GlobalStyleGuide,
    RouterDecision,
    RouterConstraints,
    LayoutVariant,
    LayoutVariantSchema,
    SLIDE_TYPES
} from "../../types/slideTypes";
import { CostTracker } from "../interactionsClient";
import { autoRepairSlide } from "../repair/autoRepair";
import { generateSvgProxy } from "../visual/svgProxy";
import { 
    QWEN_PERSONAS, 
    LAYOUT_SELECTOR_PROMPT, 
    buildQwenMessage,
    getQwenRequestConfig,
    getThinkingMode 
} from "../visual/qwenPromptConfig";

// --- QWEN LAYOUT SELECTOR (Visual QA-driven layout choice) ---
// 
// Optimized for Qwen3-VL's architecture:
// - Uses /no_think mode for fast perception-only scoring
// - Layout Selector persona for focused evaluation
// - Minimal token output for rapid iteration

function buildMockComponentsFromContentPlan(
    contentPlan: any,
    densityBudget?: RouterDecision['densityBudget'],
    variant?: LayoutVariant
): any[] {
    const components: any[] = [];
    const keyPoints = Array.isArray(contentPlan?.keyPoints) ? contentPlan.keyPoints : [];
    const dataPoints = Array.isArray(contentPlan?.dataPoints) ? contentPlan.dataPoints : [];

    const maxItems = Math.max(2, Math.min(3, densityBudget?.maxItems || 3));

    const trimLine = (text: string, max = 70) => {
        if (!text || typeof text !== 'string') return text;
        if (text.length <= max) return text;
        return text.slice(0, max - 1).trimEnd() + '…';
    };

    const variantCaps: Record<string, { bullets: number; bulletChars: number; metrics: number }> = {
        'bento-grid': { bullets: 2, bulletChars: 55, metrics: 3 },
        'dashboard-tiles': { bullets: 1, bulletChars: 50, metrics: 3 },
        'metrics-rail': { bullets: 2, bulletChars: 60, metrics: 2 },
        'split-left-text': { bullets: 2, bulletChars: 60, metrics: 2 },
        'split-right-text': { bullets: 2, bulletChars: 60, metrics: 2 },
        'standard-vertical': { bullets: 3, bulletChars: 70, metrics: 3 },
        'asymmetric-grid': { bullets: 3, bulletChars: 65, metrics: 3 },
        'hero-centered': { bullets: 1, bulletChars: 55, metrics: 2 },
        'timeline-horizontal': { bullets: 3, bulletChars: 55, metrics: 2 }
    };

    const caps = variant ? (variantCaps[variant] || variantCaps['standard-vertical']) : variantCaps['standard-vertical'];

    // Derive per-line target from density budget (caps are hard limits)
    const densityPerItem = densityBudget?.maxChars && maxItems
        ? Math.floor(densityBudget.maxChars / Math.max(1, maxItems))
        : undefined;
    const effectiveBulletChars = Math.max(40, Math.min(caps.bulletChars, densityPerItem || caps.bulletChars));

    const wantsProcessFlow = variant === 'timeline-horizontal' && keyPoints.length >= 3;
    if (wantsProcessFlow) {
        components.push({
            type: 'process-flow',
            steps: keyPoints.slice(0, Math.min(3, maxItems)).map((kp: any, i: number) => ({
                number: i + 1,
                title: trimLine(String(kp), 18),
                description: trimLine(String(kp), effectiveBulletChars),
                icon: 'ArrowRight'
            }))
        });
    }

    const includeTextBullets = !wantsProcessFlow && keyPoints.length > 0 &&
        variant !== 'bento-grid' && variant !== 'dashboard-tiles';
    if (includeTextBullets) {
        components.push({
            type: 'text-bullets',
            content: keyPoints.slice(0, Math.min(caps.bullets, maxItems)).map((kp: any) => trimLine(String(kp), effectiveBulletChars))
        });
    }

    if (dataPoints.length > 0) {
        const metrics = dataPoints.slice(0, Math.min(caps.metrics, maxItems)).map((dp: any, idx: number) => {
            if (typeof dp === 'string') {
                return { value: dp, label: `Metric ${idx + 1}`, icon: 'TrendingUp' };
            }
            if (dp && typeof dp === 'object') {
                return {
                    value: trimLine(String(dp.value ?? dp.amount ?? dp.metric ?? `M${idx + 1}`), 12),
                    label: trimLine(String(dp.label ?? dp.name ?? `Metric ${idx + 1}`), 18),
                    icon: dp.icon ?? 'TrendingUp'
                };
            }
            return { value: `M${idx + 1}`, label: `Metric ${idx + 1}`, icon: 'TrendingUp' };
        });

        components.push({
            type: 'metric-cards',
            metrics
        });
    }

    if (components.length === 0) {
        components.push({
            type: 'text-bullets',
            content: [contentPlan?.title || 'Overview']
        });
    }

    // Variant-level component cap to avoid unplaced warnings
    if (variant === 'hero-centered') {
        if (keyPoints.length > 0) {
            return components.filter(c => c.type === 'text-bullets').slice(0, 1).length
                ? components.filter(c => c.type === 'text-bullets').slice(0, 1)
                : components.slice(0, 1);
        }
        return components.slice(0, 1);
    }

    if (variant === 'split-left-text' || variant === 'split-right-text') {
        if (components.length === 1) {
            const fallbackLine = trimLine(
                String(keyPoints[0] || contentPlan?.title || 'Primary context'),
                effectiveBulletChars
            );
            components.push({
                type: 'text-bullets',
                content: [fallbackLine]
            });
        }
        return components.slice(0, 2);
    }

    if (variant === 'timeline-horizontal') {
        return components.slice(0, 1);
    }

    return components;
}

/**
 * Check if dataPoints are valid for metric-cards rendering.
 * CRITICAL: Must stay aligned with canUseMetricCards() semantics in slideAgentService.ts.
 * Requires at least 2 dataPoints with BOTH value AND label (not either/or).
 * 
 * Previously this used lenient "hasValue || hasLabel" which caused Qwen to
 * select metrics-rail layouts that Generator would later reject.
 */
function hasValidMetricData(dataPoints: any[]): boolean {
    if (!Array.isArray(dataPoints) || dataPoints.length < 2) return false;

    const hasExplicitUnitToken = (value: string): boolean => {
        if (!value) return false;
        return /[%$]|\b(?:sec|min|hr|hrs|day|days|week|weeks|month|months|year|years|yr|yrs|x)\b/i.test(value);
    };

    const isPlaceholderLikeLabel = (label: string): boolean => {
        const normalized = String(label || '').toLowerCase().trim();
        return !normalized ||
            /^(?:metric|kpi|value|label|stat|data point)\s*\d*$/.test(normalized) ||
            /^(?:n\/?a|tbd|coming soon|placeholder|unknown)$/i.test(normalized);
    };

    const isLowSignalLabel = (label: string): boolean => {
        const normalized = String(label || '').toLowerCase().trim();
        return /^(metric|kpi|score|index|rating|value)\s*\d*$/.test(normalized) ||
            /\b(utility|importance|effectiveness|readiness|maturity|contribution)\b/.test(normalized);
    };

    const extractNumeric = (text: string): string => {
        if (typeof text !== 'string') return '';
        const m = text.match(/\$?\d[\d,.]*(?:\.\d+)?%?/);
        return m ? m[0].trim() : '';
    };

    const normalizePoint = (dp: any): { label: string; value: string } | null => {
        if (!dp || typeof dp !== 'object') return null;
        const label = String(dp.label ?? dp.name ?? dp.title ?? '').trim();
        let value = String(dp.value ?? dp.amount ?? dp.metric ?? dp.score ?? '').trim();
        if (!value) {
            const textFallback = String(dp.claim ?? dp.text ?? dp.description ?? '').trim();
            value = extractNumeric(textFallback);
        }
        if (!label || !value) return null;
        if (!/\d/.test(value)) return null;
        if (isPlaceholderLikeLabel(label)) return null;
        if (isLowSignalLabel(label) && !hasExplicitUnitToken(value)) return null;
        return { label, value };
    };

    const validCount = dataPoints.filter((dp: any) => !!normalizePoint(dp)).length;
    return validCount >= 2;
}

function pickCandidateLayoutVariants(
    slideMeta: any,
    contentPlan: any,
    constraints?: RouterConstraints
): LayoutVariant[] {
    const variants = new Set<LayoutVariant>();
    const avoid = new Set(constraints?.avoidLayoutVariants || []);

    const keyPoints = Array.isArray(contentPlan?.keyPoints) ? contentPlan.keyPoints : [];
    const dataPoints = Array.isArray(contentPlan?.dataPoints) ? contentPlan.dataPoints : [];
    
    // CRITICAL: Check DATA QUALITY not just quantity for metric-dependent layouts
    const canUseMetrics = hasValidMetricData(dataPoints);

    const slideType = String(slideMeta?.type || '').toLowerCase();
    const isTitleLike = slideType.includes('title') || slideType.includes('section-header') || slideMeta?.order === 1;
    if (isTitleLike) {
        variants.add('hero-centered');
        variants.add('standard-vertical');
        variants.add('split-left-text');
    }

    // Only suggest metric-heavy layouts if we have VALID metric data
    if (canUseMetrics && dataPoints.length >= 3 && keyPoints.length >= 2 && !isTitleLike) {
        variants.add('bento-grid');
        variants.add('dashboard-tiles');
    }

    if (keyPoints.length >= 4) {
        variants.add('standard-vertical');
    }

    if (keyPoints.length <= 2) {
        if (keyPoints.length <= 1) {
            // Sparse content: prefer stable vertical stacks over split layouts.
            variants.add('standard-vertical');
        } else {
            variants.add('split-left-text');
        }
        // ONLY suggest metrics-rail if we have VALID metric data (min 2 with value+label)
        if (canUseMetrics) {
            variants.add('metrics-rail');
        }
    }

    if (keyPoints.length >= 3 && !canUseMetrics) {
        variants.add('asymmetric-grid');
    }
    
    // If no variants selected yet, add safe defaults based on content
    if (variants.size === 0) {
        if (keyPoints.length > 0) {
            variants.add('split-left-text');
            variants.add('standard-vertical');
        } else {
            variants.add('hero-centered');
        }
    }

    const fallbackPool = (LayoutVariantSchema.options as LayoutVariant[]).filter(v => !variants.has(v) && ![
        // Exclude metric-dependent layouts from fallback if we lack valid metrics
        ...(canUseMetrics ? [] : ['metrics-rail', 'dashboard-tiles', 'bento-grid'])
    ].includes(v));
    for (const v of fallbackPool) {
        if (variants.size >= 3) break;
        variants.add(v);
    }

    const filtered = Array.from(variants).filter(v => !avoid.has(v));

    const titlePriority: LayoutVariant[] = ['hero-centered', 'split-left-text', 'standard-vertical', 'split-right-text', 'asymmetric-grid', 'metrics-rail', 'dashboard-tiles', 'bento-grid', 'timeline-horizontal'];
    const sparsePriority: LayoutVariant[] = ['standard-vertical', 'split-left-text', 'hero-centered', 'split-right-text', 'asymmetric-grid', 'metrics-rail', 'dashboard-tiles', 'bento-grid', 'timeline-horizontal'];
    const defaultPriority: LayoutVariant[] = ['standard-vertical', 'split-left-text', 'split-right-text', 'asymmetric-grid', 'hero-centered', 'metrics-rail', 'dashboard-tiles', 'bento-grid', 'timeline-horizontal'];
    const priority = isTitleLike ? titlePriority : (keyPoints.length <= 1 ? sparsePriority : defaultPriority);
    const rank = (variant: LayoutVariant): number => {
        const idx = priority.indexOf(variant);
        return idx >= 0 ? idx : priority.length + 1;
    };

    return filtered.sort((a, b) => rank(a) - rank(b)).slice(0, 3);
}

export async function runQwenLayoutSelector(
    slideMeta: any,
    contentPlan: any,
    baseRouterConfig: RouterDecision,
    styleGuide: GlobalStyleGuide,
    costTracker: CostTracker,
    constraints?: RouterConstraints,
    componentsOverride?: any[]
): Promise<RouterDecision> {
    const { isQwenVLAvailable, getLayoutScoreFast, getVisualCritiqueFromSvg } = await import('../visualCortex');

    if (!isQwenVLAvailable()) {
        return baseRouterConfig;
    }

    const candidateVariants = pickCandidateLayoutVariants(slideMeta, contentPlan, constraints);
    if (candidateVariants.length === 0) {
        return baseRouterConfig;
    }

    console.log(`[QWEN LAYOUT SELECTOR] Evaluating variants: ${candidateVariants.join(', ')}`);

    let bestVariant = baseRouterConfig.layoutVariant;
    let bestScore = -1;
    let bestTieRank = Number.POSITIVE_INFINITY;
    const titleLen = String(contentPlan?.title || slideMeta?.title || '').replace(/\s+/g, ' ').trim().length;
    const keyPoints = Array.isArray(contentPlan?.keyPoints) ? contentPlan.keyPoints : [];
    const runSlideType = String(slideMeta?.type || '').toLowerCase();
    const isTitleLike = runSlideType.includes('title') || runSlideType.includes('section-header') || slideMeta?.order === 1;
    const tieBreakPriority: LayoutVariant[] = isTitleLike
        ? ['hero-centered', 'split-left-text', 'standard-vertical', 'split-right-text', 'asymmetric-grid', 'metrics-rail', 'dashboard-tiles', 'bento-grid', 'timeline-horizontal']
        : ['standard-vertical', 'split-left-text', 'hero-centered', 'split-right-text', 'asymmetric-grid', 'metrics-rail', 'dashboard-tiles', 'bento-grid', 'timeline-horizontal'];
    const tieRank = (variant: LayoutVariant): number => {
        const idx = tieBreakPriority.indexOf(variant);
        return idx >= 0 ? idx : tieBreakPriority.length + 1;
    };

    for (const variant of candidateVariants) {
        const components = Array.isArray(componentsOverride) && componentsOverride.length > 0
            ? componentsOverride
            : buildMockComponentsFromContentPlan(contentPlan, baseRouterConfig?.densityBudget, variant);
        const mockSlide: SlideNode = autoRepairSlide({
            order: slideMeta?.order ?? 0,
            type: slideMeta?.type ?? SLIDE_TYPES.CONTENT,
            title: contentPlan?.title || slideMeta?.title || 'Slide',
            purpose: slideMeta?.purpose || 'Content',
            routerConfig: { ...baseRouterConfig, layoutVariant: variant },
            layoutPlan: {
                title: contentPlan?.title || slideMeta?.title || 'Slide',
                components
            },
            visualReasoning: 'Qwen layout selector mock',
            visualPrompt: '',
            visualDesignSpec: undefined,
            speakerNotesLines: [],
            citations: [],
            chartSpec: undefined,
            selfCritique: undefined,
            readabilityCheck: 'pass',
            validation: undefined,
            warnings: []
        }, styleGuide);

        try {
            const svgProxy = generateSvgProxy(mockSlide, styleGuide);
            
            // Use fast-path scoring for layout selection (optimized for /no_think mode)
            // Falls back to full critique if fast scoring unavailable
            let score: number = -1;
            
            const fastScore = await getLayoutScoreFast(svgProxy, costTracker);
            if (fastScore && typeof fastScore.overall_score === 'number') {
                score = fastScore.overall_score;
                console.log(`[QWEN LAYOUT SELECTOR] Fast score for ${variant}: ${score} (issue: ${fastScore.primary_issue || 'none'})`);
                if (fastScore.primary_issue === 'sparse') {
                    if (variant === 'hero-centered' && titleLen >= 42) {
                        score = Math.max(0, score - 8);
                    }
                    if ((variant === 'bento-grid' || variant === 'dashboard-tiles') && keyPoints.length <= 1) {
                        score = Math.max(0, score - 10);
                    }
                    if (variant === 'standard-vertical' && keyPoints.length <= 1) {
                        score = Math.min(100, score + 4);
                    }
                }
            } else {
                // Fallback to full critique
                const critique = await getVisualCritiqueFromSvg(svgProxy, costTracker);
                score = critique?.overall_score ?? -1;
                console.log(`[QWEN LAYOUT SELECTOR] Full critique for ${variant}: ${score}`);
            }

            const warnings = mockSlide.warnings || [];
            const hasTruncation = warnings.some(w => String(w).toLowerCase().includes('truncated'));
            const hasDroppedTitle = warnings.some(w => String(w).toLowerCase().includes('title dropped'));
            if (hasTruncation || hasDroppedTitle) {
                const penalty = hasTruncation ? 20 : 10;
                score = Math.max(0, score - penalty);
                console.log(`[QWEN LAYOUT SELECTOR] Penalty applied for warnings (${penalty}): ${warnings.join(' | ')}`);
            }

            console.log(`[QWEN LAYOUT SELECTOR] Variant ${variant} final score: ${score}`);

            const variantTieRank = tieRank(variant);
            if (score > bestScore || (score === bestScore && variantTieRank < bestTieRank)) {
                bestScore = score;
                bestVariant = variant;
                bestTieRank = variantTieRank;
            }
        } catch (err: any) {
            console.warn(`[QWEN LAYOUT SELECTOR] Failed to score variant ${variant}: ${err.message}`);
        }
    }

    if (bestVariant !== baseRouterConfig.layoutVariant) {
        console.log(`[QWEN LAYOUT SELECTOR] Selected layout: ${bestVariant} (score: ${bestScore})`);
        return {
            ...baseRouterConfig,
            layoutVariant: bestVariant,
            layoutIntent: `Qwen visual selector (score: ${bestScore})`
        };
    }

    return baseRouterConfig;
}

