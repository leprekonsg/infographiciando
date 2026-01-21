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

// --- QWEN LAYOUT SELECTOR (Visual QA-driven layout choice) ---

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
        'bento-grid': { bullets: 2, bulletChars: 60, metrics: 3 },
        'dashboard-tiles': { bullets: 1, bulletChars: 55, metrics: 3 },
        'metrics-rail': { bullets: 2, bulletChars: 70, metrics: 2 },
        'split-left-text': { bullets: 2, bulletChars: 70, metrics: 2 },
        'split-right-text': { bullets: 2, bulletChars: 70, metrics: 2 },
        'standard-vertical': { bullets: 3, bulletChars: 80, metrics: 3 },
        'asymmetric-grid': { bullets: 3, bulletChars: 75, metrics: 3 },
        'hero-centered': { bullets: 2, bulletChars: 70, metrics: 2 },
        'timeline-horizontal': { bullets: 2, bulletChars: 70, metrics: 2 }
    };

    const caps = variant ? (variantCaps[variant] || variantCaps['standard-vertical']) : variantCaps['standard-vertical'];

    const includeTextBullets = keyPoints.length > 0 && variant !== 'bento-grid';
    if (includeTextBullets) {
        components.push({
            type: 'text-bullets',
            title: 'Key Points',
            content: keyPoints.slice(0, Math.min(caps.bullets, maxItems)).map((kp: any) => trimLine(String(kp), caps.bulletChars))
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
            title: 'Summary',
            content: [contentPlan?.title || 'Overview']
        });
    }

    return components;
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

    if (slideMeta?.type === SLIDE_TYPES.TITLE || slideMeta?.order === 1) {
        variants.add('hero-centered');
    }

    if (dataPoints.length >= 3) {
        variants.add('bento-grid');
        variants.add('dashboard-tiles');
    }

    if (keyPoints.length >= 4) {
        variants.add('standard-vertical');
    }

    if (keyPoints.length <= 2) {
        variants.add('split-left-text');
        variants.add('metrics-rail');
    }

    if (keyPoints.length >= 3 && dataPoints.length === 0) {
        variants.add('asymmetric-grid');
    }

    const fallbackPool = (LayoutVariantSchema.options as LayoutVariant[]).filter(v => !variants.has(v));
    for (const v of fallbackPool) {
        if (variants.size >= 3) break;
        variants.add(v);
    }

    const filtered = Array.from(variants).filter(v => !avoid.has(v));
    return filtered.slice(0, 3);
}

export async function runQwenLayoutSelector(
    slideMeta: any,
    contentPlan: any,
    baseRouterConfig: RouterDecision,
    styleGuide: GlobalStyleGuide,
    costTracker: CostTracker,
    constraints?: RouterConstraints
): Promise<RouterDecision> {
    const { isQwenVLAvailable, getVisualCritiqueFromSvg } = await import('../visualCortex');

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

    for (const variant of candidateVariants) {
        const components = buildMockComponentsFromContentPlan(contentPlan, baseRouterConfig?.densityBudget, variant);
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
        });

        try {
            const svgProxy = generateSvgProxy(mockSlide, styleGuide);
            const critique = await getVisualCritiqueFromSvg(svgProxy, costTracker);
            let score = critique?.overall_score ?? -1;

            const warnings = mockSlide.warnings || [];
            const hasTruncation = warnings.some(w => String(w).toLowerCase().includes('truncated'));
            const hasDroppedTitle = warnings.some(w => String(w).toLowerCase().includes('title dropped'));
            if (hasTruncation || hasDroppedTitle) {
                const penalty = hasTruncation ? 20 : 10;
                score = Math.max(0, score - penalty);
                console.log(`[QWEN LAYOUT SELECTOR] Penalty applied for warnings (${penalty}): ${warnings.join(' | ')}`);
            }

            console.log(`[QWEN LAYOUT SELECTOR] Variant ${variant} score: ${score}`);

            if (score > bestScore) {
                bestScore = score;
                bestVariant = variant;
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
