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
    FactClusterSchema, VisualDesignSpec, ValidationResult,
    // Level 3 Agentic Stack Types
    NarrativeTrail, RouterConstraints, GeneratorResult, DeckMetrics,
    // System 2 Visual Critique
    VISUAL_THRESHOLDS
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
import { validateSlide, validateVisualLayoutAlignment, validateGeneratorCompliance, validateDeckCoherence } from "./validators";
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

export function autoRepairSlide(slide: SlideNode): SlideNode {
    // --- LAYER 5: Top-level field normalization (zero-cost rescue) ---

    // Fix malformed selfCritique (model outputs prose in layoutAction instead of enum)
    if (slide.selfCritique) {
        if (typeof slide.selfCritique === 'string') {
            // Model returned string instead of object
            console.warn(`[AUTO-REPAIR] selfCritique was string, converting to object`);
            slide.selfCritique = {
                layoutAction: 'keep',
                readabilityScore: 8,
                textDensityStatus: 'optimal' as any
            };
        } else {
            // Validate/normalize fields
            const sc = slide.selfCritique as any;

            // layoutAction: If prose text, extract intent or default to 'keep'
            if (sc.layoutAction && typeof sc.layoutAction === 'string') {
                const action = sc.layoutAction.toLowerCase();
                if (action.includes('simplif')) sc.layoutAction = 'simplify' as any;
                else if (action.includes('shrink') || action.includes('reduce')) sc.layoutAction = 'shrink_text' as any;
                else if (action.includes('visual') || action.includes('add')) sc.layoutAction = 'add_visuals' as any;
                else if (!['keep', 'simplify', 'shrink_text', 'add_visuals'].includes(action)) {
                    console.warn(`[AUTO-REPAIR] layoutAction was prose: "${sc.layoutAction.slice(0, 50)}...", defaulting to 'keep'`);
                    sc.layoutAction = 'keep' as any;
                }
            } else {
                sc.layoutAction = 'keep' as any;
            }

            // readabilityScore: Ensure number 0-10
            if (typeof sc.readabilityScore !== 'number' || sc.readabilityScore < 0 || sc.readabilityScore > 10) {
                sc.readabilityScore = 8;
            }

            // textDensityStatus: Normalize to enum
            if (sc.textDensityStatus && typeof sc.textDensityStatus === 'string') {
                const status = sc.textDensityStatus.toLowerCase();
                if (status.includes('optim')) sc.textDensityStatus = 'optimal' as any;
                else if (status.includes('high') || status.includes('dens')) sc.textDensityStatus = 'high' as any;
                else if (status.includes('over')) sc.textDensityStatus = 'overflow' as any;
                else sc.textDensityStatus = 'optimal' as any;
            } else {
                sc.textDensityStatus = 'optimal' as any;
            }
        }
    }

    // Fix missing/malformed speakerNotesLines (model sometimes outputs "" or garbage)
    if (!slide.speakerNotesLines || !Array.isArray(slide.speakerNotesLines)) {
        console.warn(`[AUTO-REPAIR] speakerNotesLines missing or invalid, generating default`);
        slide.speakerNotesLines = [`Slide: ${slide.title || 'Content'}`];
    } else {
        // Filter out empty strings and garbage entries
        slide.speakerNotesLines = slide.speakerNotesLines
            .filter((line: any) => typeof line === 'string' && line.trim().length > 0)
            .slice(0, 5); // Limit to 5 notes

        if (slide.speakerNotesLines.length === 0) {
            slide.speakerNotesLines = [`Slide: ${slide.title || 'Content'}`];
        }
    }

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

// --- AGENT 3: ROUTER (Phase 3: Circuit Breaker Support) ---

/**
 * Router with Circuit Breaker Constraints
 * @param slideMeta - Slide metadata from architect
 * @param costTracker - Cost tracking
 * @param constraints - Optional constraints for rerouting (avoidLayoutVariants)
 */
async function runRouter(
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
        const result = await createJsonInteraction<RouterDecision>(
            MODEL_SIMPLE,
            PROMPTS.ROUTER.TASK(slideMeta, constraints),
            routerSchema,
            {
                systemInstruction: PROMPTS.ROUTER.ROLE,
                temperature: 0.1 // Reduced for more deterministic routing
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

// --- AGENT 4: CONTENT PLANNER (Phase 1: Context Folding) ---

/**
 * Content Planner with Narrative History
 * @param meta - Slide metadata
 * @param factsContext - Relevant facts for this slide
 * @param costTracker - Cost tracking
 * @param recentHistory - Last 2 slides for narrative arc awareness (Phase 1 Context Folding)
 */
async function runContentPlanner(
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
            PROMPTS.CONTENT_PLANNER.TASK(meta.title, meta.purpose, factsContext, recentHistory),
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

// --- SYSTEM 2: RECURSIVE VISUAL CRITIQUE ---

/**
 * Runs recursive visual critique loop on a slide candidate.
 * Implements bounded recursion (MAX_ROUNDS=3) with score-based convergence.
 *
 * @param candidate - Slide to critique
 * @param validation - Initial validation result
 * @param costTracker - Cost tracking
 * @param styleGuide - Global style guide for SVG rendering
 * @returns Enhanced result with rounds, finalScore, repairSucceeded
 */
async function runRecursiveVisualCritique(
    candidate: SlideNode,
    validation: ValidationResult,
    costTracker: CostTracker,
    styleGuide: GlobalStyleGuide
): Promise<{
    slide: SlideNode;
    rounds: number;
    finalScore: number;
    repairSucceeded: boolean;
    system2Cost: number;
    system2InputTokens: number;
    system2OutputTokens: number;
}> {
    const MAX_VISUAL_ROUNDS = 3;
    const MIN_IMPROVEMENT_DELTA = 5; // Require meaningful improvement

    // Capture cost before System 2 operations
    const preSystem2Summary = costTracker.getSummary();
    const preSystem2Cost = preSystem2Summary.totalCost;
    const preSystem2InputTokens = preSystem2Summary.totalInputTokens;
    const preSystem2OutputTokens = preSystem2Summary.totalOutputTokens;

    // Import visual cortex functions
    const { generateSvgProxy, runVisualCritique, runLayoutRepair } = await import('./visualDesignAgent');

    let currentSlide = candidate;
    let currentValidation = validation;
    let round = 0;
    let repairSucceeded = false;

    // GAP 9: Issue Persistence Tracking
    // Track issue categories across rounds to detect unfixable issues
    const issueHistory = new Map<string, number>(); // category -> count

    while (round < MAX_VISUAL_ROUNDS && currentValidation.score < VISUAL_THRESHOLDS.TARGET) {
        round++;
        console.log(`[SYSTEM 2] Visual critique round ${round}/${MAX_VISUAL_ROUNDS} (score: ${currentValidation.score})...`);

        try {
            // Generate SVG proxy from current slide state
            const svgProxy = generateSvgProxy(currentSlide, styleGuide);

            // Run visual critique
            const critique = await runVisualCritique(currentSlide, svgProxy, costTracker);

            // Check if critique score meets target
            if (critique.overallScore >= VISUAL_THRESHOLDS.TARGET) {
                console.log(`[SYSTEM 2] Critique passed (score: ${critique.overallScore}), exiting loop`);
                break;
            }

            // GAP 9: Track issue persistence
            critique.issues.forEach(issue => {
                const count = issueHistory.get(issue.category) || 0;
                issueHistory.set(issue.category, count + 1);
            });

            // Check for persistent issues (same category appears 2+ times)
            const persistentIssues = Array.from(issueHistory.entries())
                .filter(([_, count]) => count >= 2)
                .map(([category]) => category);

            if (persistentIssues.length > 0 && round >= 2) {
                console.warn(`[SYSTEM 2] Persistent issues detected after ${round} rounds: ${persistentIssues.join(', ')}`);
                console.warn(`[SYSTEM 2] These issues may be unfixable at current layout, exiting critique loop`);

                currentSlide.warnings = [
                    ...(currentSlide.warnings || []),
                    `Persistent visual issues after ${round} repair attempts: ${persistentIssues.join(', ')}`
                ];
                break;
            }

            // Determine if repair is needed based on thresholds
            const needsRepair = critique.hasCriticalIssues ||
                               critique.overallScore < VISUAL_THRESHOLDS.REPAIR_REQUIRED;

            if (needsRepair) {
                console.warn(`[SYSTEM 2] Repair needed (score: ${critique.overallScore}, critical: ${critique.hasCriticalIssues})`);

                // Run layout repair
                const repairedCandidate = await runLayoutRepair(
                    currentSlide,
                    critique,
                    svgProxy,
                    costTracker
                );

                // Apply deterministic repair normalization
                const normalizedRepair = autoRepairSlide(repairedCandidate);

                // Re-validate repaired candidate
                const repairedValidation = validateSlide(normalizedRepair);

                // Check if repair improved the score meaningfully
                const improvement = repairedValidation.score - currentValidation.score;
                const meetsMinImprovement = improvement >= MIN_IMPROVEMENT_DELTA;
                const crossedThreshold = currentValidation.score < VISUAL_THRESHOLDS.REPAIR_REQUIRED &&
                                       repairedValidation.score >= VISUAL_THRESHOLDS.REPAIR_REQUIRED;

                if (repairedValidation.passed &&
                    (meetsMinImprovement || crossedThreshold)) {
                    console.log(`[SYSTEM 2] Repair succeeded (${currentValidation.score} → ${repairedValidation.score}, Δ=${improvement})`);
                    currentSlide = normalizedRepair;
                    currentValidation = repairedValidation;
                    repairSucceeded = true;

                    // Re-generate SVG proxy for next iteration (if any)
                    // This happens at the start of the next loop iteration
                } else {
                    console.warn(`[SYSTEM 2] Repair did not improve slide (Δ=${improvement}), keeping original`);
                    // Keep current slide, exit loop
                    break;
                }
            } else {
                // Score between REPAIR_REQUIRED and TARGET - informational only
                console.log(`[SYSTEM 2] Critique identified ${critique.issues.length} issues but no repair needed`);
                currentSlide.warnings = [
                    ...(currentSlide.warnings || []),
                    `Visual critique: ${critique.issues.length} issues (score: ${critique.overallScore})`
                ];
                break;
            }

        } catch (critiqueErr: any) {
            console.error(`[SYSTEM 2] Round ${round} error:`, critiqueErr.message);
            currentSlide.warnings = [
                ...(currentSlide.warnings || []),
                `Visual critique round ${round} failed: ${critiqueErr.message}`
            ];
            // Continue to next round or exit
            if (round >= MAX_VISUAL_ROUNDS) break;
        }
    }

    // Final summary
    if (round >= MAX_VISUAL_ROUNDS && currentValidation.score < VISUAL_THRESHOLDS.TARGET) {
        console.warn(`[SYSTEM 2] Max rounds reached (${MAX_VISUAL_ROUNDS}), final score: ${currentValidation.score}`);
    } else if (currentValidation.score >= VISUAL_THRESHOLDS.TARGET) {
        console.log(`[SYSTEM 2] Converged to target score (${currentValidation.score})`);
    }

    // Calculate System 2 cost impact
    const postSystem2Summary = costTracker.getSummary();
    const system2Cost = postSystem2Summary.totalCost - preSystem2Cost;
    const system2InputTokens = postSystem2Summary.totalInputTokens - preSystem2InputTokens;
    const system2OutputTokens = postSystem2Summary.totalOutputTokens - preSystem2OutputTokens;

    console.log(`[SYSTEM 2] Cost: $${system2Cost.toFixed(4)} (${system2InputTokens} in, ${system2OutputTokens} out)`);

    return {
        slide: currentSlide,
        rounds: round,
        finalScore: currentValidation.score,
        repairSucceeded,
        system2Cost,
        system2InputTokens,
        system2OutputTokens
    };
}

// --- AGENT 5: GENERATOR (Phase 1+3: Context Folding + Circuit Breaker) ---

/**
 * Generator with Self-Healing Circuit Breaker
 * Returns GeneratorResult with needsReroute flag for reliability-targeted self-healing.
 *
 * @param meta - Slide metadata
 * @param routerConfig - Router decision (layout, density, etc.)
 * @param contentPlan - Content plan from planner
 * @param visualDesignSpec - Visual design spec (optional)
 * @param facts - Research facts
 * @param factClusters - Fact clusters from architect
 * @param styleGuide - Global style guide for visual rendering
 * @param costTracker - Cost tracking
 * @param recentHistory - Phase 1: Recent narrative history for context folding
 */
async function runGenerator(
    meta: any,
    routerConfig: RouterDecision,
    contentPlan: any,
    visualDesignSpec: VisualDesignSpec | undefined,
    facts: ResearchFact[],
    factClusters: z.infer<typeof FactClusterSchema>[],
    styleGuide: GlobalStyleGuide,
    costTracker: CostTracker,
    recentHistory?: NarrativeTrail[]
): Promise<GeneratorResult> {
    console.log(`[GENERATOR] Generating slide: "${meta.title}"...`);
    if (recentHistory?.length) {
        console.log(`[GENERATOR] Narrative context: ${recentHistory.length} previous slides`);
    }

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
                    // Enum constraints prevent model from outputting prose
                    textDensityStatus: {
                        type: "string",
                        enum: ["optimal", "high", "overflow"]
                    },
                    layoutAction: {
                        type: "string",
                        enum: ["keep", "simplify", "shrink_text", "add_visuals"]
                    }
                }
            }
        },
        required: ["layoutPlan"]
    };

    const MAX_RETRIES = 2;
    let lastValidation: any = null;
    let generatorFailures = 0;

    // AGGRESSIVE PRE-TRUNCATION: Limit contentPlan size before prompt construction
    // Reduced limits to prevent token exhaustion causing "o0o0o0" degeneration
    let safeContentPlan = { ...contentPlan };
    if (safeContentPlan.keyPoints && safeContentPlan.keyPoints.length > 4) {
        console.warn(`[GENERATOR] Truncating keyPoints from ${safeContentPlan.keyPoints.length} to 4`);
        safeContentPlan.keyPoints = safeContentPlan.keyPoints.slice(0, 4);
    }
    if (safeContentPlan.dataPoints && safeContentPlan.dataPoints.length > 3) {
        console.warn(`[GENERATOR] Truncating dataPoints from ${safeContentPlan.dataPoints.length} to 3`);
        safeContentPlan.dataPoints = safeContentPlan.dataPoints.slice(0, 3);
    }
    // Truncate individual key points if too long (prevent verbose LLM inputs)
    if (safeContentPlan.keyPoints) {
        safeContentPlan.keyPoints = safeContentPlan.keyPoints.map((kp: string) =>
            kp.length > 150 ? kp.slice(0, 147) + '...' : kp
        );
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const isRecoveryAttempt = attempt > 0;

            // TOKEN BUDGET: Start at 5120, increase on retry to prevent "o0o0o0" truncation
            // NOTE: We do NOT escalate to MODEL_REASONING (Pro) because:
            // - Pro uses reasoning tokens that reduce output budget
            // - Flash is faster, cheaper, and equally capable for JSON generation
            const maxTokens = isRecoveryAttempt ? 7168 : 5120;

            // ULTRA-COMPACT component examples - minimize prompt tokens to maximize output budget
            const componentExamples = `TYPES: text-bullets, metric-cards, process-flow, icon-grid, chart-frame
MAX 2 COMPONENTS. Keep arrays short (2-3 items max).
selfCritique: {"readabilityScore":8,"textDensityStatus":"optimal","layoutAction":"keep"}`;

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

            // GAP 1: Content-Intent Alignment Validation
            // Validate that Generator honored Router's decisions
            const complianceValidation = validateGeneratorCompliance(candidate, routerConfig);
            if (!complianceValidation.passed || complianceValidation.errors.length > 0) {
                validation.errors.push(...complianceValidation.errors);
                validation.score = Math.min(validation.score, complianceValidation.score);
                if (!complianceValidation.passed) {
                    validation.passed = false;
                    console.warn(`[GENERATOR] Compliance validation failed (score: ${complianceValidation.score}):`,
                        complianceValidation.errors.map(e => e.code).join(', '));
                }
            }

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

            // --- SYSTEM 2: RECURSIVE VISUAL CRITIQUE LOOP ---
            // Run recursive visual critique if validation passed but score < TARGET threshold
            // This catches spatial issues that text-based validation misses
            const VISUAL_REPAIR_ENABLED = true;

            let visualCritiqueRan = false;
            let visualRepairAttempted = false;
            let visualRepairSucceeded = false;
            let system2Rounds = 0;
            let system2Cost = 0;
            let system2InputTokens = 0;
            let system2OutputTokens = 0;

            if (VISUAL_REPAIR_ENABLED && validation.passed && validation.score < VISUAL_THRESHOLDS.TARGET) {
                console.log(`[GENERATOR] Entering System 2 recursive critique (score: ${validation.score})...`);
                visualCritiqueRan = true;

                try {
                    const system2Result = await runRecursiveVisualCritique(
                        candidate,
                        validation,
                        costTracker,
                        styleGuide
                    );

                    // Update candidate with System 2 result
                    candidate = system2Result.slide;
                    system2Rounds = system2Result.rounds;
                    visualRepairSucceeded = system2Result.repairSucceeded;
                    visualRepairAttempted = system2Result.rounds > 0;
                    system2Cost = system2Result.system2Cost;
                    system2InputTokens = system2Result.system2InputTokens;
                    system2OutputTokens = system2Result.system2OutputTokens;

                    // Update validation with final score
                    candidate.validation = validateSlide(candidate);
                    lastValidation = candidate.validation;

                    console.log(`[GENERATOR] System 2 complete: ${system2Rounds} rounds, final score: ${system2Result.finalScore}, cost: $${system2Result.system2Cost.toFixed(4)}`);

                } catch (critiqueErr: any) {
                    // Don't block on visual critique errors - graceful degradation
                    console.error(`[GENERATOR] System 2 critique error:`, critiqueErr.message);
                    candidate.warnings = [...(candidate.warnings || []), `Visual critique skipped: ${critiqueErr.message}`];
                }
            }

            if (validation.passed) {
                candidate.validation = validation;
                // Phase 3: Return GeneratorResult with successful slide
                return {
                    slide: candidate,
                    needsReroute: false,
                    visualCritiqueRan,
                    visualRepairAttempted,
                    visualRepairSucceeded,
                    system2Cost,
                    system2InputTokens,
                    system2OutputTokens
                };
            }

            // Phase 3: Check for critical errors that warrant rerouting
            // GAP 1: Include compliance errors as reroute triggers
            const criticalErrors = validation.errors.filter(e =>
                e.code === 'ERR_TEXT_OVERFLOW_CRITICAL' ||
                e.code === 'ERR_MISSING_VISUALS_CRITICAL' ||
                e.code === 'ERR_LAYOUT_MISMATCH_CRITICAL' ||
                e.code === 'ERR_DENSITY_CRITICAL_EXCEEDED' ||
                e.code === 'ERR_TOO_MANY_COMPONENTS' ||
                e.code === 'ERR_ITEM_COUNT_CRITICAL'
            );

            if (criticalErrors.length > 0 && attempt === MAX_RETRIES) {
                // Instead of falling back immediately, signal reroute opportunity
                console.warn(`[GENERATOR] Critical errors detected, signaling reroute: ${criticalErrors.map(e => e.code).join(', ')}`);
                return {
                    slide: candidate,
                    needsReroute: true,
                    rerouteReason: criticalErrors[0].code,
                    avoidLayoutVariants: [routerConfig.layoutVariant],
                    visualCritiqueRan,
                    visualRepairAttempted,
                    visualRepairSucceeded,
                    system2Cost,
                    system2InputTokens,
                    system2OutputTokens
                };
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
    const fallbackSlide: SlideNode = {
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

    // Phase 3: Return fallback with needsReroute = false (no more attempts)
    return {
        slide: fallbackSlide,
        needsReroute: false,
        visualCritiqueRan: false,
        visualRepairAttempted: false,
        visualRepairSucceeded: false,
        system2Cost: 0,
        system2InputTokens: 0,
        system2OutputTokens: 0
    };
}

// --- IMAGE GENERATION (Still uses generateContent for image modality) ---

// CRITICAL: Background images must NOT contain any content elements.
// Text, icons, diagrams, charts are rendered separately by SpatialLayoutEngine.
const NEGATIVE_PROMPT_INFO = `
photorealistic, 3d render, messy, clutter, blurry, low resolution, 
distorted text, bad layout, sketch, hand drawn, organic textures, grunge,
footer text, copyright notice, watermark, template borders, frame, mock-up, 
padding, margins,
TEXT, WORDS, LETTERS, LABELS, NUMBERS, CAPTIONS, TITLES, HEADINGS,
DIAGRAMS, CHARTS, GRAPHS, PIE CHARTS, BAR CHARTS, FLOWCHARTS, ARROWS,
ICONS, SYMBOLS, LOGOS, UI ELEMENTS, BUTTONS, BOXES, RECTANGLES WITH TEXT,
INFOGRAPHICS, DATA VISUALIZATIONS, PROCESS FLOWS, TIMELINES,
PEOPLE, FACES, HANDS, HUMANS, FIGURES
`.trim().replace(/\n/g, ' ');

// Image model configuration:
// - Default to 2.5 Flash Image: 71% cheaper ($0.039 vs $0.134 per image)
// - Visual prompts are short (no long text generation), Flash is sufficient
// - Pro is fallback for quota/quality issues
const IMAGE_MODELS = {
    DEFAULT: 'gemini-2.5-flash-image',      // 71% cheaper, sufficient for visual prompts
    FALLBACK: 'gemini-3-pro-image-preview'  // Higher quality fallback
};

interface ImageGenerationError {
    type: 'quota' | 'content_filter' | 'timeout' | 'network' | 'unknown';
    model: string;
    message: string;
    retryable: boolean;
}

function classifyImageError(error: any, model: string): ImageGenerationError {
    const message = error?.message || String(error);
    const status = error?.status;

    // Quota/Rate limit
    if (status === 429 || message.includes('429') || message.includes('quota') || message.includes('RESOURCE_EXHAUSTED')) {
        return { type: 'quota', model, message: 'Rate limit exceeded', retryable: true };
    }

    // Content filter (safety)
    if (message.includes('SAFETY') || message.includes('blocked') || message.includes('content filter')) {
        return { type: 'content_filter', model, message: 'Content blocked by safety filter', retryable: false };
    }

    // Timeout
    if (status === 499 || message.includes('timeout') || message.includes('cancelled') || message.includes('DEADLINE')) {
        return { type: 'timeout', model, message: 'Request timed out', retryable: true };
    }

    // Network issues
    if (status === 503 || message.includes('503') || message.includes('Overloaded') || message.includes('UNAVAILABLE')) {
        return { type: 'network', model, message: 'Service temporarily unavailable', retryable: true };
    }

    return { type: 'unknown', model, message: message.slice(0, 100), retryable: false };
}

export async function generateImageFromPrompt(
    prompt: string,
    aspectRatio: string = "16:9",
    costTracker?: CostTracker
): Promise<{ imageUrl: string, model: string } | null> {
    const ai = getAiClient();

    // Order: 2.5 Flash first (cheaper), Pro as fallback
    const models = [IMAGE_MODELS.DEFAULT, IMAGE_MODELS.FALLBACK];

    // Background-only prompt: NO text, diagrams, icons, or content elements
    // All content is rendered separately by SpatialLayoutEngine
    const richPrompt = `
TASK: Generate an ABSTRACT BACKGROUND IMAGE only.

SUBJECT THEME: ${prompt}

STRICT RULES:
- This is a BACKGROUND TEXTURE/GRADIENT only
- Text, icons, charts, and diagrams will be overlaid SEPARATELY by another system
- DO NOT generate any readable text, words, letters, or numbers
- DO NOT generate any diagrams, flowcharts, arrows, or process flows
- DO NOT generate any icons, symbols, logos, or UI elements
- ONLY generate: gradients, lighting effects, abstract shapes, textures, color fields

STYLE: Cinematic lighting, subtle gradients, professional corporate aesthetic.
COMPOSITION: Large areas of low contrast or dark tones for text overlay.
MOOD: Modern, premium, sophisticated.

NEGATIVE (DO NOT INCLUDE): ${NEGATIVE_PROMPT_INFO}
`.trim();

    // Log prompt length to verify it's short
    console.log(`[IMAGE GEN] Prompt length: ${richPrompt.length} chars, starting with ${models[0]}...`);

    const errors: ImageGenerationError[] = [];

    for (const modelName of models) {
        try {
            console.log(`[IMAGE GEN] Attempting ${modelName}...`);

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
                        console.log(`[IMAGE GEN] ✅ Success with ${modelName}`);
                        return {
                            imageUrl: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`,
                            model: modelName
                        };
                    }
                }
            }

            // No image data in response
            console.warn(`[IMAGE GEN] ${modelName} returned no image data`);
            errors.push({ type: 'unknown', model: modelName, message: 'No image data in response', retryable: true });

        } catch (e: any) {
            const classifiedError = classifyImageError(e, modelName);
            errors.push(classifiedError);

            console.warn(`[IMAGE GEN] ${modelName} failed: ${classifiedError.type} - ${classifiedError.message}`);

            // For retryable errors, try next model
            if (classifiedError.retryable && modelName !== models[models.length - 1]) {
                console.log(`[IMAGE GEN] Falling back to ${models[models.indexOf(modelName) + 1]}...`);
                continue;
            }

            // Content filter: Don't try other models (same prompt will fail)
            if (classifiedError.type === 'content_filter') {
                console.error(`[IMAGE GEN] ⚠️ Content blocked by safety filter. Prompt may need adjustment.`);
                break;
            }

            // Last model failed
            if (modelName === models[models.length - 1]) {
                console.error(`[IMAGE GEN] ❌ All models failed. Errors:`, errors.map(e => `${e.model}: ${e.type}`));
                break;
            }
        }
    }

    // Graceful null return - caller will handle missing image
    console.warn(`[IMAGE GEN] Returning null. Slide will render without background image.`);
    return null;
}

// --- ORCHESTRATOR (Level 3: Context Folding + Self-Healing Circuit Breaker) ---

export const generateAgenticDeck = async (
    topic: string,
    onProgress: (status: string, percent?: number) => void
): Promise<EditableSlideDeck> => {
    const costTracker = new CostTracker();
    const startTime = Date.now();

    console.log("[ORCHESTRATOR] Starting Level 3 Agentic Deck Generation...");
    console.log(`[ORCHESTRATOR] Max iterations per agent: ${MAX_AGENT_ITERATIONS}`);

    // --- PHASE 1: CONTEXT FOLDING STATE ---
    const narrativeHistory: NarrativeTrail[] = [];

    // --- RELIABILITY METRICS ---
    let fallbackSlides = 0;
    let visualAlignmentFirstPassSuccess = 0;
    let totalVisualDesignAttempts = 0;
    let rerouteCount = 0;
    // System 2 Visual Critique Tracking
    let visualCritiqueAttempts = 0;
    let visualRepairSuccess = 0;
    // System 2 Cost Breakdown
    let system2TotalCost = 0;
    let system2TotalInputTokens = 0;
    let system2TotalOutputTokens = 0;

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

    // 3. PER-SLIDE GENERATION with Context Folding + Circuit Breaker
    for (let i = 0; i < totalSlides; i++) {
        const slideMeta = outline.slides[i];
        let slideConstraints: RouterConstraints = {};

        try {
            console.log(`[ORCHESTRATOR] Processing slide ${i + 1}/${totalSlides}: "${slideMeta.title}"`);

            // --- PHASE 1: Get recent narrative history for context folding ---
            const recentHistory = narrativeHistory.slice(-2);

            // 3a. Route Layout (with optional constraints for rerouting)
            onProgress(`Agent 3/5: Routing Slide ${i + 1}/${totalSlides}...`, 30 + Math.floor((i / (totalSlides * 2)) * 30));
            let routerConfig = await runRouter(slideMeta, costTracker, slideConstraints);

            // 3b. Plan Content (with narrative history for context folding)
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
            const contentPlan = await runContentPlanner(slideMeta, factsContext, costTracker, recentHistory);

            // 3c. Visual Design (using Interactions API) - Track first-pass success
            onProgress(`Agent 3c/5: Visual Design Slide ${i + 1}...`, 34 + Math.floor((i / (totalSlides * 2)) * 30));
            totalVisualDesignAttempts++;
            const visualDesign = await runVisualDesigner(
                slideMeta.title,
                contentPlan,
                routerConfig,
                facts,
                costTracker
            );

            // Phase 2: Track visual alignment first-pass success
            const visualValidation = validateVisualLayoutAlignment(visualDesign, routerConfig);
            if (visualValidation.passed && visualValidation.score >= 80) {
                visualAlignmentFirstPassSuccess++;
                console.log(`[ORCHESTRATOR] Visual design first-pass SUCCESS (score: ${visualValidation.score})`);
            } else {
                console.log(`[ORCHESTRATOR] Visual design needs improvement (score: ${visualValidation.score})`);
            }

            // 3d. Final Generation (with narrative history + circuit breaker)
            // GAP 3: Bounded reroute loop to prevent infinite reroutes
            const MAX_REROUTES_PER_SLIDE = 2;
            let slideRerouteCount = 0;
            let generatorResult: any;
            let currentContentPlan = contentPlan;
            let currentVisualDesign = visualDesign;
            let currentRouterConfig = routerConfig;

            while (slideRerouteCount <= MAX_REROUTES_PER_SLIDE) {
                onProgress(`Agent 4/5: Generating Slide ${i + 1}...`, 40 + Math.floor((i / (totalSlides * 2)) * 40));
                generatorResult = await runGenerator(
                    slideMeta,
                    currentRouterConfig,
                    currentContentPlan,
                    currentVisualDesign,
                    facts,
                    outline.factClusters || [],
                    outline.styleGuide,
                    costTracker,
                    recentHistory
                );

                // Track System 2 metrics
                if (generatorResult.visualCritiqueRan) visualCritiqueAttempts++;
                if (generatorResult.visualRepairSucceeded) visualRepairSuccess++;
                // Accumulate System 2 costs
                if (generatorResult.system2Cost) {
                    system2TotalCost += generatorResult.system2Cost;
                    system2TotalInputTokens += generatorResult.system2InputTokens || 0;
                    system2TotalOutputTokens += generatorResult.system2OutputTokens || 0;
                }

                // --- PHASE 3: SELF-HEALING CIRCUIT BREAKER ---
                if (generatorResult.needsReroute && slideRerouteCount < MAX_REROUTES_PER_SLIDE) {
                    slideRerouteCount++;
                    console.warn(`[ORCHESTRATOR] Reroute ${slideRerouteCount}/${MAX_REROUTES_PER_SLIDE} for slide ${i + 1}: ${generatorResult.rerouteReason}`);
                    rerouteCount++;

                    // Re-run router with constraints to avoid failed layout
                    const newConstraints: RouterConstraints = {
                        avoidLayoutVariants: generatorResult.avoidLayoutVariants
                    };
                    currentRouterConfig = await runRouter(slideMeta, costTracker, newConstraints);

                    // Re-run content planner and visual designer with new route
                    currentContentPlan = await runContentPlanner(slideMeta, factsContext, costTracker, recentHistory);
                    currentVisualDesign = await runVisualDesigner(
                        slideMeta.title,
                        currentContentPlan,
                        currentRouterConfig,
                        facts,
                        costTracker
                    );

                    // Continue loop for another attempt
                    continue;
                } else if (generatorResult.needsReroute && slideRerouteCount >= MAX_REROUTES_PER_SLIDE) {
                    // Max reroutes exhausted - force fallback
                    console.error(`[ORCHESTRATOR] Max reroutes (${MAX_REROUTES_PER_SLIDE}) exhausted for slide ${i + 1}, using fallback`);
                    generatorResult.slide.warnings = [
                        ...(generatorResult.slide.warnings || []),
                        `Failed to find suitable layout after ${MAX_REROUTES_PER_SLIDE} reroutes, using fallback`
                    ];
                    fallbackSlides++;
                    break;
                } else {
                    // Success - exit loop
                    break;
                }
            }

            const slideNode = generatorResult.slide;

            // Track if this is a fallback slide
            if (slideNode.visualReasoning?.includes('Fallback')) {
                fallbackSlides++;
            }

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

            // --- PHASE 1: Update narrative history for context folding ---
            narrativeHistory.push({
                title: slideNode.title,
                mainPoint: slideNode.speakerNotesLines?.[0]?.substring(0, 100) || slideNode.purpose || ''
            });

            slides.push(slideNode);

        } catch (slideError: any) {
            // --- ERROR BOUNDARY: Create fallback slide instead of failing entire deck ---
            console.error(`[ORCHESTRATOR] Slide ${i + 1} failed, using fallback:`, slideError.message);
            fallbackSlides++;

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

            // Still update narrative history for context continuity
            narrativeHistory.push({
                title: slideMeta.title,
                mainPoint: 'Content pending manual edit'
            });

            slides.push(fallbackSlide);
        }
    }

    onProgress("Finalizing Deck...", 100);

    // GAP 2: Deck-Wide Narrative Coherence Validation
    console.log("[ORCHESTRATOR] Validating deck-wide narrative coherence...");
    const coherenceReport = validateDeckCoherence(slides);

    if (!coherenceReport.passed || coherenceReport.issues.length > 0) {
        console.warn(`[ORCHESTRATOR] Coherence validation: score ${coherenceReport.coherenceScore}/100`);
        coherenceReport.issues.forEach(issue => {
            const severity = issue.severity === 'critical' ? '🔴' : issue.severity === 'major' ? '🟡' : '🔵';
            const slideRefs = issue.slideIndices.map(i => `#${i + 1}`).join(', ');
            console.warn(`${severity} [${issue.type.toUpperCase()}] ${issue.message} (slides: ${slideRefs})`);

            // Add warnings to affected slides
            issue.slideIndices.forEach(idx => {
                if (slides[idx]) {
                    slides[idx].warnings = [
                        ...(slides[idx].warnings || []),
                        `Coherence issue: ${issue.message}`
                    ];
                }
            });
        });

        // Log summary
        const repetitionCount = coherenceReport.issues.filter(i => i.type === 'repetition').length;
        const arcViolationCount = coherenceReport.issues.filter(i => i.type === 'arc_violation').length;
        const driftCount = coherenceReport.issues.filter(i => i.type === 'thematic_drift').length;

        if (repetitionCount > 0) console.warn(`[ORCHESTRATOR]   - ${repetitionCount} repetition issue(s)`);
        if (arcViolationCount > 0) console.warn(`[ORCHESTRATOR]   - ${arcViolationCount} narrative arc violation(s)`);
        if (driftCount > 0) console.warn(`[ORCHESTRATOR]   - ${driftCount} thematic drift issue(s)`);
    } else {
        console.log(`[ORCHESTRATOR] ✅ Deck coherence validation passed (score: ${coherenceReport.coherenceScore}/100)`);
    }

    const totalDurationMs = Date.now() - startTime;
    const costSummary = costTracker.getSummary();

    // --- RELIABILITY METRICS LOGGING ---
    const visualFirstPassRate = totalVisualDesignAttempts > 0
        ? Math.round((visualAlignmentFirstPassSuccess / totalVisualDesignAttempts) * 100)
        : 0;
    const fallbackRate = totalSlides > 0 ? (fallbackSlides / totalSlides) * 100 : 0;

    console.log("[ORCHESTRATOR] ✅ Level 3 Generation Complete!");
    console.log(`[ORCHESTRATOR] Duration: ${(totalDurationMs / 1000).toFixed(1)}s`);
    console.log(`[ORCHESTRATOR] Total Cost: $${costSummary.totalCost.toFixed(4)}`);
    console.log(`[ORCHESTRATOR] 💰 Savings vs Pro: $${costSummary.totalSavingsVsPro.toFixed(4)} (${((costSummary.totalSavingsVsPro / (costSummary.totalCost + costSummary.totalSavingsVsPro)) * 100).toFixed(0)}%)`);
    console.log(`[ORCHESTRATOR] Tokens: ${costSummary.totalInputTokens} in, ${costSummary.totalOutputTokens} out`);
    console.log(`[ORCHESTRATOR] Model Breakdown:`, costSummary.modelBreakdown);
    console.log(`[ORCHESTRATOR] 📊 RELIABILITY METRICS:`);
    console.log(`[ORCHESTRATOR]   - Fallback Slides: ${fallbackSlides}/${totalSlides} (${fallbackRate.toFixed(1)}%) - Target: ≤1/deck`);
    console.log(`[ORCHESTRATOR]   - Visual First-Pass Success: ${visualAlignmentFirstPassSuccess}/${totalVisualDesignAttempts} (${visualFirstPassRate}%) - Target: ≥80%`);
    console.log(`[ORCHESTRATOR]   - Reroute Count: ${rerouteCount}`);
    console.log(`[ORCHESTRATOR] 🔍 SYSTEM 2 VISUAL CRITIQUE:`);
    console.log(`[ORCHESTRATOR]   - Visual Critique Attempts: ${visualCritiqueAttempts}/${totalSlides}`);
    console.log(`[ORCHESTRATOR]   - Visual Repair Success: ${visualRepairSuccess}/${visualCritiqueAttempts > 0 ? visualCritiqueAttempts : 1}`);
    console.log(`[ORCHESTRATOR]   - System 2 Cost: $${system2TotalCost.toFixed(4)} (${costSummary.totalCost > 0 ? (system2TotalCost/costSummary.totalCost*100).toFixed(1) : 0}% of total)`);
    console.log(`[ORCHESTRATOR]   - System 2 Tokens: ${system2TotalInputTokens} in, ${system2TotalOutputTokens} out`);

    // Compute metrics for reliability targets
    const deckMetrics: DeckMetrics = {
        totalDurationMs,
        retries: rerouteCount,
        totalCost: costSummary.totalCost,
        fallbackSlides,
        visualAlignmentFirstPassSuccess,
        totalVisualDesignAttempts,
        rerouteCount,
        visualCritiqueAttempts,
        visualRepairSuccess,
        system2Cost: system2TotalCost,
        system2TokensInput: system2TotalInputTokens,
        system2TokensOutput: system2TotalOutputTokens,
        coherenceScore: coherenceReport.coherenceScore,
        coherenceIssues: coherenceReport.issues.length
    };

    return {
        id: crypto.randomUUID(),
        topic,
        meta: outline,
        slides,
        metrics: deckMetrics
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
        costTracker
    );

    // Use default styleGuide for single slide regeneration
    const defaultStyleGuide: GlobalStyleGuide = {
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
    };

    // Generator now returns GeneratorResult, extract the slide
    const generatorResult = await runGenerator(meta, routerConfig, contentPlan, visualDesign, facts, factClusters, defaultStyleGuide, costTracker);
    const newSlide = generatorResult.slide;

    newSlide.visualPrompt = visualDesign.prompt_with_composition;

    if (newSlide.visualPrompt) {
        const imgResult = await generateImageFromPrompt(newSlide.visualPrompt, "16:9", costTracker);
        if (imgResult) {
            newSlide.backgroundImageUrl = imgResult.imageUrl;
        }
    }
    return newSlide;
};
