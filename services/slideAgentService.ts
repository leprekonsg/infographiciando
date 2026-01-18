
import { GoogleGenAI, Type } from "@google/genai";
import { 
  EditableSlideDeck, SlideNode, OutlineSchema, SLIDE_TYPES, GlobalStyleGuide, 
  ResearchFact, RouterDecision, RouterDecisionSchema, SlideNodeSchema, LayoutVariantSchema, RenderModeSchema,
  FactClusterSchema
} from "../types/slideTypes";
import { generateImageFromPrompt } from "./geminiService";
import { PROMPTS } from "./promptRegistry";
import { validateSlide } from "./validators";
import { z } from "zod";

const MODEL_SMART = "gemini-3-pro-preview"; 
const MODEL_FAST = "gemini-3-flash-preview"; 
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

class TokenTracker {
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

// Robust JSON Repair for LLM Truncation
function cleanAndParseJson(text: string): any {
  if (!text) return {};
  
  // CIRCUIT BREAKER: Relaxed limit from 50k to 100k to allow for large slides
  if (text.length > 100000) {
      console.warn(`[JSON SAFETY] Output extremely large (${text.length} chars). Attempting parse with caution.`);
  }

  let cleaned = text.trim();
  
  // 1. Try to extract from markdown code block first
  const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  if (jsonBlockMatch && jsonBlockMatch[1]) {
    cleaned = jsonBlockMatch[1].trim();
  } else {
    // 2. Fallback: Find the first '{' and the last '}'
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    
    if (firstBrace === -1 && firstBracket === -1) return {};

    let startIdx = -1;
    let endIdx = -1;

    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
        startIdx = firstBracket;
        endIdx = cleaned.lastIndexOf(']');
    } else {
        startIdx = firstBrace;
        endIdx = cleaned.lastIndexOf('}');
    }
    
    // If we have a start but the end is weird or missing (truncation), take everything to the end
    if (startIdx !== -1) {
        if (endIdx !== -1 && endIdx > startIdx) {
            cleaned = cleaned.substring(startIdx, endIdx + 1);
        } else {
            cleaned = cleaned.substring(startIdx);
        }
    }
  }
  
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // REPAIR STRATEGY
    let repaired = cleaned;

    // 1. Check for unclosed string
    // Simple check: count unescaped quotes. If odd, add a quote.
    let quoteCount = 0;
    for (let i = 0; i < repaired.length; i++) {
        if (repaired[i] === '"' && (i === 0 || repaired[i-1] !== '\\')) {
            quoteCount++;
        }
    }
    if (quoteCount % 2 !== 0) {
        repaired += '"';
    }

    // 2. Remove trailing commas before closing braces/brackets
    repaired = repaired.replace(/,\s*([\]}])/g, '$1');

    // 3. Balance Braces
    const stack = [];
    let insideString = false;
    for (let i = 0; i < repaired.length; i++) {
        const char = repaired[i];
        if (char === '"' && (i===0 || repaired[i-1] !== '\\')) {
            insideString = !insideString;
            continue;
        }
        if (insideString) continue;

        if (char === '{' || char === '[') stack.push(char);
        if (char === '}') {
            if (stack.length > 0 && stack[stack.length - 1] === '{') stack.pop();
        }
        if (char === ']') {
             if (stack.length > 0 && stack[stack.length - 1] === '[') stack.pop();
        }
    }

    while (stack.length > 0) {
        const char = stack.pop();
        if (char === '{') repaired += '}';
        if (char === '[') repaired += ']';
    }

    try {
        return JSON.parse(repaired);
    } catch (e2) {
        console.error("JSON PARSE FATAL. INVALID TEXT START:", cleaned.substring(0, 100) + "..."); 
        return {};
    }
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
            console.error(`[CIRCUIT BREAKER] ${model} TRIPPED. Downgrading to ${MODEL_FAST} for ${breaker.duration/1000}s.`);
        }
    }
}

async function callAI(
    model: string, 
    prompt: string, 
    config: any = {}, 
    tracker?: TokenTracker, 
    systemInstruction?: string,
    retryCount = 0
): Promise<any> {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const MAX_RETRIES_SAME_MODEL = 2; 

    // 1. Check Circuit Breaker
    const effectiveModel = getHealthyModel(model);
    
    // Adjust config if downgraded (e.g. Flash doesn't support 'thinkingConfig' optimally or same params)
    const effectiveConfig = { ...config };
    if (effectiveModel !== model) {
        if (effectiveModel === MODEL_FAST || effectiveModel === MODEL_BACKUP) {
            delete effectiveConfig.thinkingConfig;
        }
    }

    try {
        const finalConfig = { 
            responseMimeType: "application/json", 
            ...effectiveConfig 
        };
        
        if (systemInstruction) {
            finalConfig.systemInstruction = systemInstruction;
        }

        const resp = await ai.models.generateContent({
            model: effectiveModel,
            contents: { parts: [{ text: prompt }] },
            config: finalConfig
        });

        if (tracker && resp.usageMetadata) {
            tracker.addTokenUsage(effectiveModel, resp.usageMetadata.promptTokenCount || 0, resp.usageMetadata.candidatesTokenCount || 0);
        }

        return cleanAndParseJson(resp.text || "{}");

    } catch (e: any) {
        const errorMessage = e.message || '';
        const status = e.status;
        
        const isQuota = status === 429 || errorMessage.includes('429') || errorMessage.includes('quota') || errorMessage.includes('RESOURCE_EXHAUSTED');
        const isOverloaded = status === 503 || errorMessage.includes('503') || errorMessage.includes('Overloaded');

        // Report to Circuit Breaker if we used a tracked model
        if (effectiveModel === model) {
            reportFailure(model, isQuota || isOverloaded);
        }

        // STRATEGY: EXPONENTIAL BACKOFF ON SAME MODEL FIRST
        if ((isQuota || isOverloaded) && retryCount < MAX_RETRIES_SAME_MODEL) {
            const delay = Math.pow(2, retryCount + 1) * 1000 + Math.random() * 500; 
            console.warn(`[AI SERVICE WARN] ${effectiveModel} throttled (${status}). Retrying in ${Math.round(delay)}ms (Attempt ${retryCount + 1})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return callAI(effectiveModel, prompt, effectiveConfig, tracker, systemInstruction, retryCount + 1);
        }

        // FALLBACK LOGIC
        const nextModel = FALLBACK_CHAIN[effectiveModel];

        if ((isQuota || isOverloaded) && nextModel) {
            console.warn(`[AI SERVICE WARN] Exhausted retries for ${effectiveModel}. Falling back to ${nextModel}.`);
            
            const newConfig = { ...effectiveConfig };
            if ((nextModel === MODEL_BACKUP || nextModel === MODEL_LITE) && newConfig.thinkingConfig) {
                 delete newConfig.thinkingConfig;
            }

            // LOOP PREVENTION: Strict temperature on fallback
            if (nextModel === MODEL_FAST || nextModel === MODEL_BACKUP) {
                newConfig.temperature = 0.1;
                newConfig.topP = 0.8; 
            }

            return callAI(nextModel, prompt, newConfig, tracker, systemInstruction, 0); 
        }

        if (isOverloaded) {
            console.error("[AI SERVICE FATAL] 503 Service Unavailable detected and no more fallbacks.");
            throw new Error("Service Unavailable (503). All models overloaded. Please try again later.");
        }
        
        console.error(`[AI SERVICE ERROR] Call Failed on ${effectiveModel}`, e);
        return {};
    }
}

// --- DETERMINISTIC AUTO-REPAIR ---
// Fixes common LLM oversights (missing icons, duplicates) without wasting tokens on a retry loop.

function autoRepairSlide(slide: SlideNode): SlideNode {
    const components = slide.layoutPlan?.components || [];
    const SAFE_ICONS = ['Activity', 'Zap', 'BarChart3', 'Box', 'Layers', 'PieChart', 'TrendingUp', 'Target', 'CheckCircle', 'Lightbulb'];
    
    components.forEach((c) => {
        // 1. REPAIR: Missing Icons
        if (['metric-cards', 'process-flow', 'icon-grid'].includes(c.type)) {
            const list: any[] = (c as any).metrics || (c as any).steps || (c as any).items || [];
            if (Array.isArray(list)) {
                list.forEach((item, idx) => {
                    if (!item.icon || item.icon === '') {
                        item.icon = SAFE_ICONS[idx % SAFE_ICONS.length];
                    }
                });
            }
        }

        // 2. REPAIR: Deduplication (Aggressive)
        if (c.type === 'text-bullets' && Array.isArray(c.content)) {
            // Trim, lowercase compare, distinct
            const unique = new Set();
            const cleanContent: string[] = [];
            c.content.forEach(s => {
                const norm = s.trim();
                const key = norm.toLowerCase();
                if (!unique.has(key) && norm.length > 0) {
                    unique.add(key);
                    cleanContent.push(norm);
                }
            });
            c.content = cleanContent.slice(0, 6);
        }
        
        // Remove duplicates in objects based on key identifiers
        if (['metric-cards', 'icon-grid', 'chart-frame', 'process-flow'].includes(c.type)) {
             const list: any[] = (c as any).metrics || (c as any).items || (c as any).data || (c as any).steps || [];
             if (Array.isArray(list)) {
                const seen = new Set();
                const uniqueList: any[] = [];
                list.forEach(item => {
                    // Create a composite key for robust dedupe
                    let key = "";
                    if (item.label) key += item.label;
                    if (item.value) key += item.value;
                    if (item.title) key += item.title;
                    if (item.description) key += item.description;
                    
                    key = key.toLowerCase().trim();
                    
                    if (!seen.has(key)) {
                        seen.add(key);
                        uniqueList.push(item);
                    }
                });
                
                // Re-assign & Update Count (Prevent empty visuals if duplicates removed all)
                // If uniqueList is too small after dedupe, we might need to invent placeholders?
                // For now, just reassign.
                if (c.type === 'metric-cards') c.metrics = uniqueList;
                if (c.type === 'icon-grid') c.items = uniqueList;
                if (c.type === 'chart-frame') c.data = uniqueList;
                if (c.type === 'process-flow') c.steps = uniqueList;
             }
        }
    });

    return slide;
}


// --- AGENTS ---

// 1. RESEARCHER
async function runResearcher(topic: string, tracker: TokenTracker): Promise<ResearchFact[]> {
  try {
    const raw = await callAI(
        MODEL_FAST, 
        PROMPTS.RESEARCHER.TASK(topic), 
        { 
            tools: [{ googleSearch: {} }],
            maxOutputTokens: 4096,
            temperature: 0.3 
        }, 
        tracker,
        PROMPTS.RESEARCHER.ROLE
    );
    
    if (Array.isArray(raw)) return raw;
    if (raw.facts && Array.isArray(raw.facts)) return raw.facts;
    const possibleArray = Object.values(raw).find(v => Array.isArray(v));
    if (possibleArray) return possibleArray as ResearchFact[];
    if (raw.id && raw.claim) return [raw];
    
    return [];
  } catch (e: any) { 
      console.error("[RESEARCHER FAILED]", e);
      if (e.message && e.message.includes("503")) throw e;
      return []; 
  }
}

// 2. ARCHITECT (The Librarian)
async function runArchitect(topic: string, facts: ResearchFact[], tracker: TokenTracker): Promise<z.infer<typeof OutlineSchema>> {
  const factContext = facts.map(f => `[${f.id}] ${f.claim}`).join('\n');
  
  const architectSchema = {
    type: Type.OBJECT,
    properties: {
      narrativeGoal: { type: Type.STRING },
      title: { type: Type.STRING },
      factClusters: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            theme: { type: Type.STRING },
            factIds: { type: Type.ARRAY, items: { type: Type.STRING } }
          }
        }
      },
      styleGuide: {
        type: Type.OBJECT,
        properties: {
          themeName: { type: Type.STRING },
          fontFamilyTitle: { type: Type.STRING },
          fontFamilyBody: { type: Type.STRING },
          colorPalette: {
            type: Type.OBJECT,
            properties: {
              primary: { type: Type.STRING },
              secondary: { type: Type.STRING },
              background: { type: Type.STRING },
              text: { type: Type.STRING },
              accentHighContrast: { type: Type.STRING }
            },
            required: ["primary", "secondary", "background", "text", "accentHighContrast"]
          },
          imageStyle: { type: Type.STRING },
          layoutStrategy: { type: Type.STRING }
        },
        required: ["themeName", "colorPalette"]
      },
      slides: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            order: { type: Type.NUMBER },
            type: { type: Type.STRING },
            title: { type: Type.STRING },
            purpose: { type: Type.STRING },
            relevantClusterIds: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["order", "type", "title", "purpose"]
        }
      }
    },
    required: ["narrativeGoal", "title", "styleGuide", "slides"]
  };

  const raw = await callAI(
      MODEL_SMART, 
      PROMPTS.ARCHITECT.TASK(topic, factContext), 
      {
          thinkingConfig: { thinkingBudget: 4096 }, 
          maxOutputTokens: 8192,
          temperature: 0.2, 
          responseSchema: architectSchema
      }, 
      tracker,
      PROMPTS.ARCHITECT.ROLE
  );
  
  if (!raw || !raw.slides || !Array.isArray(raw.slides) || raw.slides.length === 0) {
      console.warn("[ARCHITECT WARN] returned empty slides. Using default fallback outline.");
      return {
          narrativeGoal: `Provide a comprehensive overview of ${topic}`,
          title: topic,
          knowledgeSheet: facts,
          factClusters: [],
          styleGuide: {
              themeName: "Modern Minimalist",
              fontFamilyTitle: "Inter",
              fontFamilyBody: "Inter",
              colorPalette: {
                  primary: "#10b981", secondary: "#3b82f6", background: "#0f172a", text: "#f8fafc", accentHighContrast: "#f59e0b"
              },
              imageStyle: "Geometric and Clean",
              layoutStrategy: "Grid-based"
          },
          slides: [
              { order: 1, type: SLIDE_TYPES.TITLE, title: topic, purpose: "Title Slide", relevantClusterIds: [] },
              { order: 2, type: SLIDE_TYPES.CONTENT, title: "Overview", purpose: "Introduction", relevantClusterIds: [] },
              { order: 3, type: SLIDE_TYPES.CONTENT, title: "Key Concepts", purpose: "Detailed Analysis", relevantClusterIds: [] },
              { order: 4, type: SLIDE_TYPES.CONCLUSION, title: "Summary", purpose: "Conclusion", relevantClusterIds: [] }
          ]
      };
  }
  
  if (raw.slides) {
      raw.slides = raw.slides.map((s: any, i: number) => ({
          ...s,
          title: s.title || `Slide ${i + 1}`,
          type: Object.values(SLIDE_TYPES).includes(s.type) ? s.type : SLIDE_TYPES.CONTENT,
          purpose: s.purpose || "Content"
      }));
  }
  
  const defaultStyle = {
      themeName: "Default",
      fontFamilyTitle: "Inter",
      fontFamilyBody: "Inter",
      colorPalette: { primary: "#10b981", secondary: "#3b82f6", background: "#0f172a", text: "#f8fafc", accentHighContrast: "#f59e0b" },
      imageStyle: "Clean",
      layoutStrategy: "Standard"
  };

  if (!raw.styleGuide) {
      raw.styleGuide = defaultStyle;
  } else {
      raw.styleGuide = {
          ...defaultStyle,
          ...raw.styleGuide,
          colorPalette: { ...defaultStyle.colorPalette, ...(raw.styleGuide.colorPalette || {}) }
      };
  }

  return raw;
}

// 3. ROUTER (The "Designer" Manager)
async function runRouter(slideMeta: any, tracker: TokenTracker): Promise<RouterDecision> {
    const routerSchema = {
        type: Type.OBJECT,
        properties: {
            renderMode: { type: Type.STRING, enum: RenderModeSchema.options },
            layoutVariant: { type: Type.STRING, enum: LayoutVariantSchema.options },
            layoutIntent: { type: Type.STRING },
            visualFocus: { type: Type.STRING },
            densityBudget: {
                type: Type.OBJECT,
                properties: {
                    maxChars: { type: Type.NUMBER },
                    maxItems: { type: Type.NUMBER },
                    minVisuals: { type: Type.NUMBER }
                },
                required: ["maxChars", "maxItems"]
            }
        },
        required: ["renderMode", "layoutVariant", "densityBudget"]
    };

    const raw = await callAI(
        MODEL_FAST, 
        PROMPTS.ROUTER.TASK(slideMeta), 
        {
            responseSchema: routerSchema,
            temperature: 0.2 // Strict routing
        }, 
        tracker,
        PROMPTS.ROUTER.ROLE
    );
    
    // Safety defaults
    return {
        renderMode: raw.renderMode || 'standard',
        layoutVariant: raw.layoutVariant || 'standard-vertical',
        layoutIntent: raw.layoutIntent || 'Clean Layout',
        densityBudget: {
            maxChars: raw.densityBudget?.maxChars || 500,
            maxItems: raw.densityBudget?.maxItems || 5,
            minVisuals: raw.densityBudget?.minVisuals || 0
        },
        visualFocus: raw.visualFocus || 'Content'
    };
}

// 4. GENERATOR (RLM LOOP: Recursive Drafter)
async function runGeneratorWithRLM(
  meta: any, 
  routerConfig: RouterDecision, 
  facts: ResearchFact[],
  factClusters: z.infer<typeof FactClusterSchema>[],
  tracker: TokenTracker
): Promise<SlideNode> {
    
    // RLM: Context as Environment
    const clusterIds = meta.relevantClusterIds || [];
    const relevantClusterFacts: string[] = [];
    const seenFactIds = new Set<string>(); 

    if (clusterIds.length > 0 && factClusters) {
        clusterIds.forEach((cid: string) => {
            const cluster = factClusters.find(c => c.id === cid);
            if (cluster && cluster.factIds) {
                cluster.factIds.forEach(fid => {
                    if (!seenFactIds.has(fid)) {
                        const f = facts.find(fact => fact.id === fid);
                        if (f) {
                            relevantClusterFacts.push(`[${f.id}] ${f.claim} (${f.source || 'General'})`);
                            seenFactIds.add(fid);
                        }
                    }
                });
            }
        });
    }

    if (relevantClusterFacts.length === 0) {
        if (meta.relevantFactIds && meta.relevantFactIds.length > 0) {
            meta.relevantFactIds.forEach((fid: string) => {
                 if (!seenFactIds.has(fid)) {
                    const f = facts.find(fact => fact.id === fid);
                    if (f) {
                        relevantClusterFacts.push(`[${f.id}] ${f.claim}`);
                        seenFactIds.add(fid);
                    }
                 }
            });
        } else {
             facts.slice(0, 5).forEach(f => {
                if(!seenFactIds.has(f.id)) {
                    relevantClusterFacts.push(`[${f.id}] ${f.claim}`);
                    seenFactIds.add(f.id);
                }
             });
        }
    }

    const factsContext = relevantClusterFacts.length > 0 ? relevantClusterFacts.join('\n') : "No specific facts found. Use general knowledge.";

    // SCHEMA DEFINITION FOR GENERATOR
    const generatorResponseSchema = {
        type: Type.OBJECT,
        properties: {
            layoutPlan: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    background: { type: Type.STRING, enum: ["solid", "gradient", "image"] },
                    components: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                type: { type: Type.STRING, enum: ["metric-cards", "process-flow", "icon-grid", "text-bullets", "chart-frame"] },
                                title: { type: Type.STRING },
                                content: { type: Type.ARRAY, items: { type: Type.STRING } },
                                style: { type: Type.STRING },
                                metrics: {
                                    type: Type.ARRAY,
                                    items: {
                                        type: Type.OBJECT,
                                        properties: { value: { type: Type.STRING }, label: { type: Type.STRING }, icon: { type: Type.STRING } }
                                    }
                                },
                                steps: {
                                    type: Type.ARRAY,
                                    items: {
                                        type: Type.OBJECT,
                                        properties: { number: { type: Type.NUMBER }, title: { type: Type.STRING }, description: { type: Type.STRING }, icon: { type: Type.STRING } }
                                    }
                                },
                                items: {
                                    type: Type.ARRAY,
                                    items: {
                                        type: Type.OBJECT,
                                        properties: { label: { type: Type.STRING }, icon: { type: Type.STRING }, description: { type: Type.STRING } }
                                    }
                                },
                                chartType: { type: Type.STRING },
                                data: {
                                    type: Type.ARRAY,
                                    items: {
                                        type: Type.OBJECT,
                                        properties: { label: { type: Type.STRING }, value: { type: Type.NUMBER } }
                                    }
                                }
                            },
                            required: ["type"]
                        }
                    }
                },
                required: ["title", "components"]
            },
            visualReasoning: { type: Type.STRING },
            visualPrompt: { type: Type.STRING },
            speakerNotes: { type: Type.STRING },
            citations: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: { id: { type: Type.STRING }, claim: { type: Type.STRING }, source: { type: Type.STRING } }
                }
            },
            chartSpec: {
                type: Type.OBJECT,
                properties: {
                    type: { type: Type.STRING },
                    title: { type: Type.STRING },
                    data: { 
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: { label: { type: Type.STRING }, value: { type: Type.NUMBER } }
                        }
                    },
                    summary: { type: Type.STRING }
                }
            },
            selfCritique: {
                type: Type.OBJECT,
                properties: {
                    readabilityScore: { type: Type.NUMBER },
                    textDensityStatus: { type: Type.STRING, enum: ['optimal', 'high', 'overflow'] },
                    layoutAction: { type: Type.STRING }
                }
            }
        },
        required: ["layoutPlan", "visualReasoning", "visualPrompt", "speakerNotes", "citations", "selfCritique"]
    };

    let currentSlideData: any = null;
    let retries = 0;
    const MAX_RETRIES = 2;
    let lastValidation = null;

    // --- LOOP START ---
    while (retries <= MAX_RETRIES) {
        let prompt = "";
        let role = PROMPTS.GENERATOR.ROLE;
        
        // CHECK MODE MISMATCH RECOVERY
        // If the previous attempt failed due to data-viz mismatch, downgrade to standard to avoid endless loop.
        if (lastValidation?.errors.some(e => e.code === 'ERR_MODE_MISMATCH')) {
             console.warn("[RLM RECOVERY] Downgrading Data-Viz to Infographic due to missing chart data.");
             routerConfig.renderMode = 'infographic';
             routerConfig.layoutVariant = 'standard-vertical';
        }

        const hasValidDataToRepair = currentSlideData && currentSlideData.layoutPlan;

        if (retries > 0 && hasValidDataToRepair) {
            prompt = PROMPTS.REPAIRER.TASK(JSON.stringify(currentSlideData), lastValidation?.errors || []);
            role = PROMPTS.REPAIRER.ROLE;
        } else {
            prompt = PROMPTS.GENERATOR.TASK(meta, routerConfig, factsContext);
            if (retries > 0) {
                prompt += `\n\nCRITICAL RETRY: The previous attempt failed. \nSTRICT RULE: KEEP TITLES UNDER 60 CHARS. DO NOT REPEAT TEXT.`;
            }
        }

        const raw = await callAI(
            MODEL_SMART, 
            prompt, 
            {
                responseSchema: generatorResponseSchema,
                // Reduced thinking budget to prevent token exhaustion/truncation
                thinkingConfig: { thinkingBudget: 1024 }, 
                maxOutputTokens: 8192,
                temperature: 0.1 
            }, 
            tracker,
            role
        );
        
        if (!raw || !raw.layoutPlan) {
            console.error(`[GENERATOR FAILURE] Model returned malformed JSON for slide ${meta.title}.`);
        }

        let candidate: SlideNode = {
            order: meta.order || 0,
            type: meta.type as any,
            title: raw.layoutPlan?.title || meta.title,
            purpose: meta.purpose,
            routerConfig,
            layoutPlan: raw.layoutPlan,
            visualReasoning: raw.visualReasoning || "Visuals derived from content analysis.",
            visualPrompt: raw.visualPrompt,
            speakerNotes: raw.speakerNotes || "",
            citations: raw.citations || [],
            chartSpec: raw.chartSpec,
            selfCritique: raw.selfCritique,
            readabilityCheck: 'pass',
            validation: undefined
        };

        // If Data-Viz, map chartSpec to chart-frame if missing
        if (candidate.type === 'data-viz' && candidate.chartSpec && candidate.layoutPlan?.components) {
             const hasFrame = candidate.layoutPlan.components.some(c => c.type === 'chart-frame');
             if (!hasFrame) {
                 candidate.layoutPlan.components.push({
                     type: 'chart-frame',
                     title: candidate.chartSpec.title || "Data Analysis",
                     chartType: (['bar','pie','doughnut','line'].includes(candidate.chartSpec.type) ? candidate.chartSpec.type : 'bar') as any,
                     data: candidate.chartSpec.data
                 });
             }
        }

        // --- RLM SELF-HEALING ---
        // Before validation, attempt deterministic repairs to save retries
        candidate = autoRepairSlide(candidate);

        let validation;
        try {
            validation = validateSlide(candidate);
        } catch (e) {
            console.error("[VALIDATOR CRASH] Validation logic crashed:", e);
            validation = { passed: false, score: 0, errors: [{ code: "ERR_VALIDATOR_CRASH", message: "Validator crashed on malformed structure." }] };
        }
        
        lastValidation = validation;

        if (validation.passed) {
            candidate.validation = validation;
            return candidate;
        }

        console.warn(`[GENERATOR RLM] Validation Failed (Attempt ${retries + 1}/${MAX_RETRIES + 1}) for "${meta.title}":`, validation.errors);
        
        currentSlideData = raw; 
        retries++;
    }

    // --- EMERGENCY FALLBACK ---
    let finalLayoutPlan = currentSlideData?.layoutPlan;
    let fallbackWarnings: string[] = [];
    
    const isTotalFailure = !finalLayoutPlan || !finalLayoutPlan.components || !Array.isArray(finalLayoutPlan.components) || finalLayoutPlan.components.length === 0;

    if (isTotalFailure) {
        console.error(`[FALLBACK TRIGGERED] Slide "${meta.title}" failed generation.`);
        
        const fallbackContent: string[] = [];
        fallbackContent.push(meta.purpose);
        fallbackContent.push("Details unavailable due to generation error.");

        finalLayoutPlan = {
            title: meta.title,
            background: 'solid',
            components: [{
                type: 'text-bullets',
                title: "Key Insights (Safe Mode)",
                content: fallbackContent,
                style: 'standard'
            }]
        };
        
        const originalErrors = lastValidation?.errors.map(e => `Original Error: ${e.message}`) || [];
        fallbackWarnings = ["Safe Mode: Simplified layout auto-generated due to repeated validation failures.", ...originalErrors];
    } else {
        fallbackWarnings = lastValidation ? lastValidation.errors.map(e => e.message) : ["Validation issues detected."];
    }

    return {
        order: meta.order || 0,
        type: meta.type as any,
        title: meta.title,
        purpose: meta.purpose,
        routerConfig,
        layoutPlan: finalLayoutPlan, 
        visualReasoning: currentSlideData?.visualReasoning || "Fallback due to generation error.",
        visualPrompt: currentSlideData?.visualPrompt || `${meta.title} abstract business background`,
        speakerNotes: currentSlideData?.speakerNotes || "Note: This slide was generated using a fallback layout due to complexity limits.",
        readabilityCheck: 'warning',
        citations: [],
        selfCritique: { readabilityScore: 0, textDensityStatus: 'high', layoutAction: 'fallback' },
        warnings: fallbackWarnings
    };
}

// --- ORCHESTRATOR (PUBLIC API) ---

export const generateAgenticDeck = async (
  topic: string, 
  onProgress: (status: string, percent?: number) => void
): Promise<EditableSlideDeck> => {
    const tracker = new TokenTracker();
    const startTime = Date.now();

    // 1. RESEARCH
    onProgress("Agent 1/4: Deep Research...", 10);
    const facts = await runResearcher(topic, tracker);
    
    // 2. ARCHITECT
    onProgress("Agent 2/4: Structuring Narrative...", 30);
    const outline = await runArchitect(topic, facts, tracker);

    const slides: SlideNode[] = [];
    const totalSlides = outline.slides.length;

    // 3. GENERATION LOOP (Router -> Generator -> Visuals)
    for (let i = 0; i < totalSlides; i++) {
        const slideMeta = outline.slides[i];
        onProgress(`Agent 3/4: Designing Slide ${i+1}/${totalSlides}: ${slideMeta.title}...`, 30 + Math.floor((i/totalSlides) * 40));

        // A. ROUTER
        const routerConfig = await runRouter(slideMeta, tracker);

        // B. GENERATOR (RLM)
        const slideNode = await runGeneratorWithRLM(slideMeta, routerConfig, facts, outline.factClusters || [], tracker);

        // C. VISUAL ASSET GENERATION
        if (slideNode.visualPrompt) {
            onProgress(`Agent 4/4: Rendering Visuals for Slide ${i+1}...`);
            const imgResult = await generateImageFromPrompt(slideNode.visualPrompt, "16:9");
            if (imgResult) {
                slideNode.backgroundImageUrl = imgResult.imageUrl;
                tracker.addImageCost(imgResult.model);
            }
        }

        slides.push(slideNode);
    }

    onProgress("Finalizing Deck...", 100);

    return {
        id: crypto.randomUUID(),
        topic,
        meta: outline,
        slides,
        metrics: {
            totalDurationMs: Date.now() - startTime,
            retries: 0, 
            totalCost: tracker.totalCost
        }
    };
};

export const regenerateSingleSlide = async (
    meta: any, 
    currentSlide: SlideNode,
    facts: ResearchFact[],
    factClusters: z.infer<typeof FactClusterSchema>[] = [] 
): Promise<SlideNode> => {
    const tracker = new TokenTracker();
    
    // 1. Re-Route
    const routerConfig = await runRouter(meta, tracker);

    // 2. Re-Generate Content
    const newSlide = await runGeneratorWithRLM(meta, routerConfig, facts, factClusters, tracker);

    // 3. Re-Generate Visual
    if (newSlide.visualPrompt) {
         const imgResult = await generateImageFromPrompt(newSlide.visualPrompt, "16:9");
         if (imgResult) {
             newSlide.backgroundImageUrl = imgResult.imageUrl;
             tracker.addImageCost(imgResult.model);
         }
    }

    return newSlide;
};
