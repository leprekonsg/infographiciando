/**
 * Slide Agent Service - Interactions API Migration
 * 
 * This module implements a multi-agent system for generating presentation decks
 * using the Gemini Interactions API. It follows the agent patterns from:
 * - https://ai.google.dev/api/interactions-api.md.txt
 * - https://www.philschmid.de/building-agents
 * 
 * Key Improvements:
 * - Proper Interactions API usage with status tracking
 * - Function calling with client-side tool execution loop
 * - Max iterations guard (escape hatch)
 * - Structured logging and transparency
 * - Thought signature preservation (Gemini 3)
 */

import { GoogleGenAI, Type, Modality } from "@google/genai";
import {
    EditableSlideDeck, SlideNode, OutlineSchema, SLIDE_TYPES, GlobalStyleGuide,
    ResearchFact, RouterDecision, RouterDecisionSchema, SlideNodeSchema, LayoutVariantSchema, RenderModeSchema,
    FactClusterSchema, VisualDesignSpec
} from "../types/slideTypes";
import {
    InteractionsClient,
    runAgentLoop,
    createJsonInteraction,
    CostTracker,
    AgentLogger,
    Tool,
    ToolDefinition,
    ThinkingLevel
} from "./interactionsClient";
import { PROMPTS } from "./promptRegistry";
import { validateSlide, validateVisualLayoutAlignment } from "./validators";
import { runVisualDesigner } from "./visualDesignAgent";
import { z } from "zod";

// --- CONSTANTS ---
// Model tiers imported from interactionsClient for consistency
// Based on Phil Schmid's agent best practices:
// - Agentic tasks: 3 Flash (78% SWE-bench, beats Pro at 76.2%)
// - Simple tasks: 2.5 Flash (classification, JSON structuring)
// - Reasoning: 3 Pro (reserved for >1M context, rarely needed)

import { MODEL_AGENTIC, MODEL_SIMPLE, MODEL_REASONING } from "./interactionsClient";

// Backward compatibility aliases
const MODEL_SMART = MODEL_REASONING;
const MODEL_FAST = MODEL_AGENTIC;
const MODEL_BACKUP = MODEL_SIMPLE;

const MAX_AGENT_ITERATIONS = 15; // Global escape hatch per Phil Schmid's recommendation

// Helper to get AI client for image generation (still uses generateContent)
const getAiClient = () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        const errorMsg = `[SLIDE AGENT ERROR] API_KEY is not configured for image generation.

To fix this:
1. Create a .env file in the project root
2. Add: GEMINI_API_KEY=your_api_key_here
3. Get your key from: https://aistudio.google.com/app/apikey
4. Restart the dev server`;
        console.error(errorMsg);
        throw new Error('API_KEY is required for image generation. Check console for setup instructions.');
    }
    return new GoogleGenAI({ apiKey });
};

// --- TOOL DEFINITIONS (Following Phil Schmid's Ergonomics Guidelines) ---

const webSearchTool: ToolDefinition = {
    name: "web_search",
    description: "Search the web for current, verified information about a topic. Use this when you need real-time data, statistics, market trends, or facts that require up-to-date sources. Returns structured search results with URLs and snippets.",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The search query to execute. Be specific and include relevant keywords for better results."
            }
        },
        required: ["query"]
    }
};

const extractFactsTool: ToolDefinition = {
    name: "extract_facts",
    description: "Extract and structure verified facts from search results or provided text. Use this after web_search to organize raw information into validated, citable facts with confidence scores.",
    parameters: {
        type: "object",
        properties: {
            raw_content: {
                type: "string",
                description: "The raw content or search results to extract facts from."
            },
            focus_area: {
                type: "string",
                description: "The specific domain or topic focus for fact extraction (e.g., 'market statistics', 'technical specifications')."
            }
        },
        required: ["raw_content", "focus_area"]
    }
};

// --- DETERMINISTIC AUTO-REPAIR ---

// Component type mapping for unsupported -> supported types
// Includes hyphen, underscore, camelCase, and abbreviated variants
const COMPONENT_TYPE_MAP: Record<string, string> = {
    // Text-based components -> text-bullets
    'text-block': 'text-bullets',
    'text_block': 'text-bullets',
    'textblock': 'text-bullets',
    'text': 'text-bullets',
    'paragraph': 'text-bullets',
    'bullet-list': 'text-bullets',
    'bullet_list': 'text-bullets',
    'bulletlist': 'text-bullets',
    'bullets': 'text-bullets',
    'list': 'text-bullets',
    'content': 'text-bullets',
    'body': 'text-bullets',
    'key-points': 'text-bullets',
    'key_points': 'text-bullets',
    'keypoints': 'text-bullets',
    'visual_list': 'text-bullets', // Also could be icon-grid, defaulting to text
    'visual-list': 'text-bullets',
    'visuallist': 'text-bullets',

    // Metric components -> metric-cards
    'metrics': 'metric-cards',
    'stats': 'metric-cards',
    'kpis': 'metric-cards',
    'cards': 'metric-cards',
    'metric-group': 'metric-cards',
    'metric_group': 'metric-cards',
    'metricgroup': 'metric-cards',
    'stat-cards': 'metric-cards',
    'stat_cards': 'metric-cards',
    'statcards': 'metric-cards',
    'kpi-cards': 'metric-cards',
    'kpi_cards': 'metric-cards',
    'numbers': 'metric-cards',
    'statistics': 'metric-cards',
    'data-points': 'metric-cards',
    'data_points': 'metric-cards',
    'datapoints': 'metric-cards',

    // Process components -> process-flow
    'flow': 'process-flow',
    'timeline': 'process-flow',
    'steps': 'process-flow',
    'process': 'process-flow',
    'workflow': 'process-flow',
    'sequence': 'process-flow',
    'step-flow': 'process-flow',
    'step_flow': 'process-flow',
    'stepflow': 'process-flow',

    // Icon components -> icon-grid
    'icon': 'icon-grid', // Common abbreviation the model generates
    'icons': 'icon-grid',
    'grid': 'icon-grid',
    'features': 'icon-grid',
    'benefits': 'icon-grid',
    'capabilities': 'icon-grid',
    'icon-list': 'icon-grid',
    'icon_list': 'icon-grid',
    'iconlist': 'icon-grid',

    // Chart components -> chart-frame
    'chart': 'chart-frame',
    'graph': 'chart-frame',
    'data': 'chart-frame',
    'visualization': 'chart-frame',
    'viz': 'chart-frame',
    'bar-chart': 'chart-frame',
    'bar_chart': 'chart-frame',
    'barchart': 'chart-frame',
    'pie-chart': 'chart-frame',
    'pie_chart': 'chart-frame',
    'piechart': 'chart-frame',
    'line-chart': 'chart-frame',
    'line_chart': 'chart-frame',
    'linechart': 'chart-frame'
};

const SUPPORTED_COMPONENT_TYPES = ['text-bullets', 'metric-cards', 'process-flow', 'icon-grid', 'chart-frame'];

/**
 * Normalizes an array item that might be a string, JSON string, or object.
 * Returns a proper object with expected properties.
 */
function normalizeArrayItem(item: any, idx: number, expectedType: 'metric' | 'step' | 'item'): any {
    // If already a valid object with expected properties, return as-is
    if (typeof item === 'object' && item !== null) {
        return item;
    }

    // If it's a string, try to parse as JSON first
    if (typeof item === 'string') {
        // Try parsing as JSON (handles '{"value": ">300%", "label": "..."}')
        try {
            const parsed = JSON.parse(item);
            if (typeof parsed === 'object' && parsed !== null) {
                return parsed;
            }
        } catch {
            // Not valid JSON, treat as plain text
        }

        // Convert plain string to appropriate object based on expected type
        const text = item.trim();

        if (expectedType === 'metric') {
            return {
                value: text.length > 20 ? text.substring(0, 10) + '...' : text,
                label: `Metric ${idx + 1}`,
                icon: null // Will be filled by repair
            };
        } else if (expectedType === 'step') {
            return {
                number: idx + 1,
                title: text.length > 30 ? text.substring(0, 30) : text,
                description: text.length > 30 ? text : '',
                icon: null
            };
        } else { // item (icon-grid)
            return {
                label: text.length > 40 ? text.substring(0, 40) : text,
                icon: null
            };
        }
    }

    // Fallback for any other type
    return {
        label: `Item ${idx + 1}`,
        value: String(item ?? ''),
        icon: null
    };
}

/**
 * Deep-repairs JSON strings that might be nested in component data
 */
function deepParseJsonStrings(obj: any): any {
    if (typeof obj === 'string') {
        try {
            const parsed = JSON.parse(obj);
            return deepParseJsonStrings(parsed);
        } catch {
            return obj;
        }
    }
    if (Array.isArray(obj)) {
        return obj.map(item => deepParseJsonStrings(item));
    }
    if (typeof obj === 'object' && obj !== null) {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = deepParseJsonStrings(value);
        }
        return result;
    }
    return obj;
}

function autoRepairSlide(slide: SlideNode): SlideNode {
    const components = slide.layoutPlan?.components || [];
    const SAFE_ICONS = ['Activity', 'Zap', 'BarChart3', 'Box', 'Layers', 'PieChart', 'TrendingUp', 'Target', 'CheckCircle', 'Lightbulb'];

    const isGarbage = (text: string) => {
        if (!text || typeof text !== 'string' || text.length < 20) return false;
        const words = text.split(/\s+/);
        if (words.length > 5) {
            const uniqueWords = new Set(words.map(w => w.toLowerCase()));
            if (uniqueWords.size < words.length * 0.5) return true;
        }
        return false;
    };

    // STEP 1: Normalize component types (FIX: Handle undefined/null types)
    components.forEach((c: any, idx: number) => {
        // FIX: Handle undefined, null, or missing type
        if (!c.type || typeof c.type !== 'string') {
            console.warn(`[AUTO-REPAIR] Component ${idx} has undefined/invalid type, defaulting to 'text-bullets'`);
            c.type = 'text-bullets';

            // Try to extract content from any available property
            if (!c.content) {
                c.content = [];
                // Check common property names that might contain content
                const contentSources = ['text', 'body', 'paragraph', 'items', 'value', 'label', 'description'];
                for (const prop of contentSources) {
                    if (c[prop]) {
                        if (Array.isArray(c[prop])) {
                            c.content.push(...c[prop].map((x: any) => typeof x === 'string' ? x : JSON.stringify(x)));
                        } else if (typeof c[prop] === 'string') {
                            c.content.push(c[prop]);
                        }
                    }
                }
                if (c.content.length === 0) {
                    c.content = [`Content from component ${idx + 1}`];
                }
            }
        } else if (!SUPPORTED_COMPONENT_TYPES.includes(c.type)) {
            const mapped = COMPONENT_TYPE_MAP[c.type.toLowerCase()];
            if (mapped) {
                console.warn(`[AUTO-REPAIR] Mapping component type '${c.type}' -> '${mapped}'`);
                c.type = mapped;
            } else {
                // Unknown type - default to text-bullets and try to salvage content
                console.warn(`[AUTO-REPAIR] Unknown component type '${c.type}', converting to 'text-bullets'`);
                const oldType = c.type;
                c.type = 'text-bullets';

                // Try to extract content from various possible properties
                if (!c.content) {
                    c.content = [];
                    if (c.text) c.content.push(String(c.text));
                    if (c.body) c.content.push(String(c.body));
                    if (c.paragraph) c.content.push(String(c.paragraph));
                    if (c.content.length === 0) {
                        c.content = [`Content from ${oldType} component`];
                    }
                }
            }
        }
    });

    // STEP 2: Normalize and repair component data
    components.forEach((c: any) => {
        // Deep-parse any JSON strings in the component
        if (c.metrics) c.metrics = deepParseJsonStrings(c.metrics);
        if (c.steps) c.steps = deepParseJsonStrings(c.steps);
        if (c.items) c.items = deepParseJsonStrings(c.items);
        if (c.data) c.data = deepParseJsonStrings(c.data);

        if (c.type === 'metric-cards') {
            // Model might use 'items' or 'metrics' - normalize to 'metrics'
            let list: any[] = c.metrics || c.items || c.cards || [];
            if (!Array.isArray(list)) list = [list];

            // CRITICAL FIX: If array is empty, create placeholder metrics
            if (list.length === 0) {
                console.warn(`[AUTO-REPAIR] Empty metric-cards array, injecting placeholder metrics`);
                list = [
                    { value: 'N/A', label: 'Metric 1', icon: 'Activity' },
                    { value: 'N/A', label: 'Metric 2', icon: 'TrendingUp' }
                ];
            }

            // Normalize each item
            list = list.map((item, idx) => normalizeArrayItem(item, idx, 'metric'));

            // Repair icons and garbage
            list.forEach((item, idx) => {
                if (typeof item === 'object' && item !== null) {
                    if (!item.icon || item.icon === '' || item.icon === 'N/A') {
                        item.icon = SAFE_ICONS[idx % SAFE_ICONS.length];
                    }
                    if (item.label && isGarbage(item.label)) {
                        item.label = "Metric " + (idx + 1);
                    }
                    // Ensure value exists
                    if (!item.value) {
                        item.value = 'N/A';
                    }
                }
            });

            c.metrics = list;
            // Clean up alternative property names
            delete c.items;
            delete c.cards;
        }

        if (c.type === 'process-flow') {
            let list: any[] = c.steps || [];
            if (!Array.isArray(list)) list = [list];

            list = list.map((item, idx) => normalizeArrayItem(item, idx, 'step'));

            list.forEach((item, idx) => {
                if (typeof item === 'object' && item !== null) {
                    if (!item.icon || item.icon === '') {
                        item.icon = SAFE_ICONS[idx % SAFE_ICONS.length];
                    }
                    if (!item.number) item.number = idx + 1;
                    if (item.title && isGarbage(item.title)) {
                        item.title = "Step " + (idx + 1);
                    }
                }
            });

            c.steps = list;
        }

        if (c.type === 'icon-grid') {
            // Model might use 'icons' or 'features' - normalize to 'items'
            let list: any[] = c.items || c.icons || c.features || [];
            if (!Array.isArray(list)) list = [list];

            // CRITICAL FIX: If array is empty, create placeholder items
            if (list.length === 0) {
                console.warn(`[AUTO-REPAIR] Empty icon-grid array, injecting placeholder items`);
                list = [
                    { label: 'Feature 1', icon: 'Star' },
                    { label: 'Feature 2', icon: 'Zap' },
                    { label: 'Feature 3', icon: 'Shield' }
                ];
            }

            list = list.map((item, idx) => normalizeArrayItem(item, idx, 'item'));

            list.forEach((item, idx) => {
                if (typeof item === 'object' && item !== null) {
                    if (!item.icon || item.icon === '' || item.icon === 'N/A') {
                        item.icon = SAFE_ICONS[idx % SAFE_ICONS.length];
                    }
                    if (item.label && isGarbage(item.label)) {
                        item.label = "Feature " + (idx + 1);
                    }
                    // Ensure label exists
                    if (!item.label) {
                        item.label = "Feature " + (idx + 1);
                    }
                }
            });

            c.items = list;
            // Clean up alternative property names
            delete c.icons;
            delete c.features;
        }

        if (c.type === 'text-bullets') {
            // Ensure content is an array of strings
            if (!Array.isArray(c.content)) {
                if (typeof c.content === 'string') {
                    c.content = [c.content];
                } else {
                    c.content = [];
                }
            }

            const unique = new Set();
            const cleanContent: string[] = [];
            c.content.forEach((s: any) => {
                // Convert non-strings to strings
                let text = typeof s === 'string' ? s : JSON.stringify(s);
                let norm = text.trim();
                if (isGarbage(norm)) {
                    norm = norm.substring(0, 50) + "...";
                }
                const key = norm.toLowerCase();
                if (!unique.has(key) && norm.length > 0) {
                    unique.add(key);
                    cleanContent.push(norm);
                }
            });
            c.content = cleanContent.slice(0, 5);
        }

        if (c.type === 'chart-frame' && c.data) {
            // Normalize chart data
            if (!Array.isArray(c.data)) c.data = [];
            c.data = c.data.map((d: any, idx: number) => {
                if (typeof d === 'string') {
                    try {
                        return JSON.parse(d);
                    } catch {
                        return { label: d, value: (idx + 1) * 10 };
                    }
                }
                return d;
            }).filter((d: any) => d && typeof d.value === 'number');
        }
    });

    return slide;
}

// --- AGENT 1: RESEARCHER (with Tool Execution Loop) ---

async function runResearcher(topic: string, costTracker: CostTracker): Promise<ResearchFact[]> {
    console.log("[RESEARCHER] Starting research agent with Interactions API...");

    // Define tool implementations
    const tools: Record<string, Tool> = {
        web_search: {
            definition: webSearchTool,
            execute: async (args: { query: string }) => {
                // In production, this would call a real search API
                // For now, we use Google Search grounding in the model call
                return {
                    status: "delegated_to_model",
                    query: args.query,
                    note: "Search executed via Google Search grounding in model call"
                };
            }
        }
    };

    try {
        const result = await runAgentLoop(
            `Perform deep research on "${topic}".
      
      RESEARCH OBJECTIVES:
      1. Find 8-12 verified, high-impact facts and statistics
      2. Focus on: Market data, technical specifications, trends, and expert insights
      3. Prioritize recent information (last 2 years) when available
      
      OUTPUT REQUIREMENTS:
      Return a JSON array of research facts with this structure:
      [
        {
          "id": "fact-1",
          "category": "Market Trend | Technical Spec | Statistic | Expert Opinion",
          "claim": "The main factual claim",
          "value": "Specific numeric value if applicable",
          "source": "Source name or URL",
          "confidence": "high | medium | low"
        }
      ]
      
      CRITICAL: Return ONLY the JSON array. No preamble or markdown.`,
            {
                model: MODEL_FAST,
                systemInstruction: `You are a Lead Technical Researcher with expertise in finding and validating information.
        
        Your research must be:
        - ACCURATE: Only include verified facts from reliable sources
        - CURRENT: Prefer recent data when possible
        - SPECIFIC: Include concrete numbers, not vague claims
        - ATTRIBUTABLE: Always note the source
        
        Use Google Search grounding when you need current information.`,
                tools: {}, // Using built-in Google Search via grounding instead
                maxIterations: 5,
                thinkingLevel: 'low' as ThinkingLevel,
                temperature: 0.3,
                onToolCall: (name, args, result) => {
                    console.log(`[RESEARCHER] Tool called: ${name}`, args);
                }
            },
            costTracker
        );

        // Parse the JSON response
        try {
            const parsed = JSON.parse(result.text);
            if (Array.isArray(parsed)) return parsed;
            if (parsed.facts && Array.isArray(parsed.facts)) return parsed.facts;
            return [];
        } catch (parseErr) {
            console.warn("[RESEARCHER] JSON parse failed, attempting extraction...");
            // Try to extract JSON from the response
            const jsonMatch = result.text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                try {
                    return JSON.parse(jsonMatch[0]);
                } catch {
                    console.error("[RESEARCHER] Extraction failed");
                }
            }
            return [];
        }
    } catch (e: any) {
        console.error("[RESEARCHER] Agent failed:", e.message);
        return [];
    }
}

// --- AGENT 2: ARCHITECT ---

async function runArchitect(
    topic: string,
    facts: ResearchFact[],
    costTracker: CostTracker
): Promise<z.infer<typeof OutlineSchema>> {
    console.log("[ARCHITECT] Starting structure planning with Interactions API...");

    const factContext = facts.map(f => `[${f.id}] ${f.claim}`).join('\n');

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
      2. Create a 5-8 slide flow with clear narrative arc
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

// --- AGENT 3: ROUTER ---

async function runRouter(slideMeta: any, costTracker: CostTracker): Promise<RouterDecision> {
    console.log(`[ROUTER] Routing slide: "${slideMeta.title}"...`);

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
        const result = await createJsonInteraction<RouterDecision>(
            MODEL_SIMPLE,
            PROMPTS.ROUTER.TASK(slideMeta),
            routerSchema,
            {
                systemInstruction: PROMPTS.ROUTER.ROLE,
                temperature: 0.1 // Reduced for more deterministic routing
            },
            costTracker
        );

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

// --- AGENT 4: CONTENT PLANNER ---

async function runContentPlanner(
    meta: any,
    factsContext: string,
    costTracker: CostTracker
) {
    console.log(`[CONTENT PLANNER] Planning content for: "${meta.title}"...`);

    // NOTE: Schema flattened for consistency with Gemini Interactions API nesting limits.
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
        return await createJsonInteraction(
            MODEL_AGENTIC,
            PROMPTS.CONTENT_PLANNER.TASK(meta.title, meta.purpose, factsContext),
            contentPlanSchema,
            {
                systemInstruction: PROMPTS.CONTENT_PLANNER.ROLE,
                temperature: 0.2,
                maxOutputTokens: 2048
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

// --- AGENT 5: GENERATOR (Final Assembly with Agentic Loop) ---

async function runGenerator(
    meta: any,
    routerConfig: RouterDecision,
    contentPlan: any,
    visualDesignSpec: VisualDesignSpec | undefined,
    facts: ResearchFact[],
    factClusters: z.infer<typeof FactClusterSchema>[],
    costTracker: CostTracker
): Promise<SlideNode> {
    console.log(`[GENERATOR] Generating slide: "${meta.title}"...`);

    // BALANCED SCHEMA: Type is enforced, internals are loosened for autoRepairSlide to normalize
    const minimalGeneratorSchema = {
        type: "object",
        properties: {
            layoutPlan: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    background: { type: "string", enum: ["solid", "gradient", "image"] },
                    components: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string",
                                    enum: ["text-bullets", "metric-cards", "process-flow", "icon-grid", "chart-frame"]
                                },
                                title: { type: "string" },
                                // Loosen internals - autoRepairSlide normalizes these
                                content: { type: "array" },
                                metrics: { type: "array" },
                                steps: { type: "array" },
                                items: { type: "array" }
                            },
                            required: ["type"]  // Only type is strictly required
                        }
                    }
                },
                required: ["title", "components"]
            },
            speakerNotesLines: { type: "array", items: { type: "string" } },
            selfCritique: {
                type: "object",
                properties: {
                    readabilityScore: { type: "number" },
                    textDensityStatus: { type: "string" },
                    layoutAction: { type: "string" }
                }
            }
        },
        required: ["layoutPlan"]
    };

    const MAX_RETRIES = 2;
    let lastValidation: any = null;
    let generatorFailures = 0;

    // AGGRESSIVE PRE-TRUNCATION: Limit contentPlan size before prompt construction
    let safeContentPlan = { ...contentPlan };
    if (safeContentPlan.keyPoints && safeContentPlan.keyPoints.length > 5) {
        console.warn(`[GENERATOR] Truncating keyPoints from ${safeContentPlan.keyPoints.length} to 5`);
        safeContentPlan.keyPoints = safeContentPlan.keyPoints.slice(0, 5);
    }
    if (safeContentPlan.dataPoints && safeContentPlan.dataPoints.length > 4) {
        console.warn(`[GENERATOR] Truncating dataPoints from ${safeContentPlan.dataPoints.length} to 4`);
        safeContentPlan.dataPoints = safeContentPlan.dataPoints.slice(0, 4);
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const isRecoveryAttempt = attempt > 0;

            // TOKEN BUDGET: Start at 4096, increase slightly on retry but stay reasonable
            // NOTE: We do NOT escalate to MODEL_REASONING (Pro) because:
            // - Pro uses reasoning tokens that reduce output budget
            // - Flash is faster, cheaper, and equally capable for JSON generation
            const maxTokens = isRecoveryAttempt ? 6144 : 4096;

            // COMPACT component examples - minimal tokens, maximum clarity
            const componentExamples = `
COMPONENTS (use EXACT type names):
- "text-bullets": {"content": ["point 1", "point 2"]}
- "metric-cards": {"metrics": [{"value": "85%", "label": "Growth", "icon": "TrendingUp"}]}
- "process-flow": {"steps": [{"number": 1, "title": "Step", "icon": "Zap"}]}
- "icon-grid": {"items": [{"label": "Feature", "icon": "Star"}]}
Max 3 components. Keep JSON short.`;

            let basePrompt: string;
            if (isRecoveryAttempt && lastValidation?.errors) {
                // Compact repair prompt
                const errorSummary = lastValidation.errors.slice(0, 2).map((e: any) => e.message).join('; ');
                basePrompt = `Fix these errors: ${errorSummary}\n\nContent: ${JSON.stringify(safeContentPlan)}`;
            } else {
                basePrompt = PROMPTS.VISUAL_DESIGNER.TASK(JSON.stringify(safeContentPlan), routerConfig, visualDesignSpec);
            }

            const prompt = `${basePrompt}\n\n${componentExamples}`;

            // Always use MODEL_AGENTIC (Flash) - it's faster and doesn't truncate
            const raw = await createJsonInteraction(
                MODEL_AGENTIC,  // ALWAYS Flash - never escalate to Pro
                prompt,
                minimalGeneratorSchema,
                {
                    systemInstruction: PROMPTS.VISUAL_DESIGNER.ROLE,
                    temperature: isRecoveryAttempt ? 0.0 : 0.1,
                    maxOutputTokens: maxTokens
                },
                costTracker
            );

            if (!raw || !raw.layoutPlan) {
                throw new Error("Invalid generator output: missing layoutPlan");
            }

            let candidate: SlideNode = {
                order: meta.order || 0,
                type: meta.type as any,
                title: raw.layoutPlan?.title || meta.title,
                purpose: meta.purpose,
                routerConfig,
                layoutPlan: raw.layoutPlan,
                visualReasoning: "Generated via Interactions API",
                visualPrompt: "",
                visualDesignSpec,
                speakerNotesLines: raw.speakerNotesLines || [],
                citations: [],
                chartSpec: raw.chartSpec,
                selfCritique: raw.selfCritique,
                readabilityCheck: 'pass',
                validation: undefined,
                warnings: []
            };

            // Auto-add chart frame if needed
            if (candidate.type === 'data-viz' && candidate.chartSpec && candidate.layoutPlan?.components) {
                const hasFrame = candidate.layoutPlan.components.some((c: any) => c.type === 'chart-frame');
                if (!hasFrame) {
                    candidate.layoutPlan.components.push({
                        type: 'chart-frame',
                        title: candidate.chartSpec.title || "Data Analysis",
                        chartType: (['bar', 'pie', 'doughnut', 'line'].includes(candidate.chartSpec.type) ? candidate.chartSpec.type : 'bar') as any,
                        data: candidate.chartSpec.data
                    });
                }
            }

            candidate = autoRepairSlide(candidate);
            const validation = validateSlide(candidate);

            // Merge Visual Alignment Validation
            if (visualDesignSpec) {
                const alignment = validateVisualLayoutAlignment(visualDesignSpec, routerConfig, candidate.layoutPlan);
                if (!alignment.passed || alignment.errors.length > 0) {
                    validation.errors.push(...alignment.errors);
                    validation.score = Math.min(validation.score, alignment.score);
                    // If visual alignment fails critically, should we fail the slide?
                    // For now, we treated it as soft warnings in visual agent, but here let's valid it formally.
                    if (!alignment.passed) validation.passed = false;
                }
            }

            lastValidation = validation;

            if (validation.passed) {
                candidate.validation = validation;
                return candidate;
            }

            console.warn(`[GENERATOR] Validation failed (attempt ${attempt + 1}):`, validation.errors);
            generatorFailures++;

        } catch (e: any) {
            console.error(`[GENERATOR] Error (attempt ${attempt + 1}):`, e.message);
            generatorFailures++;

            // CIRCUIT BREAKER: If we've failed too many times, skip further attempts
            if (generatorFailures > 2) {
                console.warn(`[GENERATOR] Circuit breaker triggered after ${generatorFailures} failures`);
                break;
            }
        }
    }

    // Fallback: Use text-bullets only for maximum reliability
    console.warn(`[GENERATOR] All attempts exhausted. Using text-bullets fallback.`);
    return {
        order: meta.order || 0,
        type: meta.type as any,
        title: meta.title,
        purpose: meta.purpose,
        routerConfig,
        layoutPlan: {
            title: meta.title,
            background: 'solid',
            components: [{
                type: 'text-bullets',
                title: "Key Insights",
                content: safeContentPlan.keyPoints || contentPlan.keyPoints || ["Data unavailable."],
                style: 'standard'
            }]
        },
        visualReasoning: "Fallback (circuit breaker)",
        visualPrompt: "",
        visualDesignSpec,
        speakerNotesLines: [`Fallback due to ${generatorFailures} generation failures.`],
        readabilityCheck: 'warning',
        citations: [],
        warnings: lastValidation?.errors?.map((e: any) => e.message) || ["Generation failed after max retries"]
    };
}

// --- IMAGE GENERATION (Still uses generateContent for image modality) ---

const NEGATIVE_PROMPT_INFO = "photorealistic, 3d render, messy, clutter, blurry, low resolution, distorted text, bad layout, sketch, hand drawn, organic textures, grunge, footer text, copyright notice, watermark, template borders, frame, mock-up, padding, margins";

export async function generateImageFromPrompt(
    prompt: string,
    aspectRatio: string = "16:9",
    costTracker?: CostTracker
): Promise<{ imageUrl: string, model: string } | null> {
    const ai = getAiClient();
    const models = ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image'];

    const richPrompt = `
  SUBJECT: ${prompt}
  CONTEXT: Professional Presentation Slide Background.
  STYLE: High-fidelity, cinematic lighting, corporate aesthetic.
  CONSTRAINT: Ensure substantial negative space or low contrast areas for overlay text. 
  NEGATIVE: ${NEGATIVE_PROMPT_INFO}
  `;

    for (const modelName of models) {
        try {
            const response = await ai.models.generateContent({
                model: modelName,
                contents: { parts: [{ text: richPrompt }] },
                config: {
                    imageConfig: { aspectRatio },
                    responseModalities: [Modality.IMAGE]
                }
            });

            if (response.candidates?.[0]?.content?.parts) {
                for (const part of response.candidates[0].content.parts) {
                    if (part.inlineData?.data) {
                        if (costTracker) {
                            costTracker.addImageCost(modelName);
                        }
                        return {
                            imageUrl: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`,
                            model: modelName
                        };
                    }
                }
            }
        } catch (e: any) {
            const isQuota = e.status === 429 || (e.message && (e.message.includes('429') || e.message.includes('quota')));
            if (isQuota && modelName !== models[models.length - 1]) {
                console.warn(`Quota exceeded for ${modelName}, switching to next model...`);
                continue;
            }
            console.error(`Failed to generate image with ${modelName}`, e.message);
            if (modelName === models[models.length - 1]) return null;
        }
    }
    return null;
}

// --- ORCHESTRATOR ---

export const generateAgenticDeck = async (
    topic: string,
    onProgress: (status: string, percent?: number) => void
): Promise<EditableSlideDeck> => {
    const costTracker = new CostTracker();
    const startTime = Date.now();

    console.log("[ORCHESTRATOR] Starting agentic deck generation with Interactions API...");
    console.log(`[ORCHESTRATOR] Max iterations per agent: ${MAX_AGENT_ITERATIONS}`);

    // 1. RESEARCH PHASE
    onProgress("Agent 1/5: Deep Research (Interactions API)...", 10);
    const facts = await runResearcher(topic, costTracker);
    console.log(`[ORCHESTRATOR] Research complete: ${facts.length} facts found`);

    // 2. ARCHITECTURE PHASE
    onProgress("Agent 2/5: Structuring Narrative...", 25);
    const outline = await runArchitect(topic, facts, costTracker);
    console.log(`[ORCHESTRATOR] Architecture complete: ${outline.slides.length} slides planned`);

    const slides: SlideNode[] = [];
    const totalSlides = outline.slides.length;

    // 3. PER-SLIDE GENERATION with Error Boundary
    for (let i = 0; i < totalSlides; i++) {
        const slideMeta = outline.slides[i];

        try {
            console.log(`[ORCHESTRATOR] Processing slide ${i + 1}/${totalSlides}: "${slideMeta.title}"`);

            // 3a. Route Layout
            onProgress(`Agent 3/5: Routing Slide ${i + 1}/${totalSlides}...`, 30 + Math.floor((i / (totalSlides * 2)) * 30));
            const routerConfig = await runRouter(slideMeta, costTracker);

            // 3b. Plan Content
            const clusterIds = slideMeta.relevantClusterIds || [];
            const relevantClusterFacts: string[] = [];
            if (clusterIds.length > 0 && outline.factClusters) {
                clusterIds.forEach((cid: string) => {
                    const cluster = outline.factClusters?.find(c => c.id === cid);
                    if (cluster && cluster.factIds) {
                        cluster.factIds.forEach(fid => {
                            const f = facts.find(fact => fact.id === fid);
                            if (f) relevantClusterFacts.push(`[${f.id}] ${f.claim}`);
                        });
                    }
                });
            }
            const factsContext = relevantClusterFacts.join('\n') || "No specific facts found.";

            onProgress(`Agent 3b/5: Content Planning Slide ${i + 1}...`, 32 + Math.floor((i / (totalSlides * 2)) * 30));
            const contentPlan = await runContentPlanner(slideMeta, factsContext, costTracker);

            // 3c. Visual Design (using Interactions API)
            onProgress(`Agent 3c/5: Visual Design Slide ${i + 1}...`, 34 + Math.floor((i / (totalSlides * 2)) * 30));
            const visualDesign = await runVisualDesigner(
                slideMeta.title,
                contentPlan,
                routerConfig,
                facts,
                costTracker // Use actual cost tracker for proper metrics
            );

            // 3d. Final Generation
            onProgress(`Agent 4/5: Generating Slide ${i + 1}...`, 40 + Math.floor((i / (totalSlides * 2)) * 40));
            const slideNode = await runGenerator(
                slideMeta,
                routerConfig,
                contentPlan,
                visualDesign,
                facts,
                outline.factClusters || [],
                costTracker
            );

            // 3e. Image Generation
            const finalVisualPrompt = visualDesign.prompt_with_composition || `${slideNode.title} professional abstract background`;
            slideNode.visualPrompt = finalVisualPrompt;

            if (finalVisualPrompt) {
                onProgress(`Agent 5/5: Rendering Visual ${i + 1}...`, 60 + Math.floor((i / totalSlides) * 40));
                const imgResult = await generateImageFromPrompt(finalVisualPrompt, "16:9", costTracker);
                if (imgResult) {
                    slideNode.backgroundImageUrl = imgResult.imageUrl;
                }
            }
            slides.push(slideNode);

        } catch (slideError: any) {
            // --- ERROR BOUNDARY: Create fallback slide instead of failing entire deck ---
            console.error(`[ORCHESTRATOR] Slide ${i + 1} failed, using fallback:`, slideError.message);

            const fallbackSlide: SlideNode = {
                order: slideMeta.order || i,
                type: slideMeta.type as any,
                title: slideMeta.title,
                purpose: slideMeta.purpose,
                routerConfig: {
                    renderMode: 'standard',
                    layoutVariant: 'standard-vertical',
                    layoutIntent: 'Fallback due to error',
                    densityBudget: { maxChars: 500, maxItems: 5, minVisuals: 0 },
                    visualFocus: 'Content'
                },
                layoutPlan: {
                    title: slideMeta.title,
                    background: 'solid',
                    components: [{
                        type: 'text-bullets',
                        title: 'Content',
                        content: ['Slide content could not be generated.', 'Please edit this slide manually.'],
                        style: 'standard'
                    }]
                },
                visualReasoning: 'Fallback due to generation error',
                visualPrompt: `${slideMeta.title} professional abstract background`,
                speakerNotesLines: [`Slide generation failed: ${slideError.message}`],
                readabilityCheck: 'warning',
                citations: [],
                warnings: [`Generation failed: ${slideError.message}`]
            };

            slides.push(fallbackSlide);
        }
    }

    onProgress("Finalizing Deck...", 100);

    const totalDurationMs = Date.now() - startTime;
    const costSummary = costTracker.getSummary();

    console.log("[ORCHESTRATOR] Generation complete!");
    console.log(`[ORCHESTRATOR] Duration: ${(totalDurationMs / 1000).toFixed(1)}s`);
    console.log(`[ORCHESTRATOR] Total Cost: $${costSummary.totalCost.toFixed(4)}`);
    console.log(`[ORCHESTRATOR] 💰 Savings vs Pro: $${costSummary.totalSavingsVsPro.toFixed(4)} (${((costSummary.totalSavingsVsPro / (costSummary.totalCost + costSummary.totalSavingsVsPro)) * 100).toFixed(0)}%)`);
    console.log(`[ORCHESTRATOR] Tokens: ${costSummary.totalInputTokens} in, ${costSummary.totalOutputTokens} out`);
    console.log(`[ORCHESTRATOR] Model Breakdown:`, costSummary.modelBreakdown);

    return {
        id: crypto.randomUUID(),
        topic,
        meta: outline,
        slides,
        metrics: {
            totalDurationMs,
            retries: 0,
            totalCost: costSummary.totalCost
        }
    };
};

// --- SINGLE SLIDE REGENERATION ---

export const regenerateSingleSlide = async (
    meta: any,
    currentSlide: SlideNode,
    facts: ResearchFact[],
    factClusters: z.infer<typeof FactClusterSchema>[] = []
): Promise<SlideNode> => {
    const costTracker = new CostTracker();

    const routerConfig = await runRouter(meta, costTracker);
    const contentPlan = await runContentPlanner(meta, "", costTracker);
    const visualDesign = await runVisualDesigner(
        meta.title,
        contentPlan,
        routerConfig,
        facts,
        costTracker // Use actual cost tracker
    );

    const newSlide = await runGenerator(meta, routerConfig, contentPlan, visualDesign, facts, factClusters, costTracker);

    newSlide.visualPrompt = visualDesign.prompt_with_composition;

    if (newSlide.visualPrompt) {
        const imgResult = await generateImageFromPrompt(newSlide.visualPrompt, "16:9", costTracker);
        if (imgResult) {
            newSlide.backgroundImageUrl = imgResult.imageUrl;
        }
    }
    return newSlide;
};
