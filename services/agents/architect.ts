import { OutlineSchema, SLIDE_TYPES, ResearchFact } from "../../types/slideTypes";
import { PROMPTS } from "../promptRegistry";
import { createJsonInteraction, CostTracker, ThinkingLevel, MODEL_AGENTIC } from "../interactionsClient";
import { z } from "zod";

// Extract desired slide count from the user topic if explicitly requested (e.g., "7 slides")
const extractDesiredSlideCount = (topic: string): number | undefined => {
    const match = topic.match(/(\d{1,2})\s*(slides?|pages?|screens?)/i);
    if (!match) return undefined;
    const count = parseInt(match[1], 10);
    if (Number.isNaN(count)) return undefined;
    // Clamp to schema bounds (min 4, max 12)
    return Math.min(12, Math.max(4, count));
};

// --- AGENT 2: ARCHITECT ---

export async function runArchitect(
    topic: string,
    facts: ResearchFact[],
    costTracker: CostTracker
): Promise<z.infer<typeof OutlineSchema>> {
    console.log("[ARCHITECT] Starting structure planning with Interactions API...");

    const factContext = facts.map(f => `[${f.id}] ${f.claim}`).join('\n');
    const desiredSlideCount = extractDesiredSlideCount(topic);
    const slideCountInstruction = desiredSlideCount
        ? `Create EXACTLY ${desiredSlideCount} slides. Do not return more or fewer.`
        : `Create a 5-8 slide flow. If not specified, default to 7 slides.`;

    // NOTE: Schema flattened to comply with Gemini Interactions API 4-level nesting limit.
    const architectSchema = {
        type: "object",
        properties: {
            narrativeGoal: { type: "string" },
            title: { type: "string" },
            // Fact clusters simplified - inner structure via prompt
            factClusters: { type: "array" },
            styleGuide: {
                type: "object",
                properties: {
                    themeName: { type: "string" },
                    fontFamilyTitle: { type: "string" },
                    fontFamilyBody: { type: "string" },
                    // Color palette flattened to avoid depth issues
                    colorPalette: { type: "object" },
                    imageStyle: { type: "string" },
                    layoutStrategy: { type: "string" }
                },
                required: ["themeName", "colorPalette"]
            },
            // Slides array simplified - inner structure via prompt
            slides: { type: "array" }
        },
        required: ["narrativeGoal", "title", "styleGuide", "slides"]
    };

    try {
        // Architect: Structure planning is an agentic workflow → MODEL_AGENTIC (3 Flash)
        // Phil Schmid: Flash beats Pro on agentic benchmarks (78% vs 76.2% SWE-bench)
        const result = await createJsonInteraction(
            MODEL_AGENTIC,
            `TASK: Structure a comprehensive slide deck about "${topic}".
      
      AVAILABLE FACTS:
      ${factContext}
      
      REQUIREMENTS:
      1. Group facts into "Fact Clusters" by theme (each cluster has: id, theme, factIds)
            2. ${slideCountInstruction}
      3. Follow structure: Intro → Problem/Context → Solution/Analysis → Data/Evidence → Conclusion
      
      EACH SLIDE MUST HAVE:
      - "order": number (1, 2, 3...)
      - "type": one of "title-slide", "section-header", "content-main", "data-viz", "conclusion"
      - "title": string (THE SLIDE TITLE - REQUIRED)
      - "purpose": string describing what the slide communicates
      - "relevantClusterIds": array of cluster IDs this slide uses
      
      OUTPUT: JSON matching the provided schema. Ensure every slide has a "title" field.`,
            architectSchema,
            {
                systemInstruction: PROMPTS.ARCHITECT.ROLE,
                // Architect is the strategic brain - it benefits from thinking
                // Output is small (~1KB), so thinking tokens won't cause truncation
                thinkingLevel: 'medium' as ThinkingLevel,
                temperature: 0.2
            },
            costTracker
        );

        // DEBUG: Log the actual result structure to diagnose undefined titles
        console.log("[ARCHITECT] Raw result slides sample:", JSON.stringify(result.slides?.[0] || {}, null, 2));

        if (!result || !result.slides) {
            throw new Error("Missing slides in architect output");
        }

        // SAFETY: Ensure all slides have required fields with fallbacks
        result.slides = result.slides.map((slide: any, idx: number) => ({
            order: slide.order ?? idx + 1,
            type: slide.type ?? (idx === 0 ? SLIDE_TYPES.TITLE : SLIDE_TYPES.CONTENT),
            title: slide.title ?? slide.name ?? slide.heading ?? `Slide ${idx + 1}`,
            purpose: slide.purpose ?? slide.description ?? 'Content',
            relevantClusterIds: slide.relevantClusterIds ?? slide.clusterIds ?? []
        }));

        // Enforce user-requested slide count when specified
        if (desiredSlideCount) {
            if (result.slides.length < desiredSlideCount) {
                for (let i = result.slides.length; i < desiredSlideCount; i++) {
                    result.slides.push({
                        order: i + 1,
                        type: SLIDE_TYPES.CONTENT,
                        title: `Additional Insight ${i + 1}`,
                        purpose: 'Supporting analysis to complete the narrative',
                        relevantClusterIds: []
                    });
                }
            } else if (result.slides.length > desiredSlideCount) {
                result.slides = result.slides.slice(0, desiredSlideCount);
            }

            // Normalize order and ensure first/last types are appropriate
            result.slides = result.slides.map((slide: any, idx: number) => ({
                ...slide,
                order: idx + 1,
                type: idx === 0 ? SLIDE_TYPES.TITLE : (idx === desiredSlideCount - 1 ? SLIDE_TYPES.CONCLUSION : slide.type)
            }));
        }

        return result;
    } catch (e: any) {
        console.error("[ARCHITECT] Agent failed. Using fallback.", e.message);
        return {
            narrativeGoal: topic,
            title: topic,
            knowledgeSheet: facts,
            factClusters: [],
            styleGuide: {
                themeName: "Default",
                fontFamilyTitle: "Inter",
                fontFamilyBody: "Inter",
                colorPalette: {
                    primary: "#10b981",
                    secondary: "#3b82f6",
                    background: "#0f172a",
                    text: "#f8fafc",
                    accentHighContrast: "#f59e0b"
                },
                imageStyle: "Clean",
                layoutStrategy: "Standard"
            },
            slides: [{ order: 1, type: SLIDE_TYPES.TITLE, title: topic, purpose: "Title", relevantClusterIds: [] }]
        };
    }
}
