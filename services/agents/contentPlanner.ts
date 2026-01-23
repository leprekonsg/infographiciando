import { NarrativeTrail } from "../../types/slideTypes";
import { PROMPTS } from "../promptRegistry";
import { createJsonInteraction, CostTracker, ThinkingLevel, MODEL_AGENTIC } from "../interactionsClient";

// --- AGENT 4: CONTENT PLANNER (Phase 1: Context Folding, Phase 2: Density Constraints) ---

/**
 * Density hints for content planning based on layout constraints
 */
export interface ContentDensityHint {
    maxBullets?: number;        // Max bullet points (default 3)
    maxCharsPerBullet?: number; // Max chars per bullet (default 80)
    maxDataPoints?: number;     // Max data points (default 3)
}

/**
 * Content Plan Result - The contract between Content Planner and downstream agents
 * This is what generators, visual designers, and layout selectors depend on.
 */
export interface ContentPlanResult {
    title: string;
    keyPoints: string[];
    dataPoints: Array<{ label: string; value: number | string }>;
    narrative?: string;
    chartSpec?: {
        type: 'bar' | 'line' | 'pie' | 'doughnut' | 'stat-big';
        title?: string;
        data: Array<{ label: string; value: number; color?: string }>;
    };
}

/**
 * Creates a guaranteed-valid fallback content plan
 * Used when API calls fail or return invalid data
 */
function createFallbackContentPlan(meta: any, reason: string): ContentPlanResult {
    return {
        title: meta?.title || 'Slide Content',
        keyPoints: [`${reason}. Please edit manually.`],
        dataPoints: [],
        narrative: `Fallback: ${reason}`
    };
}

/**
 * Normalizes and validates keyPoints with density constraints
 */
function normalizeKeyPoints(
    items: any[],
    meta: any,
    maxBullets: number,
    maxCharsPerBullet: number
): string[] {
    const title = String(meta?.title || '').trim().toLowerCase();
    const purpose = String(meta?.purpose || '').trim().toLowerCase();
    const banned = new Set([
        'generated slide.', 'generated slide', 'overview', 'summary', 
        'key points', 'content', 'slide content', 'main points'
    ]);
    const uniq = new Set<string>();
    const cleaned: string[] = [];

    const safeItems = Array.isArray(items) ? items : [];
    
    for (const raw of safeItems) {
        const text = String(raw ?? '').trim();
        if (!text || text.length < 3) continue;
        
        const lower = text.toLowerCase();
        if (banned.has(lower)) continue;
        if (lower === title || lower === purpose) continue;
        if (uniq.has(lower)) continue;
        
        uniq.add(lower);
        // Truncate to max chars per bullet with ellipsis
        const truncated = text.length > maxCharsPerBullet 
            ? text.slice(0, maxCharsPerBullet - 1).trimEnd() + '…'
            : text;
        cleaned.push(truncated);
        
        if (cleaned.length >= maxBullets) break;
    }

    // Guarantee at least one valid key point
    if (cleaned.length === 0) {
        const fallbackPoint = meta?.purpose || meta?.title || 'Key insight';
        return [fallbackPoint.length > maxCharsPerBullet 
            ? fallbackPoint.slice(0, maxCharsPerBullet - 1) + '…' 
            : fallbackPoint];
    }

    return cleaned;
}

/**
 * Normalizes and validates dataPoints with density constraints
 */
function normalizeDataPoints(
    items: any[],
    maxDataPoints: number
): Array<{ label: string; value: number | string }> {
    if (!Array.isArray(items)) return [];
    
    const normalized: Array<{ label: string; value: number | string }> = [];

    const parseNumber = (value: any): number | null => {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string') {
            const cleaned = value.replace(/[%$,]/g, '').trim();
            const parsed = Number(cleaned);
            if (Number.isFinite(parsed)) return parsed;
        }
        return null;
    };

    for (let idx = 0; idx < items.length && normalized.length < maxDataPoints; idx++) {
        const raw = items[idx];
        
        if (raw && typeof raw === 'object') {
            const numValue = parseNumber(raw.value ?? raw.amount ?? raw.metric);
            const label = String(raw.label ?? raw.name ?? `Metric ${idx + 1}`).trim();
            
            if (label && label.length > 0) {
                // Keep string values for display (e.g., "42M", "$1.2B")
                const displayValue = numValue !== null 
                    ? numValue 
                    : String(raw.value ?? raw.amount ?? raw.metric ?? '').trim();
                    
                if (displayValue !== '' && displayValue !== 0) {
                    normalized.push({ 
                        label: label.slice(0, 40), // Cap label length
                        value: displayValue 
                    });
                }
            }
            continue;
        }

        // Handle raw numeric values
        const parsed = parseNumber(raw);
        if (parsed !== null) {
            normalized.push({ label: `Metric ${idx + 1}`, value: parsed });
        }
    }

    return normalized;
}

/**
 * Content Planner with Narrative History and Density Constraints
 * 
 * RETURNS: ContentPlanResult - A guaranteed-valid content plan object
 * 
 * @param meta - Slide metadata (title, purpose, type)
 * @param factsContext - Relevant facts for this slide
 * @param costTracker - Cost tracking
 * @param recentHistory - Last 2 slides for narrative arc awareness (Phase 1 Context Folding)
 * @param densityHint - Spatial budget constraints to prevent overflow (Phase 2)
 */
export async function runContentPlanner(
    meta: any,
    factsContext: string,
    costTracker: CostTracker,
    recentHistory?: NarrativeTrail[],
    densityHint?: ContentDensityHint
): Promise<ContentPlanResult> {
    // Validate input early - fail gracefully with actionable fallback
    if (!meta || typeof meta !== 'object') {
        console.warn('[CONTENT PLANNER] Invalid meta object, using fallback');
        return createFallbackContentPlan({ title: 'Untitled Slide' }, 'Invalid slide metadata');
    }

    console.log(`[CONTENT PLANNER] Planning content for: "${meta.title}"...`);
    if (recentHistory?.length) {
        console.log(`[CONTENT PLANNER] Narrative context: ${recentHistory.length} previous slides`);
    }

    // Extract density limits with sensible defaults
    const maxBullets = densityHint?.maxBullets ?? 3;
    const maxCharsPerBullet = densityHint?.maxCharsPerBullet ?? 80;
    const maxDataPoints = densityHint?.maxDataPoints ?? 3;

    if (densityHint) {
        console.log(`[CONTENT PLANNER] Density budget: max ${maxBullets} bullets, ${maxCharsPerBullet} chars each`);
    }

    // Truncate facts context to prevent token overflow
    const MAX_FACTS_CONTEXT_CHARS = 4000;
    const safeFactsContext = factsContext && factsContext.length > MAX_FACTS_CONTEXT_CHARS
        ? `${factsContext.slice(0, MAX_FACTS_CONTEXT_CHARS - 3)}...`
        : (factsContext || '');

    // Schema for Gemini Interactions API (flattened for nesting limits)
    const contentPlanSchema = {
        type: "object",
        properties: {
            title: { type: "string" },
            keyPoints: { type: "array", items: { type: "string" } },
            dataPoints: { type: "array" },
            narrative: { type: "string" },
            chartSpec: {
                type: "object",
                properties: {
                    type: { type: "string", enum: ["bar", "line", "pie", "doughnut", "stat-big"] },
                    title: { type: "string" },
                    data: { type: "array" }
                }
            }
        },
        required: ["title", "keyPoints"]
    };

    try {
        // Content Planner: Moderate reasoning for keyPoints extraction → MODEL_AGENTIC (3 Flash)
        const result = await createJsonInteraction<any>(
            MODEL_AGENTIC,
            PROMPTS.CONTENT_PLANNER.TASK(meta.title, meta.purpose, safeFactsContext, recentHistory, densityHint),
            contentPlanSchema,
            {
                systemInstruction: PROMPTS.CONTENT_PLANNER.ROLE,
                temperature: 0.2,
                maxOutputTokens: 2048,
                thinkingLevel: 'low' as ThinkingLevel
            },
            costTracker
        );

        // Validate API response structure
        if (!result || typeof result !== 'object') {
            console.warn('[CONTENT PLANNER] API returned invalid result, using fallback');
            return createFallbackContentPlan(meta, 'API returned invalid response');
        }

        // Normalize and validate the result with density constraints
        const normalizedPlan: ContentPlanResult = {
            title: String(result.title || meta.title || 'Slide Content').trim(),
            keyPoints: normalizeKeyPoints(result.keyPoints, meta, maxBullets, maxCharsPerBullet),
            dataPoints: normalizeDataPoints(result.dataPoints, maxDataPoints),
            narrative: result.narrative ? String(result.narrative).trim() : undefined
        };

        // Preserve chartSpec if provided and valid
        if (result.chartSpec && typeof result.chartSpec === 'object' && result.chartSpec.type) {
            const validChartTypes = ['bar', 'line', 'pie', 'doughnut', 'stat-big'];
            if (validChartTypes.includes(result.chartSpec.type)) {
                normalizedPlan.chartSpec = {
                    type: result.chartSpec.type,
                    title: result.chartSpec.title || normalizedPlan.title,
                    data: Array.isArray(result.chartSpec.data) 
                        ? result.chartSpec.data.slice(0, 6) // Cap chart data points
                        : []
                };
            }
        }

        console.log(`[CONTENT PLANNER] ✅ Success: ${normalizedPlan.keyPoints.length} keyPoints, ${normalizedPlan.dataPoints.length} dataPoints`);
        return normalizedPlan;

    } catch (e: any) {
        console.warn(`[CONTENT PLANNER] Failed: ${e.message}. Using fallback.`);
        return createFallbackContentPlan(meta, 'Content generation failed');
    }
}
