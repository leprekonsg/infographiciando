/**
 * Gemini Service - Legacy compatibility layer
 * 
 * This module now re-exports from the new Interactions API client.
 * New code should import directly from:
 * - `./interactionsClient` for Interactions API functionality
 * - `./slideAgentService` for agent functions
 * 
 * @see https://ai.google.dev/api/interactions-api.md.txt
 */

import { GoogleGenAI, Type, Modality } from "@google/genai";
import { PROMPTS } from "./promptRegistry";

// Re-export Interactions API types for compatibility
export {
  InteractionsClient,
  CostTracker,
  AgentLogger,
  runAgentLoop,
  createInteraction,
  createJsonInteraction,
  type InteractionStatus,
  type InteractionRequest,
  type InteractionResponse,
  type Tool,
  type ToolDefinition,
  type ThinkingLevel
} from "./interactionsClient";

// Re-export generateImageFromPrompt from image module for backward compatibility
export { generateImageFromPrompt } from "./image/imageGeneration";

// Helper to create client instance
const getAiClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    const errorMsg = `[GEMINI SERVICE ERROR] API_KEY is not configured.

To fix this:
1. Create a .env file in the project root
2. Add: GEMINI_API_KEY=your_api_key_here
3. Get your key from: https://aistudio.google.com/app/apikey
4. Restart the dev server`;
    console.error(errorMsg);
    throw new Error('API_KEY is required. Check console for setup instructions.');
  }
  return new GoogleGenAI({ apiKey });
};

// --- PROMPT STRATEGIES ---

// 1. General Negative Prompt: For 3D assets, Stickers, and general visuals where we want pure art, no text.
const NEGATIVE_PROMPT_ART = "text, watermark, labels, ui interface, distorted details, blur, low quality, cartoon, sketch, ugly, messy, clutter, deformed, bad anatomy, crop, cutoff, realistic photo of mundane object";

// 2. Infographic/Slide Negative Prompt: Allows for text-like structures, charts, and layouts, but bans messiness.
// Added specific bans for footer text, borders, and template artifacts.
const NEGATIVE_PROMPT_INFO = "photorealistic, 3d render, messy, clutter, blurry, low resolution, distorted text, bad layout, sketch, hand drawn, organic textures, grunge, footer text, copyright notice, watermark, template borders, frame, mock-up, padding, margins";

// Limit input size to prevent "Unterminated string" errors caused by model truncating massive inputs
const MAX_INPUT_CHARS = 20000;

export interface GeneratedImageResult {
  imageUrl: string;
  sectionTitle: string;
  mode: GenerationMode;
}

interface ContentPagePlan {
  title: string;
  content: string;
  visualConcept: string;
  visualPromptSuggestion: string;
  requiresSearch: boolean;
}

interface GenerationPlan {
  slides: ContentPagePlan[];
  globalVisualStyle: string;
}

export type GenerationMode = 'infographic' | 'presentation' | 'visual-asset' | 'vector-svg' | 'sticker';

const MODEL_SMART = "gemini-3-pro-preview";
const MODEL_FAST = "gemini-3-flash-preview";
const MODEL_SIMPLE = "gemini-2.5-flash"; // Added for simple/pattern-matching tasks
const MODEL_BACKUP = "gemini-2.0-flash";
const MODEL_LITE = "gemini-2.0-flash-lite-preview-02-05";

// Pricing in USD per 1M tokens (Approximation) & Per Image
const PRICING = {
  TOKENS: {
    [MODEL_FAST]: { input: 0.075, output: 0.30 },
    [MODEL_SMART]: { input: 3.50, output: 10.50 },
    [MODEL_BACKUP]: { input: 0.10, output: 0.40 },
    [MODEL_LITE]: { input: 0.075, output: 0.30 }
  },
  IMAGES: {
    'gemini-3-pro-image-preview': 0.134,
    'gemini-2.5-flash-image': 0.039
  }
};

export class TokenTracker {
  totalCost = 0;

  addTokenUsage(model: string, inputTokens: number, outputTokens: number) {
    const rates = PRICING.TOKENS[model as keyof typeof PRICING.TOKENS] || { input: 0, output: 0 };
    const cost = (inputTokens / 1_000_000 * rates.input) + (outputTokens / 1_000_000 * rates.output);
    this.totalCost += cost;
  }

  addImageCost(model: string) {
    const cost = PRICING.IMAGES[model as keyof typeof PRICING.IMAGES] || 0.134;
    this.totalCost += cost;
  }
}

// --- ERROR HANDLING TYPES ---
export type JsonErrorType = 'REPETITION' | 'TRUNCATION' | 'MALFORMED' | 'EMPTY';

export class JsonParseError extends Error {
  constructor(public type: JsonErrorType, public text: string, message: string) {
    super(message);
    this.name = 'JsonParseError';
  }
}

// Helper: robustly extract JSON text from a larger string
function extractJsonBlock(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  if (match && match[1]) return match[1].trim();
  return text.trim();
}

// Robust JSON Repair with Decode Ladder & Auto-Closer
export function cleanAndParseJson(text: string): any {
  if (!text) throw new JsonParseError('EMPTY', '', "Empty response received.");

  // 0. SAFETY: Detect Repetition Loop Hallucination immediately
  // Matches any word (4+ chars) repeated 25+ times with spaces/punctuation
  const repetitionRegex = /(\b\w{4,}\b)(?:[\s,."]*\1){25,}/;
  if (repetitionRegex.test(text)) {
    throw new JsonParseError('REPETITION', text, "Detected repetition loop hallucination.");
  }

  // CIRCUIT BREAKER LOGIC
  if (text.length > 200000) {
    console.warn(`[JSON SAFETY] Output extremely large (${text.length} chars).`);
  }

  let cleaned = extractJsonBlock(text);

  // 1. Find Boundaries (Start { or [ and End } or ])
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');

  if (firstBrace === -1 && firstBracket === -1) {
    throw new JsonParseError('MALFORMED', text.substring(0, 1000), "No JSON envelope found.");
  }

  // Determine start index
  let startIdx = -1;
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    startIdx = firstBracket;
  } else {
    startIdx = firstBrace;
  }

  // Determine end index
  const isArray = cleaned[startIdx] === '[';
  const endChar = isArray ? ']' : '}';
  const lastIdx = cleaned.lastIndexOf(endChar);

  // Slice correctly
  if (lastIdx === -1 || lastIdx <= startIdx) {
    cleaned = cleaned.substring(startIdx); // Truncated, take all we have
  } else {
    cleaned = cleaned.substring(startIdx, lastIdx + 1);
  }

  // 2. Try Standard Parse First
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Continue to repair strategies
  }

  // 3. Heuristic Repair: Auto-Close Truncated JSON
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
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

  // Append missing closers in reverse order
  if (stack.length > 0) {
    const closers = stack.reverse().join('');
    console.warn(`[JSON REPAIR] Detected truncation. Appending: "${closers}"`);
    cleaned += closers;
  }

  // 4. THE DECODE LADDER (Attempt to parse the Auto-Closed string)
  try {
    return JSON.parse(cleaned);
  } catch (e1: any) {
    try {
      const noNewLines = cleaned.replace(/(?<!\\)\n/g, "\\n");
      return JSON.parse(noNewLines);
    } catch (e2: any) {
      console.warn(`[JSON REPAIR] Secondary parse failed: ${e2?.message || e2}`);
    }

    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
      try {
        const firstLayer = JSON.parse(cleaned);
        if (typeof firstLayer === 'string') return JSON.parse(firstLayer);
        return firstLayer;
      } catch (e4: any) {
        console.warn(`[JSON REPAIR] Tertiary parse failed: ${e4?.message || e4}`);
      }
    }

    const isTruncated = stack.length > 0;
    throw new JsonParseError(isTruncated ? 'TRUNCATION' : 'MALFORMED', text.substring(0, 5000), "Heuristic parse failed.");
  }
}

// Fallback Chain Configuration
const FALLBACK_CHAIN: Record<string, string> = {
  [MODEL_SMART]: MODEL_FAST,
  [MODEL_FAST]: MODEL_BACKUP,
  [MODEL_BACKUP]: MODEL_LITE
};

// CIRCUIT BREAKER STATE
const CIRCUIT_BREAKER: Record<string, { failures: number, cooldownUntil: number, threshold: number, duration: number }> = {
  [MODEL_SMART]: { failures: 0, cooldownUntil: 0, threshold: 2, duration: 60000 } // 60s cooldown for Pro
};

function getHealthyModel(requestedModel: string): string {
  const breaker = CIRCUIT_BREAKER[requestedModel];
  if (breaker && Date.now() < breaker.cooldownUntil) {
    console.warn(`[CIRCUIT BREAKER] ${requestedModel} is cooling down. Downgrading to ${MODEL_FAST}.`);
    return MODEL_FAST;
  }
  return requestedModel;
}

function reportFailure(model: string, isQuota: boolean) {
  const breaker = CIRCUIT_BREAKER[model];
  if (breaker && isQuota) {
    breaker.failures++;
    if (breaker.failures >= breaker.threshold) {
      breaker.cooldownUntil = Date.now() + breaker.duration;
      breaker.failures = 0; // Reset
      console.error(`[CIRCUIT BREAKER] ${model} TRIPPED. Downgrading to ${MODEL_FAST} for ${breaker.duration / 1000}s.`);
    }
  }
}

export async function runJsonRepair(brokenJson: string, schema: any, tracker?: TokenTracker): Promise<any> {
  // CIRCUIT BREAKER: Check if input is hopelessly degenerated (don't waste API call)
  const last200 = brokenJson.slice(-200).toLowerCase();
  const degenerationPatterns = [
    /(is_the_correct|the_correct_type|must_be_exactly)/i,
    /(_type_[a-z-]+_){2,}/i,
    /([a-z_-]{4,})\1{4,}/i,
    /([a-z0-9])\1{10,}/
  ];
  
  if (degenerationPatterns.some(p => p.test(last200))) {
    console.warn("[JSON REPAIR] Input is severely degenerated - skipping model repair");
    throw new JsonParseError('MALFORMED', brokenJson.substring(0, 100), "Input too degenerated to repair");
  }

  try {
    // JSON Repair: Pattern matching task → MODEL_SIMPLE (2.5 Flash)
    // 95% cheaper than Pro, sufficient for structural repair (not deep synthesis)
    console.log("[JSON REPAIR] Attempting repair with 2.5 Flash...");
    const safeInput = brokenJson.length > 15000 ? brokenJson.substring(0, 15000) + "...(truncated)" : brokenJson;

    // Add timeout protection to prevent infinite hangs
    const REPAIR_TIMEOUT_MS = 30000; // 30 second max for repair
    const repairPromise = callAI(
      MODEL_SIMPLE,
      PROMPTS.JSON_REPAIRER.TASK(safeInput),
      { mode: 'json', schema: schema, config: { temperature: 0.0, maxOutputTokens: 8192 } }, // temp=0 for deterministic repair
      tracker
    );

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('JSON repair timeout after 30s')), REPAIR_TIMEOUT_MS)
    );

    return await Promise.race([repairPromise, timeoutPromise]);
  } catch (e: any) {
    console.error("[JSON REPAIR] Repair failed:", e.message);
    throw new JsonParseError('MALFORMED', brokenJson.substring(0, 100), "Agent repair failed.");
  }
}

interface CallAIOptions {
  mode: 'json' | 'text';
  config?: any;
  schema?: any; // The JSON Schema object
  systemInstruction?: string;
}

export async function callAI(
  model: string,
  prompt: string,
  options: CallAIOptions,
  tracker?: TokenTracker,
  retryCount = 0
): Promise<any> {
  const MAX_RETRIES_SAME_MODEL = 2;

  // 1. Check Circuit Breaker
  const effectiveModel = getHealthyModel(model);

  // Adjust config if downgraded
  const effectiveConfig = { ...options.config };
  if (effectiveModel !== model) {
    if (effectiveModel === MODEL_FAST || effectiveModel === MODEL_BACKUP) {
      // Remove thinking config if downgraded to a model that might not support it well or to save cost
      if (effectiveConfig.thinkingConfig) delete effectiveConfig.thinkingConfig;
    }
  }

  try {
    const client = getAiClient();

    // --- PREPARE GENERATE CONTENT REQUEST ---
    const config: any = {};

    // System Instruction
    if (options.systemInstruction) {
      config.systemInstruction = options.systemInstruction;
    }

    // Response Format
    if (options.mode === 'json') {
      config.responseMimeType = "application/json";
      if (options.schema) {
        config.responseSchema = options.schema;
      }
    }

    // Tools
    if (effectiveConfig.tools) {
      config.tools = effectiveConfig.tools;
    }

    // Map Standard Configs
    if (effectiveConfig.temperature !== undefined) config.temperature = effectiveConfig.temperature;
    if (effectiveConfig.topP !== undefined) config.topP = effectiveConfig.topP;
    if (effectiveConfig.maxOutputTokens !== undefined) config.maxOutputTokens = effectiveConfig.maxOutputTokens;
    if (effectiveConfig.seed !== undefined) config.seed = effectiveConfig.seed;

    // Map Thinking Config
    if (effectiveConfig.thinkingConfig) {
      // Only add Thinking Config for supported models
      if (effectiveModel.includes('gemini-3') || effectiveModel.includes('gemini-2.5')) {
        config.thinkingConfig = effectiveConfig.thinkingConfig;
      }
    }

    const req = {
      model: effectiveModel,
      contents: prompt,
      config: config
    };

    // Timeout wrapper to prevent hanging indefinitely
    const generatePromise = client.models.generateContent(req);

    // 180s timeout (increased for Thinking models which can take time)
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${effectiveModel} took too long to respond.`)), 180000)
    );

    const response: any = await Promise.race([generatePromise, timeoutPromise]);

    if (tracker && response.usageMetadata) {
      // Support both old TokenTracker and new CostTracker interfaces
      const inputTokens = response.usageMetadata.promptTokenCount || 0;
      const outputTokens = response.usageMetadata.candidatesTokenCount || 0;
      
      if ('addTokenUsage' in tracker && typeof tracker.addTokenUsage === 'function') {
        // Old TokenTracker interface
        tracker.addTokenUsage(effectiveModel, inputTokens, outputTokens);
      } else if ('addUsage' in tracker && typeof tracker.addUsage === 'function') {
        // New CostTracker interface - convert to expected format
        tracker.addUsage(effectiveModel, {
          total_input_tokens: inputTokens,
          total_output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens
        });
      }
    }

    const rawText = response.text || "";

    if (options.mode === 'json') {
      return cleanAndParseJson(rawText || "{}");
    } else {
      return rawText;
    }

  } catch (e: any) {
    if (e instanceof JsonParseError) {
      throw e;
    }

    const errorMessage = e.message || '';
    const status = e.status;

    const isQuota = status === 429 || errorMessage.includes('429') || errorMessage.includes('quota') || errorMessage.includes('RESOURCE_EXHAUSTED');
    const isOverloaded = status === 503 || errorMessage.includes('503') || errorMessage.includes('Overloaded');
    const isTimeout = status === 499 || errorMessage.includes('cancelled') || errorMessage.includes('timeout') || errorMessage.includes('The operation was cancelled');

    if (effectiveModel === model) {
      reportFailure(model, isQuota || isOverloaded || isTimeout);
    }

    if ((isQuota || isOverloaded || isTimeout) && retryCount < MAX_RETRIES_SAME_MODEL) {
      const delay = Math.pow(2, retryCount + 1) * 1000 + Math.random() * 500;
      console.warn(`[AI SERVICE WARN] ${effectiveModel} failed (${status || 'timeout'}). Retrying in ${Math.round(delay)}ms (Attempt ${retryCount + 1})...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return callAI(effectiveModel, prompt, options, tracker, retryCount + 1);
    }

    // FALLBACK LOGIC
    const nextModel = FALLBACK_CHAIN[effectiveModel];

    if ((isQuota || isOverloaded || isTimeout) && nextModel) {
      console.warn(`[AI SERVICE WARN] Exhausted retries for ${effectiveModel}. Falling back to ${nextModel}.`);

      const newConfig = { ...effectiveConfig };
      // Strip thinking for basic models
      if ((nextModel === MODEL_BACKUP || nextModel === MODEL_LITE)) {
        if (newConfig.thinkingConfig) delete newConfig.thinkingConfig;
      }
      if (nextModel === MODEL_FAST || nextModel === MODEL_BACKUP) {
        newConfig.temperature = 0.1;
        newConfig.topP = 0.8;
      }

      return callAI(nextModel, prompt, { ...options, config: newConfig }, tracker, 0);
    }

    if (isOverloaded) {
      throw new Error("Service Unavailable (503). All models overloaded. Please try again later.");
    }

    console.error(`[AI SERVICE ERROR] Call Failed on ${effectiveModel}`, e);
    throw new Error(`AI Call Failed: ${errorMessage}`);
  }
}


// --- EXISTING GENERATION LOGIC ---

// Robust JSON Extractor
const extractJson = (text: string): string => {
  if (!text) return "{}";

  let content = text;

  // 1. Try to extract from markdown code block first
  const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch && jsonBlockMatch[1]) {
    content = jsonBlockMatch[1];
  }

  // 2. Find the first '{' and the last '}'
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return content.substring(firstBrace, lastBrace + 1);
  }

  // If we cannot find a valid JSON envelope, return empty object.
  return "{}";
};

// SVG Extractor
const extractSvg = (text: string): string => {
  if (!text) return "";

  const firstTag = text.indexOf('<svg');
  const lastTag = text.lastIndexOf('</svg>');

  if (firstTag !== -1 && lastTag !== -1) {
    return text.substring(firstTag, lastTag + 6);
  }

  // Fallback
  return text.replace(/```(?:xml|svg)?/g, "").trim();
};

// --- IMAGE PROCESSING UTILITIES ---
// Client-side background removal for "Sticker" mode
const removeWhiteBackground = (base64Data: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64Data);
        return;
      }

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      // Threshold for "White" (0-255)
      // Since we prompt for "pure white", we can be aggressive.
      const threshold = 240;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // If pixel is significantly white
        if (r > threshold && g > threshold && b > threshold) {
          data[i + 3] = 0; // Set Alpha to 0 (Transparent)
        }
      }

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = (e) => {
      console.warn("Background removal failed, returning original.", e);
      resolve(base64Data);
    };
    img.src = base64Data;
  });
};

// Retry utility for transient errors
const callWithRetry = async <T>(
  operation: () => Promise<T>,
  onRetry: (attempt: number, delayMs: number) => void
): Promise<T> => {
  const MAX_RETRIES = 3;
  let lastError: any;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      // Check for transient errors
      const isTransient =
        err.status === 503 ||
        err.status === 429 ||
        (err.message && err.message.toLowerCase().includes('overloaded'));

      if (attempt <= MAX_RETRIES && isTransient) {
        // Exponential backoff: 2s, 4s, 8s
        const delayMs = 2000 * Math.pow(2, attempt - 1);
        onRetry(attempt, delayMs);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
};


// NOTE: generateImageFromPrompt has been moved to slideAgentService.ts
// and is re-exported from the top of this file for backward compatibility.


// --- RLM CORE: THE ROOT ARCHITECT ---
const analyzeAndPlanContent = async (markdown: string, mode: GenerationMode): Promise<GenerationPlan> => {
  const ai = getAiClient();

  // Truncate input to avoid huge contexts that might cause response truncation
  const safeMarkdown = markdown.length > MAX_INPUT_CHARS
    ? markdown.substring(0, MAX_INPUT_CHARS) + "\n...(truncated source)..."
    : markdown;

  const generatePlanWithModel = async (modelName: string, enableThinking: boolean) => {

    // RLM STRATEGY: HIERARCHICAL PROMPTING (Using System Instructions)
    let systemInstruction = "";

    const baseRole = `You are a world-class Visual Information Architect.`;

    if (mode === 'presentation') {
      systemInstruction = `${baseRole} You are acting as a Presentation Designer.
      
      GOAL: Create polished, high-fidelity presentation slides.
      
      STRATEGY:
      1. [DECOMPOSE]: Split the content into 3-5 key slides.
      2. [SLIDE COMPOSITION]: For each slide, determine the visual composition.
         - Is it a "Title Slide" (Impactful visual)?
         - Is it a "Content Slide" (Clean background with side visual)?
         - Is it a "Data Slide" (Chart focus)?
      3. [VISUALIZE]: The 'visualPromptSuggestion' must describe the FULL SLIDE IMAGE.
         - Describe a professional background with integrated graphical elements representing the concept.
         - Example: "A sleek dark mode slide background with a glowing abstract data stream on the right side, space for text on the left."`;
    } else if (mode === 'infographic') {
      systemInstruction = `${baseRole} You are acting as a Senior Data Journalist.
      
      GOAL: Transform text into structured, informative visual layouts.
      
      STRATEGY:
      1. [STRUCTURAL ANALYSIS]: Determine the best information architecture (Timeline, Process Flow, Comparison, Hierarchy, or Statistics).
      2. [LAYOUT DESIGN]: Imagine a vertical infographic layout (full bleed, no margins).
      3. [VISUALIZE]: The 'visualPromptSuggestion' must describe the LAYOUT and DIAGRAMS.
         - Use terms like: "Vertical flowchart", "Split screen comparison", "Step-by-step roadmap".
         - Style: "Flat vector style, clean lines, professional business aesthetic".`;
    } else if (mode === 'vector-svg') {
      systemInstruction = `${baseRole} You are acting as a Master Iconographer.
      
      GOAL: Simplify complex ideas into elegant, geometric vector symbols.
      
      STRATEGY:
      1. [REDUCTION]: Reduce the paragraph to a single noun or action.
      2. [GEOMETRY]: Imagine the concept using basic shapes (circles, lines, rounded rects).
      3. [VISUALIZE]: The 'visualPromptSuggestion' must describe the geometry and composition of an icon.
         - Focus on: "Monoline style", "Geometric shapes", "Symmetry", "Negative space".`;
    } else if (mode === 'sticker') {
      systemInstruction = `${baseRole} You are acting as a Corporate Identity Designer.
      
      GOAL: Create professional, cohesive die-cut stickers.
      
      STRATEGY:
      1. [DEEP UNDERSTANDING]: Analyze specific business concepts for centrality and consistency.
      2. [METAPHOR SELECTION]: Select a physical object that embodies this specific nuance (e.g., Central Hub, Master Key, Prism).
      3. [VISUALIZATION]: Describe this object as a high-quality die-cut sticker.
         - Mandatory keywords: "Die-cut sticker, flat vector style, white border, professional, isolated on pure white background".`;
    } else {
      // Visual Asset (3D)
      systemInstruction = `${baseRole} You are acting as a Conceptual 3D Artist.
      
      GOAL: Translate abstract business concepts into sophisticated 3D illustrations.
      
      STRATEGY:
      1. [SYNTHESIS]: Identify the core abstract concept.
      2. [METAPHOR]: Create a clever visual metaphor (e.g., "Glowing crystalline data block" instead of "document").
      3. [VISUALIZE]: The 'visualPromptSuggestion' must be a polished, abstract 3D composition.
         - Mandatory keywords: "Abstract 3D render, glassmorphism, subsurface scattering, minimalist high-tech, soft studio lighting, on pure white background".`;
    }

    const taskPrompt = `
      INPUT SOURCE:
      ${safeMarkdown}

      OUTPUT FORMAT:
      Return a JSON object conforming to the schema, containing 'globalVisualStyle' and a list of 'slides'.
    `;

    const responseFormat = {
      type: Type.OBJECT,
      properties: {
        globalVisualStyle: { type: Type.STRING },
        slides: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              content: { type: Type.STRING },
              visualConcept: { type: Type.STRING },
              visualPromptSuggestion: { type: Type.STRING },
              requiresSearch: { type: Type.BOOLEAN }
            },
            required: ["title", "content", "visualConcept", "visualPromptSuggestion", "requiresSearch"]
          }
        }
      },
      required: ["globalVisualStyle", "slides"]
    };

    try {
      const response = await callWithRetry<any>(
        () => ai.models.generateContent({
          model: modelName,
          contents: taskPrompt,
          config: {
            systemInstruction: systemInstruction,
            responseMimeType: "application/json",
            responseSchema: responseFormat,
            thinkingConfig: enableThinking ? { thinkingBudget: 2048 } : undefined
          }
        }),
        (attempt, delay) => console.log(`Planning retry attempt ${attempt}...`)
      );

      const rawText = response.text;
      if (!rawText) throw new Error("Empty response from AI model");

      const cleanedJson = extractJson(rawText);
      try {
        return JSON.parse(cleanedJson) as GenerationPlan;
      } catch (e) {
        console.error("JSON Parse Error. Input length:", cleanedJson.length);
        throw new Error("Failed to parse AI response. The output may have been truncated or malformed.");
      }

    } catch (error) {
      console.error("Planning Error:", error);
      throw new Error("Failed to plan content structure. Please try again.");
    }
  };

  return await generatePlanWithModel('gemini-3-flash-preview', true);
};

// --- RLM CORE: THE EXECUTOR ---
export const generateVisualContent = async (
  markdown: string,
  mode: GenerationMode,
  onResult: (result: GeneratedImageResult) => void,
  onStatus: (status: string) => void
): Promise<void> => {

  const ai = getAiClient();
  onStatus(`Analyzing for ${mode}...`);

  let plan: GenerationPlan;
  try {
    plan = await analyzeAndPlanContent(markdown, mode);
  } catch (e: any) {
    throw e;
  }

  const globalStyle = plan.globalVisualStyle;

  for (let i = 0; i < plan.slides.length; i++) {
    const page = plan.slides[i];
    onStatus(`Rendering ${mode} component ${i + 1}/${plan.slides.length}: ${page.title}...`);

    if (mode === 'vector-svg') {
      // --- SVG CODE GENERATION PATH ---
      const svgSystemInstruction = `You are an expert SVG artist and coder.
        Your goal is to create high-quality, modern, flat vector illustrations.
        
        CONSTRAINTS:
        - Format: Provide valid <svg> code ONLY. No comments.
        - Style: Minimalist, Tech-focused, Geometric, Professional.
        - Colors: Use Emerald (#10b981), White (#ffffff), Slate (#94a3b8), and Amber (#f59e0b). 
        - Background: TRANSPARENT. Do not include a background rectangle.
        - Dimensions: viewBox="0 0 512 512".
        - Strokes: Use clean strokes and fills. Ensure paths are closed.`;

      const svgPrompt = `
        VISUAL CONCEPT: ${page.visualConcept}
        PROMPT: ${page.visualPromptSuggestion}
        STYLE: ${globalStyle}
        
        OUTPUT: RAW SVG STRING ONLY.
      `;

      try {
        const response = await callWithRetry<any>(
          () => ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: svgPrompt,
            config: {
              systemInstruction: svgSystemInstruction,
              thinkingConfig: { thinkingBudget: 1024 }
            }
          }),
          (attempt, delay) => onStatus(`System overloaded. Retrying SVG ${page.title} (Attempt ${attempt})...`)
        );

        const rawText = response.text;
        if (rawText) {
          const svgCode = extractSvg(rawText);
          const encodedSvg = encodeURIComponent(svgCode);
          const dataUrl = `data:image/svg+xml;charset=utf-8,${encodedSvg}`;

          onResult({
            imageUrl: dataUrl,
            sectionTitle: page.title,
            mode
          });
        }
      } catch (err: any) {
        console.error(`Failed to generate SVG for ${page.title}`, err);
      }

    } else {
      // --- RASTER IMAGE GENERATION PATH (WITH FALLBACK) ---

      const models = ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image'];
      let aspectRatio = "1:1";
      let finalPrompt = "";
      let tools: any[] = [];

      // Mode-Specific Prompt Construction
      if (mode === 'visual-asset') {
        aspectRatio = "1:1";
        finalPrompt = `
        SUBJECT: ${page.visualPromptSuggestion}
        STYLE: ${globalStyle}. High-end Abstract 3D Art. Isolated on white background.
        NEGATIVE: ${NEGATIVE_PROMPT_ART}
        `;
      } else if (mode === 'presentation') {
        aspectRatio = "16:9";
        finalPrompt = `
        SUBJECT: ${page.visualPromptSuggestion}
        STYLE: ${globalStyle}. Professional Presentation Slide. High-fidelity background with abstract data elements.
        NEGATIVE: ${NEGATIVE_PROMPT_INFO}
        `;
      } else if (mode === 'infographic') {
        aspectRatio = "3:4";
        // Explicitly asking for a poster layout with charts/data
        finalPrompt = `
        DESIGN: A full-bleed vertical infographic.
        TOPIC: ${page.visualPromptSuggestion}
        STYLE: ${globalStyle}. Flat vector art, organized layout, clear sections, data visualization, flowcharts.
        LAYOUT: Edge-to-edge content. No white borders. No margins. No footer text.
        DETAILS: Use solid colors, clean geometry, and infographic elements (icons, connectors, bar charts).
        NEGATIVE: ${NEGATIVE_PROMPT_INFO}
        `;
      } else if (mode === 'sticker') {
        aspectRatio = "1:1";
        // Stickers often require higher fidelity or tools support if complex
        finalPrompt = `
        SUBJECT: ${page.visualPromptSuggestion}
        STYLE: ${globalStyle}. Die-cut sticker, clean vector finish, professional design.
        CONSTRAINT: ISOLATED ON PURE WHITE BACKGROUND (#FFFFFF).
        NEGATIVE: ${NEGATIVE_PROMPT_ART}, photo, realistic, shadow, gradient background, noise, grunge, distressed
        `;
        tools = [{ googleSearch: {} }];
      }

      // Fallback Loop for Raster Images
      let success = false;
      for (const modelName of models) {
        if (success) break;
        try {
          const generateConfig: any = {
            imageConfig: { aspectRatio },
            responseModalities: [Modality.TEXT, Modality.IMAGE]
          };

          // Only add tools if model supports it (Pro models mainly)
          if (tools.length > 0 && modelName.includes('pro')) {
            generateConfig.tools = tools;
          }

          const response = await ai.models.generateContent({
            model: modelName,
            contents: { parts: [{ text: finalPrompt }] },
            config: generateConfig
          });

          if (response.candidates?.[0]?.content?.parts) {
            let foundImage = false;
            for (const part of response.candidates[0].content.parts) {
              if (part.inlineData?.data) {
                let base64Image = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;

                // Post-Processing for Stickers: Remove Background
                if (mode === 'sticker') {
                  onStatus(`Processing transparency for ${page.title}...`);
                  base64Image = await removeWhiteBackground(base64Image);
                }

                onResult({
                  imageUrl: base64Image,
                  sectionTitle: page.title,
                  mode
                });
                foundImage = true;
                success = true;
                break;
              }
            }
            if (!foundImage) console.warn(`No image found for ${page.title} with ${modelName}`);
          }
        } catch (err: any) {
          const isQuota = err.status === 429 || (err.message && (err.message.includes('429') || err.message.includes('quota')));
          if (isQuota && modelName !== models[models.length - 1]) {
            console.warn(`Quota exceeded for ${modelName}, failing over...`);
            continue;
          }
          console.error(`Failed to generate image for ${page.title} with ${modelName}`, err);
        }
      }
    }
  }
  onStatus("Done");
};
