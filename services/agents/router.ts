import { RouterDecision, RouterConstraints, RenderModeSchema, LayoutVariantSchema } from "../../types/slideTypes";
import { createJsonInteraction, CostTracker, MODEL_SIMPLE, TOKEN_BUDGETS } from "../interactionsClient";
import { PROMPTS } from "../promptRegistry";

// --- AGENT 3: ROUTER (Phase 3: Circuit Breaker Support) ---

/**
 * Router with Circuit Breaker Constraints
 * @param slideMeta - Slide metadata from architect
 * @param costTracker - Cost tracking
 * @param constraints - Optional constraints for rerouting (avoidLayoutVariants)
 */
export async function runRouter(
    slideMeta: any,
    costTracker: CostTracker,
    constraints?: RouterConstraints
): Promise<RouterDecision> {
    console.log(`[ROUTER] Routing slide: "${slideMeta.title}"...`);
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
            PROMPTS.ROUTER.TASK(slideMeta, constraints),
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

        return result.renderMode
            ? result
            : {
                renderMode: 'standard',
                layoutVariant: 'standard-vertical',
                layoutIntent: 'Fallback',
                densityBudget: { maxChars: 500, maxItems: 5, minVisuals: 0 },
                visualFocus: 'Content'
            };
    } catch (e: any) {
        console.warn("[ROUTER] Agent failed, using default layout.", e.message);
        return {
            renderMode: 'standard',
            layoutVariant: 'standard-vertical',
            layoutIntent: 'Fallback (Recovery)',
            densityBudget: { maxChars: 500, maxItems: 5, minVisuals: 0 },
            visualFocus: 'Content'
        };
    }
}
