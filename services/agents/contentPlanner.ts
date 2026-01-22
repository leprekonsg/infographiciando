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
        const result = await createJsonInteraction(
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

        const normalizeKeyPoints = (items: any[]): string[] => {
            const title = String(meta.title || '').trim().toLowerCase();
            const purpose = String(meta.purpose || '').trim().toLowerCase();
            const banned = new Set(['generated slide.', 'generated slide', 'overview', 'summary', 'key points']);
            const uniq = new Set<string>();
            const cleaned: string[] = [];

            (Array.isArray(items) ? items : []).forEach((raw: any) => {
                const text = String(raw ?? '').trim();
                if (!text) return;
                const lower = text.toLowerCase();
                if (banned.has(lower)) return;
                if (lower === title || lower === purpose) return;
                if (!uniq.has(lower)) {
                    uniq.add(lower);
                    cleaned.push(text);
                }
            });

            if (cleaned.length === 0) {
                return [meta.title || 'Key point'];
            }

            return cleaned.slice(0, 4);
        };

        const normalizeDataPoints = (items: any[]): any[] => {
            if (!Array.isArray(items)) return [];
            const normalized: any[] = [];

            const parseNumber = (value: any): number | null => {
                if (typeof value === 'number' && Number.isFinite(value)) return value;
                if (typeof value === 'string') {
                    const cleaned = value.replace(/[%$,]/g, '').trim();
                    const parsed = Number(cleaned);
                    if (Number.isFinite(parsed)) return parsed;
                }
                return null;
            };

            items.forEach((raw, idx) => {
                if (raw && typeof raw === 'object') {
                    const val = parseNumber((raw as any).value ?? (raw as any).amount ?? (raw as any).metric);
                    const label = String((raw as any).label ?? (raw as any).name ?? `Metric ${idx + 1}`).trim();
                    if (val !== null && label) {
                        normalized.push({ label, value: val });
                    }
                    return;
                }

                const parsed = parseNumber(raw);
                if (parsed !== null) {
                    normalized.push({ label: `Metric ${idx + 1}`, value: parsed });
                }
            });

            return normalized.slice(0, 4);
        };

        return {
            ...result,
            keyPoints: normalizeKeyPoints(result?.keyPoints || []),
            dataPoints: normalizeDataPoints(result?.dataPoints || [])
        };
    } catch (e: any) {
        console.warn("[CONTENT PLANNER] Failed. Using basic fallback.", e.message);
        return {
            title: meta.title,
            keyPoints: ["Content generation failed. Please edit manually."],
            narrative: "Fallback due to agent error."
        };
    }
}
