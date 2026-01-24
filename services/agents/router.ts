import { RouterDecision, RouterConstraints, RenderModeSchema, LayoutVariantSchema, StyleMode, StyleProfile, getStyleProfile, isLayoutAllowedForStyle } from "../../types/slideTypes";
import { createJsonInteraction, CostTracker, MODEL_SIMPLE, TOKEN_BUDGETS } from "../interactionsClient";
import { PROMPTS } from "../promptRegistry";

// --- AGENT 3: ROUTER (Phase 3: Circuit Breaker Support + Style-Aware Layout Selection) ---

/**
 * Style-aware layout preferences
 * Maps StyleMode to preferred layout variants for better visual coherence
 */
const STYLE_LAYOUT_PREFERENCES: Record<StyleMode, {
    preferred: string[];
    discouraged: string[];
}> = {
    corporate: {
        preferred: ['hero-centered', 'split-left-text', 'dashboard-tiles', 'standard-vertical'],
        discouraged: ['asymmetric-grid', 'bento-grid', 'timeline-horizontal']
    },
    professional: {
        preferred: ['split-left-text', 'split-right-text', 'bento-grid', 'metrics-rail'],
        discouraged: [] // All layouts acceptable
    },
    serendipitous: {
        preferred: ['hero-centered', 'asymmetric-grid', 'bento-grid'],
        discouraged: ['standard-vertical', 'dashboard-tiles'] // Too "template-y"
    }
};

/**
 * Apply style-aware layout filtering to a router result
 */
function applyStyleLayoutFiltering(
    result: RouterDecision,
    styleMode: StyleMode | undefined,
    constraints?: RouterConstraints
): RouterDecision {
    const style = getStyleProfile(styleMode);
    const chosenLayout = result.layoutVariant;
    
    // Check if the chosen layout is allowed for this style
    if (!isLayoutAllowedForStyle(chosenLayout, style)) {
        const prefs = STYLE_LAYOUT_PREFERENCES[style.mode];
        const fallbackLayout = prefs.preferred.find(
            layout => !constraints?.avoidLayoutVariants?.includes(layout)
        ) || 'split-left-text'; // Safe fallback
        
        console.log(`[ROUTER] Layout ${chosenLayout} not allowed for ${style.mode} mode, using ${fallbackLayout}`);
        return {
            ...result,
            layoutVariant: fallbackLayout as any,
            layoutIntent: `${result.layoutIntent} (style-adjusted to ${fallbackLayout})`
        };
    }
    
    return result;
}

/**
 * Get density budget adjusted for style mode
 */
function getStyleAdjustedDensityBudget(
    baseBudget: { maxChars: number; maxItems: number; minVisuals?: number },
    styleMode: StyleMode | undefined
): { maxChars: number; maxItems: number; minVisuals: number } {
    const style = getStyleProfile(styleMode);
    
    // Adjust based on style's density tolerance
    const densityMultiplier = style.densityTolerance === 'strict' ? 0.8 
        : style.densityTolerance === 'permissive' ? 1.2 
        : 1.0;
    
    // Serendipitous mode has lower text caps
    const textMultiplier = style.mode === 'serendipitous' ? 0.6 
        : style.mode === 'corporate' ? 0.85 
        : 1.0;
    
    return {
        maxChars: Math.round(baseBudget.maxChars * textMultiplier),
        maxItems: Math.round(baseBudget.maxItems * densityMultiplier),
        minVisuals: baseBudget.minVisuals ?? (style.mode === 'serendipitous' ? 1 : 0)
    };
}

/**
 * Router with Circuit Breaker Constraints and Style-Aware Layout Selection
 * @param slideMeta - Slide metadata from architect
 * @param costTracker - Cost tracking
 * @param constraints - Optional constraints for rerouting (avoidLayoutVariants)
 * @param styleMode - Optional style mode for layout preference filtering
 */
export async function runRouter(
    slideMeta: any,
    costTracker: CostTracker,
    constraints?: RouterConstraints,
    styleMode?: StyleMode
): Promise<RouterDecision> {
    console.log(`[ROUTER] Routing slide: "${slideMeta.title}"${styleMode ? ` (style: ${styleMode})` : ''}...`);
    if (constraints?.avoidLayoutVariants?.length) {
        console.log(`[ROUTER] Avoiding layouts: ${constraints.avoidLayoutVariants.join(', ')}`);
    }

    const routerSchema = {
        type: "object",
        properties: {
            renderMode: { type: "string", enum: RenderModeSchema.options },
            layoutVariant: { type: "string", enum: LayoutVariantSchema.options },
            layoutIntent: { type: "string" },
            visualFocus: { type: "string" },
            densityBudget: {
                type: "object",
                properties: {
                    maxChars: { type: "number" },
                    maxItems: { type: "number" },
                    minVisuals: { type: "number" }
                },
                required: ["maxChars", "maxItems"]
            }
        },
        required: ["renderMode", "layoutVariant", "densityBudget"]
    };

    try {
        // Router: Simple enum classification → MODEL_SIMPLE (2.5 Flash)
        // 79% cheaper than Flash, sufficient for layout variant selection
        // Token budget: Minimal output (just a small JSON object)
        const result = await createJsonInteraction<RouterDecision>(
            MODEL_SIMPLE,
            PROMPTS.ROUTER.TASK(slideMeta, { 
                avoidLayoutVariants: constraints?.avoidLayoutVariants, 
                styleMode 
            }),
            routerSchema,
            {
                systemInstruction: PROMPTS.ROUTER.ROLE,
                temperature: 0.1, // Reduced for more deterministic routing
                maxOutputTokens: TOKEN_BUDGETS.ROUTER, // Explicit budget for small output
                thinkingLevel: undefined // No thinking for simple classification
            },
            costTracker
        );

        // Validate that the chosen layout isn't in the avoid list
        if (constraints?.avoidLayoutVariants?.includes(result.layoutVariant)) {
            console.warn(`[ROUTER] Model chose avoided layout ${result.layoutVariant}, falling back to standard-vertical`);
            return {
                ...result,
                layoutVariant: 'standard-vertical',
                layoutIntent: 'Fallback (avoided layout)'
            };
        }

        // Apply style-aware filtering
        const styledResult = applyStyleLayoutFiltering(result, styleMode, constraints);
        
        // Adjust density budget for style (ensure defaults for required properties)
        const baseDensityBudget = {
            maxChars: styledResult.densityBudget?.maxChars ?? 500,
            maxItems: styledResult.densityBudget?.maxItems ?? 5,
            minVisuals: styledResult.densityBudget?.minVisuals ?? 0
        };
        
        const adjustedDensityBudget = getStyleAdjustedDensityBudget(
            baseDensityBudget,
            styleMode
        );

        const finalResult: RouterDecision = {
            ...styledResult,
            densityBudget: adjustedDensityBudget
        };

        return finalResult.renderMode
            ? finalResult
            : {
                renderMode: 'standard',
                layoutVariant: 'standard-vertical',
                layoutIntent: 'Fallback',
                densityBudget: getStyleAdjustedDensityBudget({ maxChars: 500, maxItems: 5, minVisuals: 0 }, styleMode),
                visualFocus: 'Content'
            };
    } catch (e: any) {
        console.warn("[ROUTER] Agent failed, using default layout.", e.message);
        return {
            renderMode: 'standard',
            layoutVariant: 'standard-vertical',
            layoutIntent: 'Fallback (Recovery)',
            densityBudget: getStyleAdjustedDensityBudget({ maxChars: 500, maxItems: 5, minVisuals: 0 }, styleMode),
            visualFocus: 'Content'
        };
    }
}
