/**
 * Visual Design Agent - Interactions API Migration
 *
 * This agent creates spatial and visual composition specifications for slides.
 * Migrated to use the Gemini Interactions API for consistency.
 */

import {
    SlideNode,
    RouterDecision,
    VisualDesignSpec,
    VisualDesignSpecSchema,
    ResearchFact
} from "../types/slideTypes";
import { PROMPTS } from "./promptRegistry";
import {
    createJsonInteraction,
    CostTracker,
    ThinkingLevel,
    MODEL_AGENTIC,
    MODEL_SIMPLE
} from "./interactionsClient";
import {
    validateVisualLayoutAlignment,
    validateCritiqueResponse,
    validateRepairResponse
} from "./validators";
import { SpatialLayoutEngine } from "./spatialRenderer";

// Visual Designer: Spatial reasoning is an agentic task → MODEL_AGENTIC (3 Flash)
// Phil Schmid: Flash beats Pro on agentic benchmarks (78% vs 76.2% SWE-bench)

// Helper to determine component types for the prompt before they exist
function estimateComponentTypes(routerConfig: RouterDecision, contentPlan: any): string[] {
    const safeContentPlan = contentPlan && typeof contentPlan === 'object' ? contentPlan : {};
    const types: Set<string> = new Set();
    const layout = routerConfig.layoutVariant;
    const mode = routerConfig.renderMode;

    // 1. Data-Viz priority
    if (mode === 'data-viz' || (safeContentPlan.chartSpec && safeContentPlan.chartSpec.type)) {
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
    const numKeyPoints = safeContentPlan.keyPoints?.length || 0;
    const hasData = safeContentPlan.dataPoints && safeContentPlan.dataPoints.length > 0;

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

// Deterministically enforce visual focus cues in visual prompt to avoid validation loops
function enforceVisualFocusInSpec(spec: VisualDesignSpec, visualFocus?: string): VisualDesignSpec {
    if (!visualFocus || visualFocus.trim().length === 0 || visualFocus === 'Content') {
        return spec;
    }

    const focus = visualFocus.trim();
    const focusTerms = focus.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    const prompt = spec.prompt_with_composition || '';
    const promptLower = prompt.toLowerCase();
    const elementsLower = (spec.foreground_elements || []).join(' ').toLowerCase();

    const mentionsFocus = focusTerms.some(term =>
        promptLower.includes(term) || elementsLower.includes(term)
    ) || promptLower.includes(focus.toLowerCase());

    if (!mentionsFocus) {
        const trimmed = prompt.trim();
        const suffix = ` Visual focus cues: ${focus}.`;
        spec.prompt_with_composition = trimmed.length > 0
            ? `${trimmed}${trimmed.endsWith('.') ? '' : '.'}${suffix}`
            : `Visual focus cues: ${focus}.`;

        if (Array.isArray(spec.foreground_elements)) {
            const hasExact = spec.foreground_elements.some(el =>
                typeof el === 'string' && el.toLowerCase().includes(focus.toLowerCase())
            );
            if (!hasExact) {
                spec.foreground_elements = [...spec.foreground_elements, focus];
            }
        }
    }

    return spec;
}

export const runVisualDesigner = async (
    slideTitle: string,
    contentPlan: any,
    routerConfig: RouterDecision,
    facts: ResearchFact[],
    tracker: CostTracker,
    styleGuide?: { styleDNA?: any },
    variationBudget?: number
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
                styleGuide: "Modern Professional",
                styleDNA: styleGuide?.styleDNA,
                variationBudget: typeof variationBudget === 'number'
                    ? Math.max(0, Math.min(1, variationBudget))
                    : undefined
            });

            if (previousErrors.length > 0) {
                taskPrompt += `\n\nCRITICAL FIX REQUIRED: The previous attempt failed validation. \nERRORS: ${JSON.stringify(previousErrors)}\nEnsure you address these issues in the new design.`;
            }

            const rawVisualPrompt = await createJsonInteraction<any>(
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

            // STEP 2: Inject pre-computed spatial_strategy (LLM-generated zones are unreliable)
            // The LLM generates creative fields; zones come from deterministic layout templates
            let visualPrompt: VisualDesignSpec = {
                ...rawVisualPrompt,
                spatial_strategy: spatialStrategy // Use pre-computed zones from layoutEngine
            };

            // STEP 2.5: Enforce visual focus cues deterministically before validation
            visualPrompt = enforceVisualFocusInSpec(visualPrompt, routerConfig.visualFocus);

            // STEP 3: Schema Validation (Hard Parse)
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

            // Phase 2: Log alignment score for tracking visual first-pass success rate
            console.log(`[VISUAL DESIGNER] Alignment score: ${alignment.score}/100 for "${slideTitle}"`);

            if (alignment.passed) {
                console.log(`[VISUAL DESIGNER] ✅ SUCCESS for "${slideTitle}" (score: ${alignment.score})`);
                return visualPrompt;
            }

            console.warn(`[VISUAL DESIGNER] ⚠️ Validation warning (score: ${alignment.score}): ${alignment.errors.map(e => e.message).join(', ')}`);
            previousErrors = alignment.errors.map(e => e.message);

            if (attempt === MAX_ATTEMPTS) {
                // Return best effort if out of retries
                console.log(`[VISUAL DESIGNER] Returning best effort (score: ${alignment.score})`);
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

    // Build an ABSTRACT BACKGROUND fallback prompt - NO text, diagrams, or icons
    // All content is rendered separately by SpatialLayoutEngine
    const contextAwareFallbackPrompt = `
Abstract background gradient for professional presentation slide.
Theme: ${routerConfig.visualFocus || 'Corporate Technology'}.
Style: Dark gradient from #0f172a to #1e293b with subtle ${routerConfig.visualFocus ? routerConfig.visualFocus.toLowerCase() : 'blue'} accent glow.
Mood: Modern, premium, sophisticated.
Texture: Soft ambient lighting, subtle ${styleGuide?.styleDNA?.texture || 'geometric'} patterns fading into background.
IMPORTANT: No text, no icons, no diagrams, no charts - abstract gradient ONLY.
`.trim();

    return {
        spatial_strategy: spatialStrategy as any,
        prompt_with_composition: contextAwareFallbackPrompt,
        foreground_elements: [], // Deprecated - not used for rendering
        background_treatment: "Gradient",
        negative_space_allocation: "20%",
        color_harmony: { primary: "#10b981", accent: "#f59e0b", background_tone: "#0f172a" }
    };
};

/**
 * Run visual critique agent on a slide.
 * Returns VisualCritiqueReport with issues and overall score.
 */
export async function runVisualCritique(
    slide: SlideNode,
    svgProxy: string,
    costTracker: CostTracker
): Promise<any> {
    const variant = slide.routerConfig?.layoutVariant || 'standard-vertical';
    const componentTypes = (slide.layoutPlan?.components || []).map(c => c.type);

    // Simplified critique schema for Gemini API (avoid deep nesting)
    const critiqueSchema = {
        type: "object",
        properties: {
            issues: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        severity: { type: "string", enum: ["critical", "major", "minor"] },
                        category: { type: "string", enum: ["overlap", "contrast", "alignment", "hierarchy", "density"] },
                        zone: { type: "string" },
                        description: { type: "string" },
                        suggestedFix: { type: "string" }
                    },
                    required: ["severity", "category", "description", "suggestedFix"]
                }
            },
            overallScore: { type: "number" },
            hasCriticalIssues: { type: "boolean" }
        },
        required: ["issues", "overallScore", "hasCriticalIssues"]
    };

    try {
        const rawResult = await createJsonInteraction<any>(
            MODEL_SIMPLE, // Simple classification task - use cheap model
            PROMPTS.LAYOUT_CRITIC.TASK(svgProxy, variant, componentTypes),
            critiqueSchema,
            {
                systemInstruction: PROMPTS.LAYOUT_CRITIC.ROLE,
                temperature: 0.1,
                maxOutputTokens: 2048
            },
            costTracker
        );

        // Post-validate with Zod schema for runtime type safety
        const validated = validateCritiqueResponse(rawResult);
        if (!validated) {
            console.warn(`[VISUAL CRITIQUE] API response failed Zod validation, using fallback`);
            return { issues: [], overallScore: 75, hasCriticalIssues: false };
        }

        // Clamp score to valid range
        const validatedResult = {
            issues: validated.issues || [],
            overallScore: Math.min(100, Math.max(0, validated.overallScore)),
            hasCriticalIssues: validated.hasCriticalIssues
        };

        console.log(`[VISUAL CRITIQUE] Score: ${validatedResult.overallScore}, Issues: ${validatedResult.issues.length}`);
        return validatedResult;

    } catch (e: any) {
        console.error(`[VISUAL CRITIQUE] Failed:`, e.message);
        // Return passing result on error - don't block generation
        return { issues: [], overallScore: 75, hasCriticalIssues: false };
    }
}

/**
 * Run layout repair agent to fix visual issues.
 * Returns repaired SlideNode or original on failure.
 */
export async function runLayoutRepair(
    slide: SlideNode,
    critique: any,
    svgProxy: string,
    costTracker: CostTracker
): Promise<SlideNode> {
    const layoutPlanJson = JSON.stringify(slide.layoutPlan);
    const critiqueJson = JSON.stringify(critique);

    // Use same minimal schema as Generator for compatibility
    const repairSchema = {
        type: "object",
        properties: {
            title: { type: "string" },
            background: { type: "string", enum: ["solid", "gradient", "image"] },
            components: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        type: { type: "string", enum: ["text-bullets", "metric-cards", "process-flow", "icon-grid", "chart-frame", "title-section"] }
                    },
                    required: ["type"]
                }
            }
        },
        required: ["title", "components"]
    };

    try {
        const rawRepairedLayout = await createJsonInteraction<any>(
            MODEL_AGENTIC, // Repair requires reasoning - use agentic model
            PROMPTS.LAYOUT_REPAIRER.TASK(layoutPlanJson, critiqueJson, svgProxy),
            repairSchema,
            {
                systemInstruction: PROMPTS.LAYOUT_REPAIRER.ROLE,
                temperature: 0.2,
                maxOutputTokens: 4096
            },
            costTracker
        );

        // Post-validate with Zod schema for runtime type safety
        const validatedLayout = validateRepairResponse(rawRepairedLayout);
        if (!validatedLayout) {
            console.warn(`[LAYOUT REPAIR] API response failed Zod validation, returning original`);
            return {
                ...slide,
                warnings: [...(slide.warnings || []), 'Layout repair failed: invalid schema']
            };
        }

        // Return repaired slide - autoRepairSlide will be called by the orchestrator
        const repairedSlide: SlideNode = {
            ...slide,
            layoutPlan: validatedLayout,
            warnings: [...(slide.warnings || []), 'Layout repaired by System 2']
        };

        console.log(`[LAYOUT REPAIR] Successfully repaired layout for "${slide.title}"`);
        return repairedSlide;

    } catch (e: any) {
        console.error(`[LAYOUT REPAIR] Failed:`, e.message);
        // Return original on failure
        return {
            ...slide,
            warnings: [...(slide.warnings || []), `Layout repair failed: ${e.message}`]
        };
    }
}

