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

export interface AgentConfig {
    model: string;
    systemInstruction: string;
    tools: Record<string, Tool>;
    maxIterations?: number;
    thinkingLevel?: ThinkingLevel;
    temperature?: number;
    maxOutputTokens?: number;
    onToolCall?: (name: string, args: any, result: any) => void;
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

export class CostTracker {
    totalCost = 0;
    totalInputTokens = 0;
    totalOutputTokens = 0;
    totalReasoningTokens = 0;
    totalSavingsVsPro = 0;
    private modelUsage: Map<string, { calls: number; cost: number }> = new Map();

    addUsage(model: string, usage: InteractionResponse['usage']): void {
        if (!usage) return;

        this.totalInputTokens += usage.total_input_tokens || 0;
        this.totalOutputTokens += usage.total_output_tokens || 0;
        this.totalReasoningTokens += usage.total_reasoning_tokens || 0;

        const rates = PRICING.TOKENS[model as keyof typeof PRICING.TOKENS] || { input: 0.10, output: 0.40 };
        const cost = (usage.total_input_tokens / 1_000_000 * rates.input) +
            (usage.total_output_tokens / 1_000_000 * rates.output);
        this.totalCost += cost;

        // Calculate savings vs Pro
        const proCost = (usage.total_input_tokens / 1_000_000 * PRO_RATES.input) +
            (usage.total_output_tokens / 1_000_000 * PRO_RATES.output);
        const savings = proCost - cost;
        this.totalSavingsVsPro += savings;

        // Track per-model usage
        const existing = this.modelUsage.get(model) || { calls: 0, cost: 0 };
        this.modelUsage.set(model, { calls: existing.calls + 1, cost: existing.cost + cost });

        // Log savings for visibility
        if (savings > 0.0001) {
            console.log(`💰 [COST] ${model}: $${cost.toFixed(4)} (saved $${savings.toFixed(4)} vs Pro)`);
        }
    }

    addImageCost(model: string): void {
        const cost = PRICING.IMAGES[model as keyof typeof PRICING.IMAGES] || 0.134;
        this.totalCost += cost;
    }

    getSummary(): {
        totalCost: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalReasoningTokens: number;
        totalSavingsVsPro: number;
        modelBreakdown: Record<string, { calls: number; cost: number }>;
    } {
        return {
            totalCost: this.totalCost,
            totalInputTokens: this.totalInputTokens,
            totalOutputTokens: this.totalOutputTokens,
            totalReasoningTokens: this.totalReasoningTokens,
            totalSavingsVsPro: this.totalSavingsVsPro,
            modelBreakdown: Object.fromEntries(this.modelUsage)
        };
    }
}

// --- INTERACTIONS API CLIENT ---

const INTERACTIONS_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/interactions';

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
        console.log('[INTERACTIONS CLIENT] Initialized with API key');
    }

    /**
     * Create a new interaction (single turn)
     */
    async create(request: InteractionRequest): Promise<InteractionResponse> {
        console.log(`[INTERACTIONS CLIENT] Sending request to ${request.model || 'model'}...`);

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

                // Parse and provide actionable guidance for common errors
                let errorMessage = `Interactions API error (${response.status}): ${errorText}`;

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

                    errorMessage = `Interactions API error (${response.status}): ${message || errorText}`;
                } catch {
                    // Keep original error if JSON parsing fails
                }

                throw new Error(errorMessage);
            }

            return response.json();
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
    const client = new InteractionsClient();
    const maxIterations = config.maxIterations || 15;

    // Build tool declarations for the API
    const toolDeclarations = Object.values(config.tools).map(t => t.definition);

    // Conversation contents (multi-turn)
    let contents: ContentType[] = [{ type: 'text', text: prompt }];
    let previousInteractionId: string | undefined;
    let thoughtSignature: string | undefined;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        logger.logIteration(iteration, 'calling model');

        try {
            const request: InteractionRequest = {
                model: config.model,
                input: contents,
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

            const response = await client.create(request);

            // Track costs
            if (costTracker) {
                costTracker.addUsage(config.model, response.usage);
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
                    let result: any;
                    const startTime = Date.now();

                    if (tool) {
                        try {
                            result = await tool.execute(call.arguments);
                        } catch (err: any) {
                            result = { error: `Tool execution failed: ${err.message}` };
                        }
                    } else {
                        result = { error: `Tool "${call.name}" not found` };
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

                // Add model response and our tool results to conversation
                contents = [...contents, ...response.outputs, ...functionResults];
                continue;
            }

            // If status is completed or we have final text, return
            if (response.status === 'completed' || finalText) {
                logger.logIteration(iteration, 'completed');
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

// --- SIMPLE INTERACTION (Non-agentic, single turn) ---

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
    } = {},
    costTracker?: CostTracker
): Promise<string> {
    const client = new InteractionsClient();

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
        }
    };

    const response = await client.create(request);

    if (costTracker) {
        costTracker.addUsage(model, response.usage);
    }

    // Extract text from outputs
    // Note: Some models (thinking models) might return 'thought' chunks but no final 'text' if they get stuck or hit token limits.
    // We should handle empty outputs gracefully.
    const outputs = response.outputs || [];

    if (outputs.length === 0) {
        console.warn("[INTERACTIONS CLIENT] Response contained no outputs (Thinking only or empty).");
    }

    for (const output of outputs) {
        if (output.type === 'text') {
            return output.text;
        }
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

    // Robust JSON parsing with truncation repair
    try {
        return JSON.parse(text) as T;
    } catch (err) {
        console.warn(`[JSON PARSE] Initial parse failed, attempting repair...`);
        console.warn(`[JSON PARSE] Text length: ${text.length}, Last 100 chars: "${text.slice(-100)}"`);

        // Try to repair truncated JSON by auto-closing brackets
        let repaired = text.trim();

        // Find the actual JSON start
        const firstBrace = repaired.indexOf('{');
        const firstBracket = repaired.indexOf('[');
        if (firstBrace === -1 && firstBracket === -1) {
            throw new Error(`Failed to parse JSON response (no JSON envelope): ${text.substring(0, 200)}`);
        }

        const startIdx = (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace))
            ? firstBracket : firstBrace;
        repaired = repaired.substring(startIdx);

        // ENHANCED: Detect and fix mid-value truncation patterns
        // Pattern: "la (truncated from "label") or :10 (truncated number)
        const truncationPatterns: Array<{ pattern: RegExp; replacement: string | ((m: string) => string) }> = [
            // Truncated key: "la -> remove incomplete key-value pair
            { pattern: /,\s*"[a-zA-Z]{1,3}$/, replacement: '' },
            // Truncated after colon: "key": -> add null
            { pattern: /:\s*$/, replacement: ': null' },
            // Truncated number: :10 without closing -> keep as-is (valid)
            { pattern: /:\s*\d+$/, replacement: (m: string) => m },
            // Truncated string value: "value -> close it
            { pattern: /:\s*"[^"]*$/, replacement: (m: string) => m + '"' },
            // Trailing comma before truncation
            { pattern: /,\s*$/, replacement: '' },
        ];

        for (const { pattern, replacement } of truncationPatterns) {
            if (pattern.test(repaired)) {
                const before = repaired.slice(-50);
                if (typeof replacement === 'function') {
                    repaired = repaired.replace(pattern, replacement);
                } else {
                    repaired = repaired.replace(pattern, replacement);
                }
                console.warn(`[JSON REPAIR] Applied pattern fix: "${before}" → "${repaired.slice(-50)}"`);
            }
        }


        // Count open brackets and braces to determine what's missing
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

        // If we're in the middle of a string, close it first
        if (inString) {
            repaired += '"';
            console.warn(`[JSON REPAIR] Closed unclosed string`);
        }

        // Append missing closers
        if (stack.length > 0) {
            const closers = stack.reverse().join('');
            console.warn(`[JSON REPAIR] Truncation detected at: "${repaired.slice(-50)}" → Appending: "${closers}"`);
            repaired += closers;
        }

        try {
            const parsed = JSON.parse(repaired) as T;
            console.log(`[JSON REPAIR] Success! Repaired JSON preview:`, JSON.stringify(parsed).slice(0, 500));
            return parsed;
        } catch (repairErr) {
            // Log more context for debugging
            console.error(`[JSON REPAIR] Repair failed. Original length: ${text.length}, Truncated: ${text.length > 1000}`);
            console.error(`[JSON REPAIR] Last 200 chars after repair: "${repaired.slice(-200)}"`);

            // LAST-DITCH: String-array fallback for pattern like ["item1", "item2", ...]
            // The LLM sometimes returns flat string arrays instead of object arrays
            const stringArrayMatch = text.match(/\[\s*("[^"]*"\s*,?\s*)+\]/);
            if (stringArrayMatch) {
                try {
                    const extractedArray = JSON.parse(stringArrayMatch[0]);
                    if (Array.isArray(extractedArray) && extractedArray.length > 0) {
                        console.warn(`[JSON REPAIR] Found string array, converting to text-bullets fallback`);
                        // Return a minimal valid structure that downstream can repair
                        return {
                            layoutPlan: {
                                title: "Content",
                                background: "solid",
                                components: [{
                                    type: "text-bullets",
                                    title: "Key Points",
                                    content: extractedArray.slice(0, 5) // Limit to 5 items
                                }]
                            },
                            speakerNotesLines: [],
                            selfCritique: { readabilityScore: 0.6, textDensityStatus: "high", layoutAction: "simplify" }
                        } as T;
                    }
                } catch { /* ignore extraction failure */ }
            }

            throw new Error(`Failed to parse JSON response: ${text.substring(0, 200)}`);
        }
    }
}

// --- EXPORT DEFAULT CLIENT ---

export default InteractionsClient;
