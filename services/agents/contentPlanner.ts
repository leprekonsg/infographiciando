import { NarrativeTrail } from "../../types/slideTypes";
import { PROMPTS } from "../promptRegistry";
import { createJsonInteraction, CostTracker, ThinkingLevel, MODEL_AGENTIC } from "../interactionsClient";

// --- AGENT 4: CONTENT PLANNER (Phase 1: Context Folding) ---

/**
 * Content Planner with Narrative History
 * @param meta - Slide metadata
 * @param factsContext - Relevant facts for this slide
 * @param costTracker - Cost tracking
 * @param recentHistory - Last 2 slides for narrative arc awareness (Phase 1 Context Folding)
 */
export async function runContentPlanner(
    meta: any,
    factsContext: string,
    costTracker: CostTracker,
    recentHistory?: NarrativeTrail[]
) {
    console.log(`[CONTENT PLANNER] Planning content for: "${meta.title}"...`);
    if (recentHistory?.length) {
        console.log(`[CONTENT PLANNER] Narrative context: ${recentHistory.length} previous slides`);
    }

    // NOTE: Schema flattened for consistency with Gemini Interactions API nesting limits.
    const MAX_FACTS_CONTEXT_CHARS = 4000;
    const safeFactsContext = factsContext.length > MAX_FACTS_CONTEXT_CHARS
        ? `${factsContext.slice(0, MAX_FACTS_CONTEXT_CHARS - 3)}...`
        : factsContext;
    const contentPlanSchema = {
        type: "object",
        properties: {
            title: { type: "string" },
            keyPoints: { type: "array", items: { type: "string" } },
            // dataPoints array simplified - structure defined via prompt
            dataPoints: { type: "array" },
            narrative: { type: "string" }
        },
        required: ["title", "keyPoints"]
    };

    try {
        // Content Planner: Moderate reasoning for keyPoints extraction → MODEL_AGENTIC (3 Flash)
        // Thinking: Low (extraction task with moderate reasoning)
        return await createJsonInteraction(
            MODEL_AGENTIC,
            PROMPTS.CONTENT_PLANNER.TASK(meta.title, meta.purpose, safeFactsContext, recentHistory),
            contentPlanSchema,
            {
                systemInstruction: PROMPTS.CONTENT_PLANNER.ROLE,
                temperature: 0.2,
                maxOutputTokens: 2048,
                thinkingLevel: 'low' as ThinkingLevel // Optimized for planning task
            },
            costTracker
        );
    } catch (e: any) {
        console.warn("[CONTENT PLANNER] Failed. Using basic fallback.", e.message);
        return {
            title: meta.title,
            keyPoints: ["Content generation failed. Please edit manually."],
            narrative: "Fallback due to agent error."
        };
    }
}
