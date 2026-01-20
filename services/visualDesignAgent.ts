/**
 * Visual Design Agent - Interactions API Migration
 * 
 * This agent creates spatial and visual composition specifications for slides.
 * Migrated to use the Gemini Interactions API for consistency.
 */

import { SlideNode, RouterDecision, VisualDesignSpec, VisualDesignSpecSchema, ResearchFact } from "../types/slideTypes";
import { PROMPTS } from "./promptRegistry";
import { createJsonInteraction, CostTracker, ThinkingLevel, MODEL_AGENTIC } from "./interactionsClient";
import { validateVisualLayoutAlignment } from "./validators";
import { SpatialLayoutEngine } from "./spatialRenderer";

// Visual Designer: Spatial reasoning is an agentic task → MODEL_AGENTIC (3 Flash)
// Phil Schmid: Flash beats Pro on agentic benchmarks (78% vs 76.2% SWE-bench)

// Helper to determine component types for the prompt before they exist
function estimateComponentTypes(routerConfig: RouterDecision, contentPlan: any): string[] {
    const types: Set<string> = new Set();
    const layout = routerConfig.layoutVariant;
    const mode = routerConfig.renderMode;

    // 1. Data-Viz priority
    if (mode === 'data-viz' || (contentPlan.chartSpec && contentPlan.chartSpec.type)) {
        types.add('chart-frame');
    }

    // 2. Layout-specific forcing
    if (layout === 'bento-grid') {
        types.add('metric-cards');
        types.add('icon-grid');
    } else if (layout === 'timeline-horizontal') {
        types.add('process-flow');
    }

    // 3. Content heuristics
    const numKeyPoints = contentPlan.keyPoints?.length || 0;
    const hasData = contentPlan.dataPoints && contentPlan.dataPoints.length > 0;

    if (hasData && !types.has('chart-frame')) {
        types.add('metric-cards');
    }

    if (numKeyPoints > 0) {
        if (numKeyPoints <= 2 && mode === 'statement') {
            types.add('hero-text'); // Will map to text-bullets with special style
        } else {
            types.add('text-bullets');
        }
    }

    // Default fallback
    if (types.size === 0) return ['text-bullets'];

    return Array.from(types);
}

export const runVisualDesigner = async (
    slideTitle: string,
    contentPlan: any,
    routerConfig: RouterDecision,
    facts: ResearchFact[],
    tracker: CostTracker
): Promise<VisualDesignSpec> => {
    const MAX_ATTEMPTS = 2;
    const layoutEngine = new SpatialLayoutEngine();

    // STEP 1: Analyze spatial requirements
    const zones = layoutEngine.getZonesForVariant(routerConfig.layoutVariant);
    const spatialStrategy = {
        zones,
        compositional_hierarchy: "Derived from layout template",
        negative_space_plan: "Standard",
        visual_weight_distribution: "Balanced"
    };

    const componentTypes = estimateComponentTypes(routerConfig, contentPlan);

    // NOTE: Schema flattened to comply with Gemini Interactions API 4-level nesting limit.
    // The 'zones' array is simplified - detailed zone structure is handled via prompt guidance.
    const visualDesignSchema = {
        type: "object",
        properties: {
            spatial_strategy: {
                type: "object",
                properties: {
                    // Zones array simplified to avoid depth limit (was 5 levels deep)
                    zones: { type: "array" },
                    compositional_hierarchy: { type: "string" },
                    negative_space_plan: { type: "string" },
                    visual_weight_distribution: { type: "string" }
                }
            },
            prompt_with_composition: { type: "string" },
            foreground_elements: { type: "array", items: { type: "string" } },
            background_treatment: { type: "string" },
            negative_space_allocation: { type: "string" },
            color_harmony: {
                type: "object",
                properties: {
                    primary: { type: "string" },
                    accent: { type: "string" },
                    background_tone: { type: "string" }
                }
            }
        },
        required: ["spatial_strategy", "prompt_with_composition", "background_treatment", "color_harmony"]
    };

    // Use passed tracker directly
    const costTracker = tracker;

    let previousErrors: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            console.log(`[VISUAL DESIGNER] Attempt ${attempt}/${MAX_ATTEMPTS} for "${slideTitle}"...`);

            let taskPrompt = PROMPTS.VISUAL_COMPOSER.TASK({
                title: slideTitle,
                visualFocus: routerConfig.visualFocus,
                layoutVariant: routerConfig.layoutVariant,
                spatialStrategy: spatialStrategy,
                componentTypes: componentTypes,
                densityContext: routerConfig.densityBudget,
                styleGuide: "Modern Professional"
            });

            if (previousErrors.length > 0) {
                taskPrompt += `\n\nCRITICAL FIX REQUIRED: The previous attempt failed validation. \nERRORS: ${JSON.stringify(previousErrors)}\nEnsure you address these issues in the new design.`;
            }

            const visualPrompt = await createJsonInteraction<VisualDesignSpec>(
                MODEL_AGENTIC, // Spatial reasoning = agentic task, Flash outperforms Pro
                taskPrompt,
                visualDesignSchema,
                {
                    systemInstruction: PROMPTS.VISUAL_COMPOSER.ROLE,
                    thinkingLevel: 'low' as ThinkingLevel,
                    temperature: 0.3,
                    maxOutputTokens: 4096
                },
                costTracker
            );

            // STEP 2: Schema Validation (Hard Parse)
            const parseResult = VisualDesignSpecSchema.safeParse(visualPrompt);
            if (!parseResult.success) {
                // Extract error details from the failed parse result
                const errors = (parseResult as any).error?.errors ?? [];
                const formatted = (parseResult as any).error?.format?.() ?? {};
                console.warn(`[VISUAL DESIGNER] Schema violations:`, formatted);
                previousErrors = errors.map((e: any) => `Schema Error at ${(e.path || []).join('.')}: ${e.message || 'Unknown'}`);
                continue;
            }

            // STEP 3: Validate visual alignment with layout
            const alignment = validateVisualLayoutAlignment(
                visualPrompt,
                routerConfig
            );

            if (alignment.passed) {
                console.log(`[VISUAL DESIGNER] Success for "${slideTitle}"`);
                return visualPrompt;
            }

            console.warn(`[VISUAL DESIGNER] Validation warning: ${alignment.errors.map(e => e.message).join(', ')}`);
            previousErrors = alignment.errors.map(e => e.message);

            if (attempt === MAX_ATTEMPTS) {
                // Return best effort if out of retries
                return visualPrompt;
            }

        } catch (e: any) {
            console.error(`[VISUAL DESIGNER] Failed (attempt ${attempt}):`, e.message);

            // If rate limited, wait before retry
            if (e.message.includes('429') || e.message.includes('503')) {
                const delay = Math.pow(2, attempt) * 1000;
                console.warn(`[VISUAL DESIGNER] Rate limited. Waiting ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    // Fallback - Use deterministic, context-aware fallback instead of generic prompt
    console.warn("[VISUAL DESIGNER] Using fallback design spec");

    // Build a rich fallback prompt using available context
    const heroZones = zones.filter(z => z.purpose === 'hero').map(z => z.id).join(', ') || 'center';
    const secondaryZones = zones.filter(z => z.purpose === 'secondary').map(z => z.id).join(', ') || 'sides';

    const contextAwareFallbackPrompt = `
${routerConfig.layoutVariant} slide background for "${slideTitle}":
- Theme: ${routerConfig.visualFocus || 'Professional Corporate'}
- Dark gradient zones for text overlay on ${heroZones}
- Visual elements emphasis in ${secondaryZones}
- Professional corporate aesthetic
- 20% minimum negative space for breathing room
- Abstract, modern, high quality
`.trim();

    return {
        spatial_strategy: spatialStrategy as any,
        prompt_with_composition: contextAwareFallbackPrompt,
        foreground_elements: [],
        background_treatment: "Gradient",
        negative_space_allocation: "20%",
        color_harmony: { primary: "#10b981", accent: "#f59e0b", background_tone: "#0f172a" }
    };
};
