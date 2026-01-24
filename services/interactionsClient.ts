/**
 * Gemini Interactions API Client
 * 
 * Based on: https://ai.google.dev/api/interactions-api.md.txt
 * 
 * This module provides a standardized client for the experimental Gemini Interactions API,
 * implementing proper agent patterns including:
 * - Function calling with client-side tool execution
 * - Multi-turn conversation management
 * - Structured logging and transparency
 * - Max iterations guard with escape hatches
 * - Thought signature preservation (Gemini 3)
 */

// --- TYPES ---

export type InteractionStatus = 'in_progress' | 'requires_action' | 'completed' | 'failed' | 'cancelled';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

// --- JSON FAILURE CLASSIFICATION ---
// Classify JSON failures BEFORE attempting repair to apply correct strategy

export type JsonFailureType =
    | 'garbage_suffix'   // Valid JSON + trailing junk (e.g., `{"valid": 1}, ""`)
    | 'truncation'       // Missing closing braces/brackets due to token limit
    | 'escaped_json'     // JSON inside a JSON string (double-encoded)
    | 'schema_drift'     // Wrong field types (e.g., string[] instead of object[])
    | 'string_array'     // Flat string array instead of object structure
    | 'empty_response'   // API returned empty/whitespace-only response (often after 500 error)
    | 'degeneration'     // LLM stuck in repetition loop (enum concatenation, word repeats)
    | 'unknown';         // Unclassified malformation

interface JsonClassification {
    type: JsonFailureType;
    validPrefixEnd?: number;  // Position of last complete JSON object
    confidence: 'high' | 'medium' | 'low';
}

/**
 * Classify JSON failure type before attempting repair.
 * This prevents applying truncation repair to garbage-suffix cases (and vice versa).
 */
function classifyJsonFailure(text: string): JsonClassification {
    const trimmed = text.trim();

    // Check for empty/whitespace-only response (often after API 500 errors)
    if (trimmed.length === 0) {
        console.warn(`[JSON CLASSIFY] Empty response detected (API likely returned 500 or no content)`);
        return { type: 'empty_response', confidence: 'high' };
    }

    // Check for degeneration pattern (o0o0o0, aaaaa, etc.) - severe token exhaustion
    // This happens when the model runs out of tokens and starts repeating characters
    if (/([a-z0-9])\1{10,}/.test(trimmed.slice(-50))) {
        console.warn(`[JSON CLASSIFY] Detected degeneration pattern (token exhaustion - character repeat)`);
        return { type: 'degeneration', confidence: 'high' };
    }

    // NEW: Check for word/phrase repetition loops (LLM hallucination)
    // Example: "diagram-svg_circular-ecosystem_component_type_enum_value_diagram-svg_circular-ecosystem_..."
    // These happen when the LLM gets stuck in a loop generating enum-like patterns
    const last500 = trimmed.slice(-500);
    const wordRepeatPattern = /([a-z_-]{4,}(?:_[a-z_-]+){2,})\1{3,}/i;
    if (wordRepeatPattern.test(last500)) {
        console.warn(`[JSON CLASSIFY] Detected degeneration pattern (word-level repetition loop)`);
        return { type: 'degeneration', confidence: 'high' };
    }

    // NEW: Check for underscore-separated repetition (catches "id_icon_label_id_icon_label...")
    // This is a common hallucination pattern where the LLM repeats JSON field names
    const underscoreRepeatPattern = /([a-z]{2,}_[a-z]{2,}_[a-z]{2,}_)\1{2,}/i;
    if (underscoreRepeatPattern.test(last500)) {
        console.warn(`[JSON CLASSIFY] Detected degeneration pattern (underscore-separated field repetition)`);
        return { type: 'degeneration', confidence: 'high' };
    }

    // NEW: Check for any short pattern repeated many times (generic repetition catch-all)
    // Pattern: any 8-30 char sequence repeated 4+ times consecutively
    const genericRepeatPattern = /(.{8,30})\1{3,}/;
    if (genericRepeatPattern.test(last500)) {
        const match = last500.match(genericRepeatPattern);
        if (match && match[1]) {
            // Avoid false positives on legitimate repeated JSON patterns like `},{`
            const repeatedPattern = match[1];
            const isLegitimate = /^[\s{}\[\],":]+$/.test(repeatedPattern);
            if (!isLegitimate) {
                console.warn(`[JSON CLASSIFY] Detected degeneration pattern (generic repetition: "${repeatedPattern.slice(0, 20)}...")`);
                return { type: 'degeneration', confidence: 'high' };
            }
        }
    }

    // NEW: Check for enum value concatenation pattern
    // Example: "metric-cards-left-text-bullets-right-metric-cards-left-text-bullets-right-..."
    const enumConcatPattern = /((?:text-bullets|metric-cards|process-flow|icon-grid|chart-frame|diagram-svg)[-_]){4,}/i;
    if (enumConcatPattern.test(last500)) {
        console.warn(`[JSON CLASSIFY] Detected degeneration pattern (enum value concatenation)`);
        return { type: 'degeneration', confidence: 'high' };
    }

    // Check for string array pattern: ["item1", "item2", ...]
    if (/^\s*\[\s*"[^"]*"\s*(,\s*"[^"]*"\s*)*\]\s*$/.test(trimmed)) {
        return { type: 'string_array', confidence: 'high' };
    }

    // Check for escaped JSON (starts with " and contains \")
    if (trimmed.startsWith('"') && trimmed.includes('\\"')) {
        return { type: 'escaped_json', confidence: 'medium' };
    }

    // Find first object/array start
    const firstBrace = trimmed.indexOf('{');
    const firstBracket = trimmed.indexOf('[');
    if (firstBrace === -1 && firstBracket === -1) {
        return { type: 'unknown', confidence: 'low' };
    }

    const startIdx = (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace))
        ? firstBracket : firstBrace;

    // Track bracket depth to find last complete object
    let depth = 0;
    let inString = false;
    let escape = false;
    let lastValidEnd = -1;

    for (let i = startIdx; i < trimmed.length; i++) {
        const char = trimmed[i];

        if (escape) { escape = false; continue; }
        if (char === '\\') { escape = true; continue; }
        if (char === '"') { inString = !inString; continue; }

        if (!inString) {
            if (char === '{' || char === '[') {
                depth++;
            } else if (char === '}' || char === ']') {
                depth--;
                if (depth === 0) {
                    lastValidEnd = i;
                }
            }
        }
    }

    // Garbage suffix: Valid JSON exists, but there's content after it
    if (lastValidEnd !== -1 && lastValidEnd < trimmed.length - 1) {
        const suffix = trimmed.substring(lastValidEnd + 1).trim();
        if (suffix.length > 0 && !suffix.match(/^\s*$/)) {
            // Check if suffix is garbage (commas, empty strings, etc.)
            if (/^[,\s"]*$/.test(suffix) || suffix.startsWith(',')) {
                return {
                    type: 'garbage_suffix',
                    validPrefixEnd: lastValidEnd,
                    confidence: 'high'
                };
            }
        }
        return { type: 'garbage_suffix', validPrefixEnd: lastValidEnd, confidence: 'medium' };
    }

    // Truncation: depth > 0 means unclosed brackets
    if (depth > 0) {
        return { type: 'truncation', confidence: 'high' };
    }

    // If we get here and still can't parse, it's unknown
    return { type: 'unknown', confidence: 'low' };
}

/**
 * Extract the longest valid JSON prefix from text.
 * This directly addresses the `, ""` tail pattern by discarding suffixes.
 */
function extractLongestValidPrefix(text: string): { json: string; discarded: string } | null {
    const trimmed = text.trim();

    const firstBrace = trimmed.indexOf('{');
    const firstBracket = trimmed.indexOf('[');
    if (firstBrace === -1 && firstBracket === -1) return null;

    const startIdx = (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace))
        ? firstBracket : firstBrace;

    let depth = 0;
    let inString = false;
    let escape = false;
    let lastValidEnd = -1;

    for (let i = startIdx; i < trimmed.length; i++) {
        const char = trimmed[i];

        if (escape) { escape = false; continue; }
        if (char === '\\') { escape = true; continue; }
        if (char === '"') { inString = !inString; continue; }

        if (!inString) {
            if (char === '{' || char === '[') {
                depth++;
            } else if (char === '}' || char === ']') {
                depth--;
                if (depth === 0) {
                    lastValidEnd = i;
                }
            }
        }
    }

    if (lastValidEnd !== -1) {
        return {
            json: trimmed.substring(startIdx, lastValidEnd + 1),
            discarded: trimmed.substring(lastValidEnd + 1)
        };
    }

    return null;
}

// Detect low-entropy/degenerate output patterns (e.g., "0-0-0", "o0o0o0", repeated chars, word loops)
// NOTE: Must be careful not to flag legitimate JSON patterns like multiple "none" values
// ENHANCED: Now catches CamelCase repetition and component type hallucinations
function hasEntropyDegeneration(text: string): boolean {
    const sample = text.slice(-800).toLowerCase(); // Increased window to catch patterns
    const originalSample = text.slice(-800); // Keep original case for CamelCase detection

    // Original character-level patterns
    if (/(\b0-){2,}0\b/.test(sample)) return true;
    if (/(?:\b0\b[\s,\-]*){6,}/.test(sample)) return true;
    if (/(?:o0){5,}/.test(sample)) return true;
    if (/([a-z0-9])\1{10,}/.test(sample)) return true;

    // NEW: CamelCase repetition detection (catches "MetricCardsMetricCardsMetricCards...")
    // This is a common LLM failure mode when generating component types
    const camelCasePattern = /([A-Z][a-z]+(?:[A-Z][a-z]+)?)\1{3,}/;
    if (camelCasePattern.test(originalSample)) {
        const match = originalSample.match(camelCasePattern);
        if (match) {
            console.warn(`[DEGENERATION] CamelCase repetition detected: "${match[1]}..." repeated`);
            return true;
        }
    }

    // NEW: Component type hallucination detection
    // Catches patterns like "text-bullets_safe-zone_text-safe-zone_text-safe-zone..."
    const typeHallucinationPattern = /([-_][a-z]+-[a-z]+)\1{4,}/i;
    if (typeHallucinationPattern.test(sample)) {
        console.warn(`[DEGENERATION] Component type hallucination detected`);
        return true;
    }

    // NEW: Underscore-separated repetition (catches "id_icon_label_id_icon_label...")
    const underscoreRepeatPattern = /([a-z]{2,}_[a-z]{2,}_[a-z]{2,}_)\1{2,}/i;
    if (underscoreRepeatPattern.test(sample)) {
        console.warn(`[DEGENERATION] Underscore-separated field repetition detected`);
        return true;
    }

    // NEW: Generic repetition catch-all (any 8-30 char pattern repeated 4+ times)
    const genericRepeatPattern = /(.{8,30})\1{3,}/;
    const genericMatch = sample.match(genericRepeatPattern);
    if (genericMatch && genericMatch[1] && !/^[\s{}\[\],":]+$/.test(genericMatch[1])) {
        console.warn(`[DEGENERATION] Generic repetition detected: "${genericMatch[1].slice(0, 20)}..."`);
        return true;
    }

    // NEW: Long string value detection - no valid component type should exceed 50 chars
    // This catches cases where the model generates garbage in "type" field
    const typeValuePattern = /"type"\s*:\s*"([^"]{60,})"/;
    if (typeValuePattern.test(text)) {
        console.warn(`[DEGENERATION] Oversized type value detected`);
        return true;
    }

    // Word-level repetition detection (catches "and-no-icon-bullets-and-no-icon-bullets...")
    const words = sample.split(/[\s\-_]+/).filter(w => w.length > 2);
    if (words.length >= 10) {
        const safeWords = new Set(['none', 'null', 'true', 'false', 'default', 'auto', 'inherit', 'normal']);

        for (let patternLen = 1; patternLen <= 4; patternLen++) {
            let repeatCount = 1;
            for (let i = patternLen; i < words.length; i += patternLen) {
                const pattern = words.slice(i - patternLen, i).join('-');
                const current = words.slice(i, i + patternLen).join('-');
                if (pattern === current) {
                    repeatCount++;
                    if (patternLen === 1 && safeWords.has(pattern)) {
                        continue;
                    }
                    const threshold = patternLen === 1 ? 6 : 4;
                    if (repeatCount >= threshold) {
                        console.warn(`[DEGENERATION] Detected word-level repetition: "${pattern}" repeated ${repeatCount}x`);
                        return true;
                    }
                } else {
                    repeatCount = 1;
                }
            }
        }
    }

    // Character entropy check
    const alnum = sample.replace(/[^a-z0-9]/g, '');
    if (alnum.length >= 30) {
        const uniqueChars = new Set(alnum.split('')).size;
        if (uniqueChars <= 3) return true;
    }

    return false;
}

export type ContentType =
    | { type: 'text'; text: string }
    | { type: 'image'; image: { data: string; mimeType: string } }
    | { type: 'function_call'; function_call: FunctionCall }
    | { type: 'function_result'; function_result: FunctionResult }
    | { type: 'thought'; summary?: { type: 'text'; text: string }[]; signature?: string }
    | { type: 'google_search_call'; id: string; arguments: { queries: string[] } }
    | { type: 'google_search_result'; call_id: string; result: { url: string; title: string }[] };

export interface FunctionCall {
    name: string;
    id?: string;
    arguments: Record<string, any>;
}

export interface FunctionResult {
    name: string;
    call_id: string;
    result: any;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, {
            type: string;
            description: string;
            enum?: string[];
        }>;
        required: string[];
    };
}

export interface Tool {
    definition: ToolDefinition;
    execute: (args: Record<string, any>) => Promise<any>;
}

export interface InteractionRequest {
    model?: string;
    agent?: string;
    input: string | ContentType[];
    system_instruction?: string;
    tools?: { function_declarations?: ToolDefinition[]; googleSearch?: {} }[];
    response_format?: any;
    response_mime_type?: string;
    stream?: boolean;
    store?: boolean;
    background?: boolean;
    generation_config?: {
        temperature?: number;
        top_p?: number;
        seed?: number;
        stop_sequences?: string[];
        thinking_level?: ThinkingLevel;
        thinking_summaries?: 'auto' | 'none';
        max_output_tokens?: number;
    };
    previous_interaction_id?: string;
}

export interface InteractionResponse {
    id: string;
    model?: string;
    agent?: string;
    status: InteractionStatus;
    object: 'interaction';
    created: string;
    updated: string;
    role: 'model';
    outputs: ContentType[];
    usage?: {
        total_input_tokens: number;
        total_output_tokens: number;
        total_reasoning_tokens?: number;
        total_tool_use_tokens?: number;
        total_tokens: number;
    };
    previous_interaction_id?: string;
}

type NormalizedUsage = InteractionResponse['usage'];

function normalizeUsage(raw: any): NormalizedUsage | undefined {
    if (!raw || typeof raw !== 'object') return undefined;

    const usage = raw.usage || raw.usageMetadata || raw.usage_metadata || raw.tokenUsage || raw.token_usage;
    if (!usage || typeof usage !== 'object') return undefined;

    const input = Number(
        usage.total_input_tokens ?? usage.input_tokens ?? usage.prompt_tokens ?? usage.prompt_token_count ?? usage.promptTokenCount ?? 0
    );
    const output = Number(
        usage.total_output_tokens ?? usage.output_tokens ?? usage.candidates_tokens ?? usage.candidates_token_count ?? usage.candidatesTokenCount ?? 0
    );
    const reasoning = Number(
        usage.total_reasoning_tokens ?? usage.reasoning_tokens ?? usage.thought_tokens ?? usage.thinking_token_count ?? 0
    );
    const toolUse = Number(
        usage.total_tool_use_tokens ?? usage.tool_use_tokens ?? usage.toolTokenCount ?? 0
    );
    const total = Number(
        usage.total_tokens ?? usage.totalTokenCount ?? (input + output + reasoning + toolUse)
    );

    return {
        total_input_tokens: Number.isFinite(input) ? input : 0,
        total_output_tokens: Number.isFinite(output) ? output : 0,
        total_reasoning_tokens: Number.isFinite(reasoning) ? reasoning : 0,
        total_tool_use_tokens: Number.isFinite(toolUse) ? toolUse : 0,
        total_tokens: Number.isFinite(total) ? total : (input + output + reasoning + toolUse)
    };
}

export interface AgentConfig {
    model: string;
    systemInstruction: string;
    tools: Record<string, Tool>;
    maxIterations?: number;
    thinkingLevel?: ThinkingLevel;
    temperature?: number;
    maxOutputTokens?: number;
    onToolCall?: (name: string, args: any, result: any) => void;
    
    // =========================================================================
    // CONTEXT FOLDING OPTIONS (Phil Schmid Best Practices)
    // =========================================================================
    /** 
     * Context mode controls how conversation history is managed:
     * - 'server': Use previous_interaction_id; only send deltas (tool results) after turn 1
     * - 'client': Send full history every turn (legacy behavior, useful for debugging)
     * Default: 'server' for efficiency
     */
    contextMode?: 'server' | 'client';
    
    /**
     * Initial thought signature from a previous agent (for cross-agent context transfer)
     */
    initialThoughtSignature?: string;
    
    /**
     * Maximum retries per tool before marking it as non-retryable
     * Default: 2
     */
    maxToolRetries?: number;
}

// --- LOGGING ---

export interface ToolCallLog {
    timestamp: number;
    tool: string;
    arguments: any;
    result: any;
    durationMs: number;
}

export class AgentLogger {
    private calls: ToolCallLog[] = [];
    private startTime: number = Date.now();

    logToolCall(tool: string, args: any, result: any, durationMs: number): void {
        const entry: ToolCallLog = {
            timestamp: Date.now(),
            tool,
            arguments: args,
            result: typeof result === 'object' ? JSON.stringify(result).substring(0, 200) : result,
            durationMs
        };
        this.calls.push(entry);
        console.log(`[TOOL CALL] ${tool}`, JSON.stringify(args).substring(0, 100));
        console.log(`[TOOL RESULT] ${tool} (${durationMs}ms)`, JSON.stringify(result).substring(0, 100));
    }

    logIteration(iteration: number, status: string): void {
        console.log(`[AGENT LOOP] Iteration ${iteration}: ${status}`);
    }

    getSummary(): { calls: ToolCallLog[]; totalDurationMs: number; iterationCount: number } {
        return {
            calls: this.calls,
            totalDurationMs: Date.now() - this.startTime,
            iterationCount: this.calls.length
        };
    }
}

// --- MODEL TIERS (Phil Schmid's Best Practices) ---
// Based on benchmarks: Gemini 3 Flash outperforms 3 Pro on agentic tasks (78% vs 76.2% SWE-bench)
// Use MODEL_SIMPLE for high-volume/simple classification tasks (79% cheaper)
// Reserve MODEL_REASONING only for long-context synthesis (rarely needed)

/** Primary workhorse for agentic tasks: 3x faster, 71% cheaper, better agentic performance */
export const MODEL_AGENTIC = 'gemini-3-flash-preview';

/** High-volume/simple tasks: classification, JSON structuring, pattern matching (79% cheaper than Flash) */
export const MODEL_SIMPLE = 'gemini-2.5-flash';

// --- QWEN FALLBACK CLIENT ---
// Used when Gemini returns empty responses (content filtered, rate limited, or server errors)
// API: DashScope OpenAI-compatible endpoint

const QWEN_API_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const QWEN_MODEL = 'qwen-plus-2025-01-25';  // Fast, reliable fallback model

interface QwenFallbackOptions {
    systemInstruction?: string;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: 'json' | 'text';
}

/**
 * Call Qwen as a fallback when Gemini fails.
 * Uses OpenAI-compatible API via DashScope.
 * Returns null if DASHSCOPE_API_KEY is not configured.
 */
async function callQwenFallback(
    prompt: string,
    options: QwenFallbackOptions = {}
): Promise<string | null> {
    const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;

    if (!apiKey) {
        console.warn(`[QWEN FALLBACK] DASHSCOPE_API_KEY not configured. Skipping fallback.`);
        return null;
    }

    console.log(`[QWEN FALLBACK] Gemini failed, trying Qwen (${QWEN_MODEL})...`);

    const messages: Array<{ role: string; content: string }> = [];

    if (options.systemInstruction) {
        messages.push({ role: 'system', content: options.systemInstruction });
    }
    messages.push({ role: 'user', content: prompt });

    const requestBody: Record<string, any> = {
        model: QWEN_MODEL,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 8192,
    };

    // Add JSON mode if requested
    if (options.responseFormat === 'json') {
        requestBody.response_format = { type: 'json_object' };
    }

    try {
        const response = await fetch(`${QWEN_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[QWEN FALLBACK] API error (${response.status}): ${errorText}`);
            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;

        if (!content) {
            console.warn(`[QWEN FALLBACK] Empty response from Qwen`);
            return null;
        }

        console.log(`[QWEN FALLBACK] Success! Got ${content.length} chars from Qwen`);

        // Log token usage if available
        if (data.usage) {
            console.log(`[QWEN FALLBACK] Usage: ${data.usage.prompt_tokens} in / ${data.usage.completion_tokens} out`);
        }

        return content;
    } catch (err: any) {
        console.error(`[QWEN FALLBACK] Request failed:`, err.message);
        return null;
    }
}

/** Reserved for complex reasoning (>1M context synthesis) - rarely needed for slide generation */
export const MODEL_REASONING = 'gemini-3-pro-preview';

/** @deprecated Use MODEL_AGENTIC instead */
export const MODEL_FAST = MODEL_AGENTIC;

/** @deprecated Use MODEL_REASONING instead */
export const MODEL_SMART = MODEL_REASONING;

// --- TASK TYPE SELECTOR ---
export type TaskType = 'agentic' | 'simple' | 'reasoning';

/**
 * Select the optimal model for a given task type based on Phil Schmid's agent best practices.
 * - agentic: Researcher, Architect, Content Planner, Visual Designer, Generator → 3 Flash
 * - simple: Router, Layout Generator, JSON Repairer → 2.5 Flash  
 * - reasoning: None needed for slide generation (long-context synthesis only)
 */
export function selectModelForTask(taskType: TaskType): string {
    const modelMap: Record<TaskType, string> = {
        agentic: MODEL_AGENTIC,
        simple: MODEL_SIMPLE,
        reasoning: MODEL_REASONING
    };
    return modelMap[taskType];
}

// --- COST TRACKING ---

const PRICING = {
    TOKENS: {
        'gemini-3-pro-preview': { input: 2.00, output: 12.00 },  // Updated Pro pricing
        'gemini-3-flash-preview': { input: 0.15, output: 3.50 }, // Updated Flash pricing
        'gemini-2.5-flash': { input: 0.075, output: 0.30 },      // Budget tier
        'gemini-2.0-flash': { input: 0.10, output: 0.40 },
        'gemini-2.0-flash-lite-preview-02-05': { input: 0.075, output: 0.30 }
    },
    IMAGES: {
        'gemini-3-pro-image-preview': 0.134,
        'gemini-2.5-flash-image': 0.039
    }
};

// Pro baseline for savings calculation
const PRO_RATES = PRICING.TOKENS['gemini-3-pro-preview'];

// Normalize model names from API responses (e.g., "models/gemini-3-flash-preview")
function normalizeModelName(model?: string): string {
    if (!model) return 'unknown';
    return model.replace(/^models\//, '').replace(/^model\//, '').trim();
}

export class CostTracker {
    totalCost = 0;
    totalInputTokens = 0;
    totalOutputTokens = 0;
    totalReasoningTokens = 0;
    totalTokensReported = 0;
    totalSavingsVsPro = 0;
    private modelUsage: Map<string, { calls: number; cost: number; inputTokens: number; outputTokens: number; reasoningTokens: number }> = new Map();

    // Qwen-VL Visual Cortex metrics
    qwenVLCost = 0;
    qwenVLInputTokens = 0;
    qwenVLOutputTokens = 0;
    qwenVLCalls = 0;

    addUsage(model: string, usage: InteractionResponse['usage']): void {
        if (!usage) return;

        const normalizedModel = normalizeModelName(model);

        this.totalInputTokens += usage.total_input_tokens || 0;
        this.totalOutputTokens += usage.total_output_tokens || 0;
        this.totalReasoningTokens += usage.total_reasoning_tokens || 0;

        const rates = PRICING.TOKENS[normalizedModel as keyof typeof PRICING.TOKENS] || { input: 0.10, output: 0.40 };
        const computedTotal = (usage.total_input_tokens || 0) + (usage.total_output_tokens || 0) + (usage.total_reasoning_tokens || 0) + (usage.total_tool_use_tokens || 0);
        if (usage.total_tokens && Number.isFinite(usage.total_tokens)) {
            this.totalTokensReported += usage.total_tokens;
            if (usage.total_tokens < computedTotal) {
                console.warn(`[COST] Token total less than sum for ${normalizedModel}: reported ${usage.total_tokens}, computed ${computedTotal}`);
            }
        } else {
            this.totalTokensReported += computedTotal;
        }
        const cost = (usage.total_input_tokens / 1_000_000 * rates.input) +
            (usage.total_output_tokens / 1_000_000 * rates.output);
        this.totalCost += cost;

        // Calculate savings vs Pro
        const proCost = (usage.total_input_tokens / 1_000_000 * PRO_RATES.input) +
            (usage.total_output_tokens / 1_000_000 * PRO_RATES.output);
        const savings = proCost - cost;
        this.totalSavingsVsPro += savings;

        // Track per-model usage
        const existing = this.modelUsage.get(normalizedModel) || { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
        this.modelUsage.set(normalizedModel, {
            calls: existing.calls + 1,
            cost: existing.cost + cost,
            inputTokens: existing.inputTokens + (usage.total_input_tokens || 0),
            outputTokens: existing.outputTokens + (usage.total_output_tokens || 0),
            reasoningTokens: existing.reasoningTokens + (usage.total_reasoning_tokens || 0)
        });

        // Log savings for visibility
        console.log(`💰 [COST] ${normalizedModel}: $${cost.toFixed(4)} (${usage.total_input_tokens} input, ${usage.total_output_tokens} output tokens${usage.total_reasoning_tokens ? `, ${usage.total_reasoning_tokens} reasoning` : ''})`);
        if (savings > 0.0001) {
            console.log(`💰 [COST] ${normalizedModel}: saved $${savings.toFixed(4)} vs Pro`);
        }
    }

    addImageCost(model: string): void {
        const cost = PRICING.IMAGES[model as keyof typeof PRICING.IMAGES] || 0.134;
        this.totalCost += cost;
    }

    /**
     * Add Qwen-VL visual critique cost
     * Pricing: $0.2 per 1M input tokens, $1.6 per 1M output tokens
     */
    addQwenVLCost(inputTokens: number, outputTokens: number): void {
        const QWEN_VL_PRICING = { input: 0.2, output: 1.6 }; // Per 1M tokens
        const cost = (inputTokens / 1_000_000 * QWEN_VL_PRICING.input) +
            (outputTokens / 1_000_000 * QWEN_VL_PRICING.output);

        this.qwenVLCost += cost;
        this.qwenVLInputTokens += inputTokens;
        this.qwenVLOutputTokens += outputTokens;
        this.qwenVLCalls += 1;
        this.totalCost += cost;

        console.log(`💰 [COST] Qwen-VL: $${cost.toFixed(4)} (${inputTokens} input, ${outputTokens} output tokens)`);
    }

    getSummary(): {
        totalCost: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalReasoningTokens: number;
        totalTokensReported: number;
        totalSavingsVsPro: number;
        modelBreakdown: Record<string, { calls: number; cost: number; inputTokens: number; outputTokens: number; reasoningTokens: number }>;
        qwenVL?: {
            cost: number;
            inputTokens: number;
            outputTokens: number;
            calls: number;
        };
    } {
        const summary: any = {
            totalCost: this.totalCost,
            totalInputTokens: this.totalInputTokens,
            totalOutputTokens: this.totalOutputTokens,
            totalReasoningTokens: this.totalReasoningTokens,
            totalTokensReported: this.totalTokensReported,
            totalSavingsVsPro: this.totalSavingsVsPro,
            modelBreakdown: Object.fromEntries(this.modelUsage)
        };

        // Include Qwen-VL metrics if used
        if (this.qwenVLCalls > 0) {
            summary.qwenVL = {
                cost: this.qwenVLCost,
                inputTokens: this.qwenVLInputTokens,
                outputTokens: this.qwenVLOutputTokens,
                calls: this.qwenVLCalls
            };
        }

        return summary;
    }
}

// --- INTERACTIONS API CLIENT ---

const INTERACTIONS_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// --- SINGLETON CLIENT (Phil Schmid Best Practice: Reuse connections) ---
let _sharedClient: InteractionsClient | null = null;

/**
 * Get or create a shared InteractionsClient instance.
 * This reduces TCP/TLS overhead by reusing the same client across calls.
 */
export function getSharedClient(): InteractionsClient {
    if (!_sharedClient) {
        _sharedClient = new InteractionsClient();
    }
    return _sharedClient;
}

// --- TOKEN ESTIMATION (Phil Schmid Best Practice: Prevent truncation) ---

/**
 * Estimate the number of output tokens needed for a JSON response.
 * Uses heuristics based on schema complexity and expected content size.
 * 
 * @param schema - The JSON schema for the response
 * @param options - Additional context for estimation
 * @returns Recommended max_output_tokens value
 */
export function estimateTokenBudget(
    schema: any,
    options: {
        contentComplexity?: 'simple' | 'moderate' | 'complex';
        expectedArrayLength?: number;
        hasNestedObjects?: boolean;
    } = {}
): number {
    const BASE_TOKENS = 1024; // Minimum for any JSON response

    // Estimate based on schema structure
    let multiplier = 1.0;

    // Count top-level properties
    const propCount = Object.keys(schema?.properties || {}).length;
    multiplier += propCount * 0.1;

    // Check for arrays (they need more tokens)
    const schemaString = JSON.stringify(schema);
    const arrayCount = (schemaString.match(/"type"\s*:\s*"array"/g) || []).length;
    multiplier += arrayCount * 0.3;

    // Content complexity adjustment
    if (options.contentComplexity === 'complex') {
        multiplier *= 1.5;
    } else if (options.contentComplexity === 'moderate') {
        multiplier *= 1.2;
    }

    // Expected array length adjustment
    if (options.expectedArrayLength) {
        multiplier += Math.min(options.expectedArrayLength * 0.1, 0.5);
    }

    // Nested objects need more tokens
    if (options.hasNestedObjects) {
        multiplier *= 1.3;
    }

    // Apply buffer for thinking (if enabled)
    const thinkingBuffer = 0.2;

    const estimated = Math.ceil(BASE_TOKENS * multiplier * (1 + thinkingBuffer));

    // Clamp to reasonable bounds (min 2048, max 16384)
    return Math.max(2048, Math.min(16384, estimated));
}

/**
 * Quick token estimation for common agent patterns
 */
export const TOKEN_BUDGETS = {
    /** Router: simple classification, small output (increased for Interactions API buffer) */
    ROUTER: 2048,
    /** Content Planner: structured extraction, moderate output (increased to fix truncation) */
    CONTENT_PLANNER: 3072,
    /** Visual Designer: design spec, moderate output */
    VISUAL_DESIGNER: 2048,
    /** Composition Architect: layer planning (increased for nested schema) */
    COMPOSITION_ARCHITECT: 2048,
    /** Generator: full slide JSON, largest output */
    GENERATOR: 8192,
    /** Generator with complex layout: extra buffer for bento/dashboard */
    GENERATOR_COMPLEX: 10240,
    /** JSON Repair: re-formatted output, moderate */
    JSON_REPAIR: 4096
} as const;

export class InteractionsClient {
    private apiKey: string;

    constructor(apiKey?: string) {
        this.apiKey = apiKey || process.env.API_KEY || '';
        if (!this.apiKey) {
            const errorMsg = `[INTERACTIONS CLIENT ERROR] API_KEY is not configured.

To fix this:
1. Create a .env file in the project root
2. Add: GEMINI_API_KEY=your_api_key_here
3. Get your key from: https://aistudio.google.com/app/apikey
4. Restart the dev server

Current value of process.env.API_KEY: ${process.env.API_KEY === undefined ? 'undefined' : (process.env.API_KEY === '' ? 'empty string' : 'set but hidden')}`;

            console.error(errorMsg);
            throw new Error('API_KEY is required for InteractionsClient. Check console for setup instructions.');
        }
        // Only log on first init (singleton pattern)
        if (!_sharedClient) {
            console.log('[INTERACTIONS CLIENT] Initialized with API key');
        }
    }

    /**
     * Create a new interaction (single turn)
     * Includes automatic retry with exponential backoff for transient errors (500, 503)
     */
    async create(request: InteractionRequest): Promise<InteractionResponse> {
        const MAX_RETRIES = 2;
        const BASE_DELAY_MS = 2000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            console.log(`[INTERACTIONS CLIENT] Sending request to ${request.model || 'model'}${attempt > 1 ? ` (attempt ${attempt}/${MAX_RETRIES})` : ''}...`);

            const controller = new AbortController();
            const timeoutMs = 300_000; // 5 minute timeout
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            // Progress logger
            const startTime = Date.now();
            const progressInterval = setInterval(() => {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                if (elapsed % 10 === 0) { // Log every 10 seconds
                    console.log(`[INTERACTIONS CLIENT] Waiting for response from ${request.model || 'model'}... (${elapsed}s)`);
                }
            }, 1000);

            try {
                const response = await fetch(`${INTERACTIONS_API_BASE}?key=${this.apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(request),
                    signal: controller.signal
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    const status = response.status;

                    // Check for transient errors that warrant retry
                    const isTransient = status === 500 || status === 503 || status === 429;

                    if (isTransient && attempt < MAX_RETRIES) {
                        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff
                        console.warn(`[INTERACTIONS CLIENT] Transient error (${status}). Retrying in ${delay}ms...`);
                        clearTimeout(timeoutId);
                        clearInterval(progressInterval);
                        await new Promise(r => setTimeout(r, delay));
                        continue; // Retry
                    }

                    // Parse and provide actionable guidance for common errors
                    let errorMessage = `Interactions API error (${status}): ${errorText}`;

                    try {
                        const errorJson = JSON.parse(errorText);
                        const message = errorJson?.error?.message || '';

                        // Schema nesting depth error
                        if (message.includes('nesting depth')) {
                            console.error(`[INTERACTIONS CLIENT] Schema nesting depth exceeded.

    The Gemini Interactions API has a maximum schema nesting depth of 4 levels.
    To fix this:
    1. Flatten nested object definitions in your response_format schema
    2. Use simplified array types without deeply nested item schemas
    3. Move complex structure requirements to the prompt instead of schema

    Problematic request model: ${request.model}`);
                        }

                        // Invalid schema error
                        if (message.includes('schema') || message.includes('GenerationConfig')) {
                            console.error(`[INTERACTIONS CLIENT] Schema validation error detected.
    The response_format schema may be invalid or too complex.
    Common issues:
    - Nesting depth exceeds 4 levels
    - Union types (oneOf, anyOf) not supported
    - Circular references
    - Advanced validations (minLength, pattern) not supported`);
                        }

                        // 500 error specific guidance
                        if (status === 500) {
                            console.error(`[INTERACTIONS CLIENT] Internal server error (500).
    This is a server-side issue with the Gemini API.
    Possible causes:
    - Temporary service disruption
    - High API load
    - Invalid request that triggers server error
    Recommended: Wait and retry, or simplify the request.`);
                        }

                        errorMessage = `Interactions API error (${status}): ${message || errorText}`;
                    } catch {
                        // Keep original error if JSON parsing fails
                    }

                    throw new Error(errorMessage);
                }

                const raw = await response.json();
                const normalizedUsage = normalizeUsage(raw);
                if (normalizedUsage) {
                    raw.usage = normalizedUsage;
                } else if (raw?.usage) {
                    raw.usage = normalizeUsage({ usage: raw.usage }) || raw.usage;
                }
                return raw;
            } catch (err: any) {
                if (err.name === 'AbortError') {
                    throw new Error(`Interactions API request timed out after ${timeoutMs / 1000}s`);
                }
                throw err;
            } finally {
                clearTimeout(timeoutId);
                clearInterval(progressInterval);
            }
        }

        // This should never be reached due to the throw above, but TypeScript needs it
        throw new Error('Max retries exceeded');
    }

    /**
     * Retrieve an existing interaction by ID
     */
    async get(interactionId: string): Promise<InteractionResponse> {
        const response = await fetch(`${INTERACTIONS_API_BASE}/${interactionId}?key=${this.apiKey}`, {
            method: 'GET'
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to retrieve interaction: ${error}`);
        }

        return response.json();
    }

    /**
     * Cancel an in-progress interaction
     */
    async cancel(interactionId: string): Promise<InteractionResponse> {
        const response = await fetch(`${INTERACTIONS_API_BASE}/${interactionId}:cancel?key=${this.apiKey}`, {
            method: 'POST'
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to cancel interaction: ${error}`);
        }

        return response.json();
    }
}

// --- Context Folding & Error Unrolling (Phil Schmid + OpenAI Codex patterns) ---

/**
 * Structured tool error result for Error Unrolling pattern.
 * Instead of simple { error: message }, we provide actionable observations
 * that help the model self-correct.
 */
export interface ToolErrorResult {
    success: false;
    error_type: 'validation' | 'runtime' | 'network' | 'not_found' | 'rate_limit' | 'timeout';
    message: string;
    retryable: boolean;
    hint?: string;
    context?: Record<string, unknown>;
}

export interface ToolSuccessResult<T = unknown> {
    success: true;
    data: T;
}

export type ToolResult<T = unknown> = ToolSuccessResult<T> | ToolErrorResult;

/**
 * Classify tool execution errors into structured observations.
 * This helps the model understand WHY a tool failed and HOW to recover.
 */
function classifyToolError(error: Error, toolName: string): ToolErrorResult {
    const msg = error.message.toLowerCase();
    
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('quota')) {
        return {
            success: false,
            error_type: 'rate_limit',
            message: error.message,
            retryable: true,
            hint: 'Wait a moment before retrying this tool call'
        };
    }
    
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('deadline')) {
        return {
            success: false,
            error_type: 'timeout',
            message: error.message,
            retryable: true,
            hint: 'The operation took too long. Try with smaller input or simpler query'
        };
    }
    
    if (msg.includes('not found') || msg.includes('404') || msg.includes('does not exist')) {
        return {
            success: false,
            error_type: 'not_found',
            message: error.message,
            retryable: false,
            hint: 'The requested resource does not exist. Check the identifier or try a different query'
        };
    }
    
    if (msg.includes('validation') || msg.includes('invalid') || msg.includes('schema') || msg.includes('required')) {
        return {
            success: false,
            error_type: 'validation',
            message: error.message,
            retryable: true,
            hint: 'The input did not match expected format. Review the tool schema and correct the arguments'
        };
    }
    
    if (msg.includes('network') || msg.includes('fetch') || msg.includes('connection') || msg.includes('503')) {
        return {
            success: false,
            error_type: 'network',
            message: error.message,
            retryable: true,
            hint: 'Network error occurred. This may be transient - retry may succeed'
        };
    }
    
    // Default to runtime error
    return {
        success: false,
        error_type: 'runtime',
        message: error.message,
        retryable: false,
        hint: `Tool "${toolName}" encountered an unexpected error. Try alternative approach`,
        context: { originalError: error.name }
    };
}

/**
 * Build the input for a multi-turn interaction with Context Folding.
 * 
 * Context Folding (Phil Schmid pattern):
 * - Turn 1: Send full prompt
 * - Turn N>1 with server mode: Send ONLY the tool result (delta), rely on previous_interaction_id
 * - Turn N>1 with client mode: Send full accumulated history
 * 
 * This reduces token costs from O(n²) to O(n) for long agent loops.
 */
function buildContextFoldedInput(
    fullHistory: ContentType[],
    currentDelta: ContentType[],
    mode: 'server' | 'client',
    hasPreviousInteractionId: boolean,
    iteration: number
): ContentType[] {
    // First turn: always send full prompt
    if (iteration === 1) {
        return fullHistory;
    }
    
    // Server mode with valid previous_interaction_id: send only delta
    if (mode === 'server' && hasPreviousInteractionId && currentDelta.length > 0) {
        return currentDelta;
    }
    
    // Client mode or fallback: send full history
    return fullHistory;
}

// --- AGENT RUNNER (Core Loop) ---

/**
 * Run an agent loop with function calling and tool execution.
 * 
 * This implements the standard agent pattern:
 * 1. Send prompt + tool definitions to model
 * 2. If model returns function_call, execute tool client-side
 * 3. Send function_result back to model
 * 4. Repeat until model returns final text or max iterations reached
 */
export async function runAgentLoop(
    prompt: string,
    config: AgentConfig,
    costTracker?: CostTracker
): Promise<{ text: string; logger: AgentLogger; thoughtSignature?: string }> {
    const logger = new AgentLogger();
    // Use singleton client for connection reuse (Phil Schmid best practice)
    const client = getSharedClient();
    const maxIterations = config.maxIterations || 10; // Reduced from 15 per Phil Schmid best practices

    // Build tool declarations for the API
    const toolDeclarations = Object.values(config.tools).map(t => t.definition);

    // Context Folding setup (Phil Schmid pattern)
    const contextMode = config.contextMode || 'server'; // Default to server-side context
    const maxToolRetries = config.maxToolRetries || 3;  // Per-tool retry cap
    
    // Full conversation history (always maintained for fallback)
    let fullHistory: ContentType[] = [{ type: 'text', text: prompt }];
    
    // Delta for current turn (tool results from last iteration)
    let currentDelta: ContentType[] = [];
    
    let previousInteractionId: string | undefined;
    let thoughtSignature: string | undefined = config.initialThoughtSignature;
    
    // Tool error tracking for retry caps
    const toolErrorCounts: Record<string, number> = {};
    
    // Token savings estimation
    let tokensSentWithFolding = 0;
    let tokensSentWithoutFolding = 0;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        logger.logIteration(iteration, 'calling model');

        try {
            // Build context-folded input (Phil Schmid pattern)
            // Turn 1: Full prompt | Turn N with server mode: Only tool results (delta)
            const input = buildContextFoldedInput(
                fullHistory,
                currentDelta,
                contextMode,
                !!previousInteractionId,
                iteration
            );
            
            // Estimate token savings
            const inputTokenEstimate = JSON.stringify(input).length / 4;
            const fullHistoryTokenEstimate = JSON.stringify(fullHistory).length / 4;
            tokensSentWithFolding += inputTokenEstimate;
            tokensSentWithoutFolding += fullHistoryTokenEstimate;

            // Log context folding status
            if (iteration > 1 && contextMode === 'server' && previousInteractionId) {
                const savedTokens = Math.round(fullHistoryTokenEstimate - inputTokenEstimate);
                console.log(`[CONTEXT FOLDING] Iteration ${iteration}: Sending delta only (${Math.round(inputTokenEstimate)} tokens vs ${Math.round(fullHistoryTokenEstimate)} full). Saved ~${savedTokens} tokens`);
            }

            const request: InteractionRequest = {
                model: config.model,
                input: input, // Context-folded input
                system_instruction: config.systemInstruction,
                tools: toolDeclarations.length > 0
                    ? [{ function_declarations: toolDeclarations }]
                    : undefined,
                generation_config: {
                    temperature: config.temperature ?? 0.2,
                    max_output_tokens: config.maxOutputTokens ?? 8192,
                    thinking_level: config.thinkingLevel ?? 'low'
                },
                previous_interaction_id: previousInteractionId
            };

            let response: InteractionResponse;
            try {
                response = await client.create(request);
            } catch (err: any) {
                // Handle server rejecting previous_interaction_id (expired, invalid, etc.)
                if (previousInteractionId && (
                    err.message.includes('previous_interaction_id') ||
                    err.message.includes('interaction not found') ||
                    err.message.includes('invalid interaction')
                )) {
                    console.warn(`[CONTEXT FOLDING] Server rejected previous_interaction_id. Falling back to full history for iteration ${iteration}`);
                    
                    // Retry with full history and no previous_interaction_id
                    request.input = fullHistory;
                    request.previous_interaction_id = undefined;
                    previousInteractionId = undefined; // Reset for future iterations
                    response = await client.create(request);
                } else {
                    throw err;
                }
            }

            const requestedModel = normalizeModelName(config.model);
            const resolvedModel = normalizeModelName(response.model || config.model);
            if (response.model && resolvedModel !== requestedModel) {
                console.log(`[INTERACTIONS CLIENT] Model resolved to ${resolvedModel} (requested ${requestedModel})`);
            }

            // Track costs
            if (costTracker) {
                const usage = normalizeUsage(response);
                if (usage) {
                    costTracker.addUsage(resolvedModel, usage);
                } else {
                    console.warn(`[INTERACTIONS CLIENT] Missing usage metadata for ${resolvedModel}`);
                }
            }

            previousInteractionId = response.id;

            // Process outputs
            const functionCalls: FunctionCall[] = [];
            let finalText = '';

            if (!response.outputs || !Array.isArray(response.outputs)) {
                console.error("[INTERACTIONS CLIENT] Unexpected response structure:", JSON.stringify(response, null, 2));
                throw new Error("Invalid API response: 'outputs' array is missing.");
            }

            for (const output of response.outputs) {
                if (output.type === 'thought' && output.signature) {
                    // Preserve thought signature for Gemini 3
                    thoughtSignature = output.signature;
                    console.log(`[AGENT LOOP] Captured thought signature (${thoughtSignature.length} chars) at iteration ${iteration}`);

                    // Log thought summary if available for debugging
                    if (output.summary && Array.isArray(output.summary)) {
                        const summaryText = output.summary
                            .filter(s => s.type === 'text')
                            .map(s => s.text)
                            .join(' ');
                        if (summaryText) {
                            console.log(`[AGENT LOOP] Thought summary: ${summaryText.substring(0, 150)}...`);
                        }
                    }
                }

                if (output.type === 'function_call') {
                    functionCalls.push(output.function_call);
                }

                if (output.type === 'text') {
                    finalText += output.text;
                }
            }

            // If we have function calls, execute them and continue loop
            if (functionCalls.length > 0 && response.status === 'requires_action') {
                const functionResults: ContentType[] = [];

                for (const call of functionCalls) {
                    const tool = config.tools[call.name];
                    let result: ToolResult<unknown>;
                    const startTime = Date.now();

                    if (!tool) {
                        // Tool not found - not retryable
                        result = {
                            success: false,
                            error_type: 'not_found',
                            message: `Tool "${call.name}" not found`,
                            retryable: false,
                            hint: `Available tools: ${Object.keys(config.tools).join(', ')}`
                        };
                    } else {
                        // Check tool retry cap (Error Unrolling pattern)
                        const errorCount = toolErrorCounts[call.name] || 0;
                        if (errorCount >= maxToolRetries) {
                            result = {
                                success: false,
                                error_type: 'runtime',
                                message: `Tool "${call.name}" has failed ${errorCount} times. Giving up.`,
                                retryable: false,
                                hint: 'This tool is not working reliably. Try an alternative approach or skip this step.'
                            };
                            console.warn(`[ERROR UNROLLING] Tool "${call.name}" exceeded retry cap (${maxToolRetries}). Blocking further attempts.`);
                        } else {
                            try {
                                const data = await tool.execute(call.arguments);
                                result = { success: true, data };
                                // Reset error count on success
                                toolErrorCounts[call.name] = 0;
                            } catch (err: any) {
                                // Increment error count
                                toolErrorCounts[call.name] = errorCount + 1;
                                
                                // Classify error for structured observation (Error Unrolling)
                                result = classifyToolError(err, call.name);
                                
                                console.warn(`[ERROR UNROLLING] Tool "${call.name}" failed (attempt ${errorCount + 1}/${maxToolRetries}): ${result.error_type} - ${result.message}`);
                                if (result.hint) {
                                    console.warn(`[ERROR UNROLLING] Hint to model: ${result.hint}`);
                                }
                            }
                        }
                    }

                    const durationMs = Date.now() - startTime;
                    logger.logToolCall(call.name, call.arguments, result, durationMs);

                    if (config.onToolCall) {
                        config.onToolCall(call.name, call.arguments, result);
                    }

                    functionResults.push({
                        type: 'function_result',
                        function_result: {
                            name: call.name,
                            call_id: call.id || call.name,
                            result
                        }
                    });
                }

                // Update full history with model response and tool results
                fullHistory = [...fullHistory, ...response.outputs, ...functionResults];
                
                // Set delta for next iteration (Context Folding - only send tool results)
                currentDelta = functionResults;
                
                continue;
            }

            // If status is completed or we have final text, return
            if (response.status === 'completed' || finalText) {
                logger.logIteration(iteration, 'completed');
                
                // Log context folding savings
                const totalSaved = Math.round(tokensSentWithoutFolding - tokensSentWithFolding);
                const savingsPercent = tokensSentWithoutFolding > 0 
                    ? Math.round((totalSaved / tokensSentWithoutFolding) * 100)
                    : 0;
                if (totalSaved > 0) {
                    console.log(`[CONTEXT FOLDING] Total savings: ~${totalSaved} tokens (${savingsPercent}% reduction from O(n²) to O(n))`);
                }
                
                return { text: finalText, logger, thoughtSignature };
            }

            // Handle other statuses
            if (response.status === 'failed') {
                throw new Error('Interaction failed');
            }

            if (response.status === 'cancelled') {
                throw new Error('Interaction was cancelled');
            }

        } catch (err: any) {
            console.error(`[AGENT LOOP] Error at iteration ${iteration}:`, err.message);

            // If it's a rate limit or transient error, wait and retry
            if (err.message.includes('429') || err.message.includes('503')) {
                const delay = Math.pow(2, iteration) * 1000;
                console.warn(`[AGENT LOOP] Rate limited. Waiting ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            throw err;
        }
    }

    throw new Error(`Agent exceeded maximum iterations (${maxIterations}). Consider simplifying the task or increasing the limit.`);
}

export async function createInteraction(
    model: string,
    prompt: string,
    options: {
        systemInstruction?: string;
        responseFormat?: any;
        responseMimeType?: string;
        temperature?: number;
        maxOutputTokens?: number;
        thinkingLevel?: ThinkingLevel;
        tools?: { googleSearch?: {} }[];
        /** Phil Schmid Best Practice: Chain interactions for context */
        previousInteractionId?: string;
    } = {},
    costTracker?: CostTracker
): Promise<string> {
    // Use singleton client for connection reuse
    const client = getSharedClient();

    const request: InteractionRequest = {
        model,
        input: prompt,
        system_instruction: options.systemInstruction,
        response_format: options.responseFormat,
        response_mime_type: options.responseMimeType,
        tools: options.tools,
        generation_config: {
            temperature: options.temperature ?? 0.2,
            max_output_tokens: options.maxOutputTokens ?? 8192,
            thinking_level: options.thinkingLevel
        },
        // Phil Schmid: Server-side state management via previous_interaction_id
        previous_interaction_id: options.previousInteractionId
    };

    const response = await client.create(request);

    const requestedModel = normalizeModelName(model);
    const resolvedModel = normalizeModelName(response.model || model);
    if (response.model && resolvedModel !== requestedModel) {
        console.log(`[INTERACTIONS CLIENT] Model resolved to ${resolvedModel} (requested ${requestedModel})`);
    }

    if (costTracker) {
        const usage = normalizeUsage(response);
        if (usage) {
            costTracker.addUsage(resolvedModel, usage);
        } else {
            console.warn(`[INTERACTIONS CLIENT] Missing usage metadata for ${resolvedModel}`);
        }
    }

    // Extract text from outputs
    const outputs = response.outputs || [];

    let extractedText: string | null = null;
    for (const output of outputs) {
        if (output.type === 'text') {
            extractedText = output.text;
            break;
        }
    }

    if (extractedText) {
        // --- CASE 3 FIX: Degenerate output ("0-0-0" or low-entropy loops) ---
        // Degeneration happens when the model gets stuck in repetition loops.
        // FIX STRATEGY: Instead of reducing tokens (which causes truncation), we:
        // 1. Use temperature=0.0 for determinism
        // 2. INCREASE token budget slightly to allow proper JSON completion
        // 3. Add stop sequences implicitly through simpler prompt structure
        if (hasEntropyDegeneration(extractedText)) {
            console.warn(`[INTERACTIONS CLIENT] Degenerate output detected. Reissuing with stabilized config...`);

            // CRITICAL FIX: Don't cap at 1024 - that causes truncation!
            // Instead, use the original budget but with temperature=0 for determinism
            const fallbackMaxTokens = Math.min(options.maxOutputTokens ?? 8192, 4096);
            const retryRequest: InteractionRequest = {
                model,
                input: prompt,
                system_instruction: options.systemInstruction,
                response_format: options.responseFormat,
                response_mime_type: options.responseMimeType,
                generation_config: {
                    temperature: 0.0,  // Deterministic to break repetition loop
                    max_output_tokens: fallbackMaxTokens,
                    thinking_level: undefined  // Disable thinking to maximize output budget
                }
            };

            try {
                const retryResponse = await client.create(retryRequest);
                const retryRequestedModel = normalizeModelName(model);
                const retryResolvedModel = normalizeModelName(retryResponse.model || model);
                if (retryResponse.model && retryResolvedModel !== retryRequestedModel) {
                    console.log(`[INTERACTIONS CLIENT] Model resolved to ${retryResolvedModel} (requested ${retryRequestedModel})`);
                }

                if (costTracker) {
                    const usage = normalizeUsage(retryResponse);
                    if (usage) {
                        costTracker.addUsage(retryResolvedModel, usage);
                    } else {
                        console.warn(`[INTERACTIONS CLIENT] Missing usage metadata for ${retryResolvedModel}`);
                    }
                }

                for (const output of retryResponse.outputs || []) {
                    if (output.type === 'text') {
                        console.log(`[INTERACTIONS CLIENT] Degeneration retry succeeded`);
                        return output.text;
                    }
                }
            } catch (retryErr: any) {
                console.error(`[INTERACTIONS CLIENT] Degeneration retry failed:`, retryErr.message);
            }
        }

        return extractedText;
    }

    // --- CASE 2 FIX: Empty response (thinking exhaustion or API error) ---
    // Model returned no text - likely spent all tokens on thinking, or API returned 500
    // Retry once with thinkingLevel disabled and higher token budget
    if (outputs.length === 0 || !outputs.some((o: any) => o.type === 'text')) {
        console.warn(`[INTERACTIONS CLIENT] Empty response detected. Waiting 2s before retry...`);

        // Wait before retry (500 errors are often transient)
        await new Promise(r => setTimeout(r, 2000));

        console.warn(`[INTERACTIONS CLIENT] Retrying with thinking disabled...`);

        // Retry without thinking to maximize output budget
        const retryRequest: InteractionRequest = {
            model: MODEL_SIMPLE,  // Use simpler model for reliability
            input: prompt,
            system_instruction: options.systemInstruction,
            response_format: options.responseFormat,
            response_mime_type: options.responseMimeType,
            generation_config: {
                temperature: 0.1,  // Lower temp for deterministic output
                max_output_tokens: (options.maxOutputTokens || 8192) + 2048,  // More budget
                thinking_level: undefined  // No thinking
            }
        };

        try {
            const retryResponse = await client.create(retryRequest);
            const retryRequestedModel = normalizeModelName(MODEL_SIMPLE);
            const retryResolvedModel = normalizeModelName(retryResponse.model || MODEL_SIMPLE);
            if (retryResponse.model && retryResolvedModel !== retryRequestedModel) {
                console.log(`[INTERACTIONS CLIENT] Model resolved to ${retryResolvedModel} (requested ${retryRequestedModel})`);
            }

            if (costTracker) {
                const usage = normalizeUsage(retryResponse);
                if (usage) {
                    costTracker.addUsage(retryResolvedModel, usage);
                } else {
                    console.warn(`[INTERACTIONS CLIENT] Missing usage metadata for ${retryResolvedModel}`);
                }
            }

            for (const output of retryResponse.outputs || []) {
                if (output.type === 'text') {
                    const retryText = output.text;
                    
                    // CRITICAL: Check if retry also produced degenerated output
                    // Don't return garbage - let it fall through to Qwen or error handling
                    if (hasEntropyDegeneration(retryText)) {
                        console.warn(`[INTERACTIONS CLIENT] Retry also produced degenerated output - skipping`);
                        break; // Fall through to Qwen fallback
                    }
                    
                    // Check for oversized response (likely degeneration)
                    if (retryText.length > 15000) {
                        console.warn(`[INTERACTIONS CLIENT] Retry produced oversized response (${retryText.length} chars) - skipping`);
                        break; // Fall through to Qwen fallback
                    }
                    
                    console.log(`[INTERACTIONS CLIENT] Retry succeeded with ${MODEL_SIMPLE}`);
                    return retryText;
                }
            }
        } catch (retryErr: any) {
            console.error(`[INTERACTIONS CLIENT] Retry also failed:`, retryErr.message);
        }

        // --- CASE 3: Qwen Fallback ---
        // Both Gemini attempts failed. Try Qwen as last resort.
        // This handles content filtering, persistent rate limits, and server outages.
        console.warn(`[INTERACTIONS CLIENT] Both Gemini attempts failed. Trying Qwen fallback...`);

        const qwenResult = await callQwenFallback(
            typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
            {
                systemInstruction: options.systemInstruction,
                temperature: options.temperature ?? 0.2,
                maxTokens: options.maxOutputTokens ?? 8192,
                responseFormat: options.responseMimeType === 'application/json' ? 'json' : 'text'
            }
        );

        if (qwenResult) {
            console.log(`[INTERACTIONS CLIENT] Qwen fallback succeeded!`);
            return qwenResult;
        }

        console.error(`[INTERACTIONS CLIENT] All attempts (Gemini x2 + Qwen) failed. Returning empty string.`);
    }

    return '';
}

// --- CONVENIENCE: JSON Mode Interaction ---

export async function createJsonInteraction<T = any>(
    model: string,
    prompt: string,
    schema: any,
    options: {
        systemInstruction?: string;
        temperature?: number;
        maxOutputTokens?: number;
        thinkingLevel?: ThinkingLevel;
    } = {},
    costTracker?: CostTracker
): Promise<T> {
    const text = await createInteraction(
        model,
        prompt,
        {
            ...options,
            responseFormat: schema,
            responseMimeType: 'application/json'
        },
        costTracker
    );

    // --- LAYER 0: Early empty response check ---
    // Short-circuit before attempting parse/repair on empty responses
    if (!text || text.trim().length === 0) {
        console.error(`[JSON PARSE] API returned empty response. This usually means:`);
        console.error(`  1. API returned 500/503 error (server-side issue)`);
        console.error(`  2. Rate limiting (429 error)`);
        console.error(`  3. Content was filtered by safety settings`);
        console.error(`Retry the request or check API status.`);
        throw new Error('API returned empty response. Check API status or retry.');
    }

    // --- LAYER 1: Direct Parse ---
    try {
        return JSON.parse(text) as T;
    } catch (err) {
        console.warn(`[JSON PARSE] Initial parse failed, classifying failure...`);
        console.warn(`[JSON PARSE] Text length: ${text.length}, Last 100 chars: "${text.slice(-100)}"`);

        // --- NEW: Classify failure BEFORE attempting repair ---
        const classification = classifyJsonFailure(text);
        console.log(`[JSON REPAIR] Classified as: ${classification.type} (${classification.confidence} confidence)`);

        // --- CRITICAL: Hard limit on response length to prevent browser hang ---
        // Degenerated responses can be 100KB+ and freeze the browser during repair attempts
        const MAX_RESPONSE_LENGTH = 15000; // 15KB is more than enough for any valid slide JSON
        if (text.length > MAX_RESPONSE_LENGTH) {
            console.error(`[JSON REPAIR] Response too long (${text.length} chars > ${MAX_RESPONSE_LENGTH} limit)`);
            console.error(`[JSON REPAIR] This indicates severe LLM degeneration - aborting repair and returning fallback`);
            
            // Return a safe fallback immediately without attempting expensive repairs
            return {
                layoutPlan: {
                    title: "Content Recovery",
                    background: "solid",
                    components: [{
                        type: "text-bullets",
                        title: "Content",
                        content: ["Content generation encountered an issue.", "Please try regenerating this slide."]
                    }]
                },
                speakerNotesLines: ['Slide generation required recovery due to oversized response.'],
                selfCritique: { readabilityScore: 0.5, textDensityStatus: "optimal", layoutAction: "keep" }
            } as T;
        }

        // --- EARLY ABORT: For severe degeneration, skip expensive repair attempts ---
        if (classification.type === 'degeneration' && classification.confidence === 'high') {
            // Check if the degeneration is so severe that repair is pointless
            const last200 = text.slice(-200);
            const repetitionDensity = (last200.match(/([a-z_-]{3,})\1/gi) || []).length;
            
            if (repetitionDensity > 5) {
                console.error(`[JSON REPAIR] Severe degeneration detected (repetition density: ${repetitionDensity})`);
                console.error(`[JSON REPAIR] Skipping repair attempts - returning fallback immediately`);
                
                return {
                    layoutPlan: {
                        title: "Content",
                        background: "solid",
                        components: [{
                            type: "text-bullets",
                            title: "Key Points",
                            content: ["Content generation encountered a processing issue.", "The slide will be regenerated."]
                        }]
                    },
                    speakerNotesLines: ['Slide recovered from degenerated output.'],
                    selfCritique: { readabilityScore: 0.5, textDensityStatus: "optimal", layoutAction: "keep" }
                } as T;
            }
        }

        // --- LAYER 1: String array fallback (MOVED EARLY) ---
        // Check for schema drift BEFORE other repairs to avoid corrupting valid arrays
        if (classification.type === 'string_array') {
            console.warn(`[JSON REPAIR] Schema drift detected: flat string array instead of objects`);
            const stringArrayMatch = text.match(/\[\s*("[^"]*"\s*,?\s*)+\]/);
            if (stringArrayMatch) {
                try {
                    const extractedArray = JSON.parse(stringArrayMatch[0]);
                    if (Array.isArray(extractedArray) && extractedArray.length > 0) {
                        console.warn(`[JSON REPAIR] Converting string array to text-bullets fallback`);
                        return {
                            layoutPlan: {
                                title: "Content",
                                background: "solid",
                                components: [{
                                    type: "text-bullets",
                                    title: "Key Points",
                                    content: extractedArray.slice(0, 5)
                                }]
                            },
                            speakerNotesLines: ['Generated from extracted content.'],
                            selfCritique: { readabilityScore: 0.6, textDensityStatus: "high", layoutAction: "simplify" }
                        } as T;
                    }
                } catch { /* continue to other repairs */ }
            }
        }

        // --- LAYER 1.5: Degeneration fallback (LLM repetition loop) ---
        // When the LLM gets stuck generating repeated enum values, extract what we can
        if (classification.type === 'degeneration') {
            console.warn(`[JSON REPAIR] LLM degeneration detected - attempting to extract valid prefix before repetition`);

            // STRATEGY 1: Find where repetition starts and truncate
            // Look for repeating patterns and find the start position
            let repaired = text;
            
            // Find repetition start by looking for pattern duplicates
            const patterns = [
                /([a-z]{2,}_[a-z]{2,}_[a-z]{2,}_)\1+/gi,  // id_icon_label_id_icon_label...
                /(.{8,30})\1{2,}/g,  // Generic repetition
                /((?:text-bullets|metric-cards|process-flow|icon-grid|chart-frame|diagram-svg)[-_]){3,}/gi
            ];
            
            let earliestRepetitionStart = text.length;
            for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match) {
                    const idx = text.indexOf(match[0]);
                    if (idx > 0 && idx < earliestRepetitionStart) {
                        earliestRepetitionStart = idx;
                        console.warn(`[JSON REPAIR] Found repetition starting at position ${idx}`);
                    }
                }
            }
            
            // Truncate at repetition start and try to salvage
            if (earliestRepetitionStart < text.length) {
                repaired = text.substring(0, earliestRepetitionStart);
                console.warn(`[JSON REPAIR] Truncated at repetition start, keeping ${repaired.length} chars`);
            }

            // Remove any remaining degenerated component type values
            // Pattern: "type": "valid-type-garbage-garbage-garbage..."
            const degeneratedTypePattern = /"type"\s*:\s*"([a-z-]+)(?:[-_][a-z-]+){5,}[^"]*"/gi;
            repaired = repaired.replace(degeneratedTypePattern, (match, validPart) => {
                // Extract just the first valid component type
                const validTypes = ['text-bullets', 'metric-cards', 'process-flow', 'icon-grid', 'chart-frame', 'diagram-svg'];
                const extracted = validTypes.find(t => validPart.toLowerCase().startsWith(t.replace('-', '')))
                    || validTypes.find(t => validPart.toLowerCase().includes(t.split('-')[0]))
                    || 'text-bullets';
                console.warn(`[JSON REPAIR] Extracted base type from degeneration: "${extracted}"`);
                return `"type": "${extracted}"`;
            });
            
            // Also clean up any long garbage strings (id_icon_label_id_icon_label...)
            const longGarbagePattern = /"[a-z_]{50,}"/gi;
            repaired = repaired.replace(longGarbagePattern, '"text-bullets"');

            // Try to parse the cleaned version
            try {
                // Also try closing brackets if needed
                const firstBrace = repaired.indexOf('{');
                if (firstBrace !== -1) {
                    repaired = repaired.substring(firstBrace);
                    
                    // Find the last complete object by tracking depth
                    let depth = 0;
                    let inString = false;
                    let escape = false;
                    let lastCompletePos = -1;
                    
                    for (let i = 0; i < repaired.length; i++) {
                        const char = repaired[i];
                        if (escape) { escape = false; continue; }
                        if (char === '\\') { escape = true; continue; }
                        if (char === '"') { inString = !inString; continue; }
                        if (!inString) {
                            if (char === '{' || char === '[') depth++;
                            else if (char === '}' || char === ']') {
                                depth--;
                                if (depth === 0) {
                                    lastCompletePos = i + 1;
                                }
                            }
                        }
                    }
                    
                    // If we found a complete object, use that
                    if (lastCompletePos > 0 && depth !== 0) {
                        console.warn(`[JSON REPAIR] Using last complete JSON at position ${lastCompletePos}`);
                        repaired = repaired.substring(0, lastCompletePos);
                    } else if (depth > 0) {
                        // Close any open brackets
                        while (depth > 0) {
                            repaired += '}';
                            depth--;
                        }
                    }
                }

                const parsed = JSON.parse(repaired) as T;
                console.log(`[JSON REPAIR] Degeneration repair success!`);
                return normalizeJsonOutput(parsed);
            } catch (degErr) {
                console.warn(`[JSON REPAIR] Degeneration repair failed, trying prefix extraction...`);
                
                // STRATEGY 2: Try to extract any valid JSON prefix
                const prefixResult = extractLongestValidPrefix(repaired);
                if (prefixResult) {
                    try {
                        const parsed = JSON.parse(prefixResult.json) as T;
                        console.log(`[JSON REPAIR] Degeneration prefix extraction success!`);
                        return normalizeJsonOutput(parsed);
                    } catch {
                        console.warn(`[JSON REPAIR] Prefix extraction also failed`);
                    }
                }
                
                // Fall through to truncation repair as backup
            }
        }

        // --- LAYER 2: Prefix Extraction (for garbage_suffix) ---
        // This directly addresses the `, ""` tail pattern
        if (classification.type === 'garbage_suffix') {
            console.log(`[JSON REPAIR] Attempting prefix extraction (garbage suffix detected)...`);
            const prefixResult = extractLongestValidPrefix(text);
            if (prefixResult) {
                console.warn(`[JSON REPAIR] Discarding suffix: "${prefixResult.discarded.slice(0, 50)}..."`);
                try {
                    const parsed = JSON.parse(prefixResult.json) as T;
                    console.log(`[JSON REPAIR] Prefix extraction success!`);
                    return normalizeJsonOutput(parsed);
                } catch {
                    console.warn(`[JSON REPAIR] Prefix extraction parse failed, continuing to truncation repair...`);
                }
            }
        }

        // --- LAYER 3: Truncation Repair (for true truncation) ---
        if (classification.type === 'truncation' || classification.type === 'unknown') {
            console.log(`[JSON REPAIR] Attempting truncation repair...`);

            let repaired = text.trim();
            const firstBrace = repaired.indexOf('{');
            const firstBracket = repaired.indexOf('[');
            if (firstBrace === -1 && firstBracket === -1) {
                throw new Error(`Failed to parse JSON response (no JSON envelope): ${text.substring(0, 200)}`);
            }

            const startIdx = (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace))
                ? firstBracket : firstBrace;
            repaired = repaired.substring(startIdx);

            // Pattern-based truncation fixes
            const truncationPatterns: Array<{ pattern: RegExp; replacement: string | ((m: string) => string) }> = [
                // FIRST: Remove degeneration patterns (o0o0o0, aaaaa, etc.) from token exhaustion
                { pattern: /([a-z0-9])\1{5,}[^"]*$/, replacement: '' },
                { pattern: /,\s*\{\s*"[^"]+"\s*:\s*"[^"]*"?\s*$/, replacement: '' },
                { pattern: /,\s*"[a-zA-Z]{1,3}$/, replacement: '' },
                { pattern: /,\s*"[^"]+"\s*:\s*"[^"]*$/, replacement: '' },
                { pattern: /:\s*$/, replacement: ': null' },
                { pattern: /:\s*\d+$/, replacement: (m: string) => m },
                { pattern: /:\s*"[^"]*$/, replacement: (m: string) => m + '"' },
                { pattern: /,\s*$/, replacement: '' },
                { pattern: /,?\s*\{\s*$/, replacement: '' },
            ];

            for (const { pattern, replacement } of truncationPatterns) {
                if (pattern.test(repaired)) {
                    if (typeof replacement === 'function') {
                        repaired = repaired.replace(pattern, replacement);
                    } else {
                        repaired = repaired.replace(pattern, replacement);
                    }
                }
            }

            // Count brackets and auto-close
            const stack: string[] = [];
            let inString = false;
            let escape = false;

            for (let i = 0; i < repaired.length; i++) {
                const char = repaired[i];
                if (escape) { escape = false; continue; }
                if (char === '\\') { escape = true; continue; }
                if (char === '"') { inString = !inString; continue; }

                if (!inString) {
                    if (char === '{') stack.push('}');
                    else if (char === '[') stack.push(']');
                    else if (char === '}' || char === ']') {
                        if (stack.length > 0 && stack[stack.length - 1] === char) {
                            stack.pop();
                        }
                    }
                }
            }

            if (inString) {
                repaired += '"';
                console.warn(`[JSON REPAIR] Closed unclosed string`);
            }

            if (stack.length > 0) {
                const closers = stack.reverse().join('');
                console.warn(`[JSON REPAIR] Appending closers: "${closers}"`);
                repaired += closers;
            }

            try {
                const parsed = JSON.parse(repaired) as T;
                console.log(`[JSON REPAIR] Truncation repair success!`);
                return normalizeJsonOutput(parsed);
            } catch (truncationErr) {
                console.warn(`[JSON REPAIR] Truncation repair failed, trying semantic cleanup...`);
            }

            // --- LAYER 4: Semantic Cleanup ---
            try {
                let semanticRepair = repaired
                    .replace(/,\s*""\s*}/g, '}')
                    .replace(/,?\s*""\s*\]/g, ']')
                    .replace(/,\s*""(\s*[}\]])/g, '$1')
                    .replace(/,\s*,/g, ',')
                    .replace(/,\s*}/g, '}')
                    .replace(/,\s*\]/g, ']');

                const semanticParsed = JSON.parse(semanticRepair);
                console.log(`[JSON REPAIR] Semantic repair success!`);
                return normalizeJsonOutput(semanticParsed);
            } catch (semanticErr) {
                console.warn(`[JSON REPAIR] Semantic repair also failed`);
            }
        }

        // --- LAYER 5: Model-based Repairer (Escalation) ---
        // As a last resort, use MODEL_SIMPLE with JSON_REPAIRER prompt
        console.warn(`[JSON REPAIR] All heuristic repairs failed. Escalating to model repairer...`);
        try {
            const { runJsonRepair } = await import('./geminiService');
            const repairedByModel = await runJsonRepair(text, schema, costTracker as any);
            if (repairedByModel) {
                console.log(`[JSON REPAIR] Model repairer success!`);
                return normalizeJsonOutput(repairedByModel);
            }
        } catch (modelRepairErr: any) {
            console.error(`[JSON REPAIR] Model repairer failed:`, modelRepairErr.message);
        }

        throw new Error(`Failed to parse JSON response after all repair attempts: ${text.substring(0, 200)}`);
    }
}

/**
 * Normalize JSON output with common field fixes.
 * Applied after successful parse to ensure field consistency.
 */
function normalizeJsonOutput<T>(parsed: any): T {
    if (parsed && typeof parsed === 'object') {
        // Fix selfCritique if malformed
        if (parsed.selfCritique) {
            if (typeof parsed.selfCritique === 'string') {
                parsed.selfCritique = {
                    layoutAction: 'keep',
                    readabilityScore: 0.8,
                    textDensityStatus: 'optimal'
                };
            } else if (typeof parsed.selfCritique === 'object') {
                parsed.selfCritique.layoutAction = parsed.selfCritique.layoutAction || 'keep';
                parsed.selfCritique.readabilityScore =
                    typeof parsed.selfCritique.readabilityScore === 'number'
                        ? parsed.selfCritique.readabilityScore
                        : 0.8;
                parsed.selfCritique.textDensityStatus =
                    parsed.selfCritique.textDensityStatus || 'optimal';
            }
        }

        // Fix speakerNotesLines if missing or contains garbage
        if (!parsed.speakerNotesLines ||
            !Array.isArray(parsed.speakerNotesLines) ||
            parsed.speakerNotesLines.some((n: any) => n === '')) {
            // Filter garbage if array exists, otherwise create default
            if (Array.isArray(parsed.speakerNotesLines)) {
                parsed.speakerNotesLines = parsed.speakerNotesLines.filter(
                    (line: any) => typeof line === 'string' && line.trim().length > 0
                );
                if (parsed.speakerNotesLines.length === 0) {
                    parsed.speakerNotesLines = ['Generated slide.'];
                }
            } else {
                parsed.speakerNotesLines = ['Generated slide.'];
            }
        }
    }
    return parsed as T;
}

// --- EXPORT DEFAULT CLIENT ---

export default InteractionsClient;
