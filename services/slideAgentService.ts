

import { GoogleGenAI, Type, Schema } from "@google/genai";
import { 
  EditableSlideDeck, SlideNode, OutlineSchema, SLIDE_TYPES, GlobalStyleGuide, 
  ResearchFact, RouterDecision, RouterDecisionSchema, SlideNodeSchema, LayoutVariantSchema, RenderModeSchema,
  FactClusterSchema, VisualDesignSpec
} from "../types/slideTypes";
import { generateImageFromPrompt, callAI, TokenTracker, runJsonRepair, JsonParseError, cleanAndParseJson } from "./geminiService";
import { PROMPTS } from "./promptRegistry";
import { validateSlide } from "./validators";
import { runVisualDesigner } from "./visualDesignAgent";
import { z } from "zod";

const MODEL_SMART = "gemini-3-pro-preview"; 
const MODEL_FAST = "gemini-3-flash-preview"; 
const MODEL_BACKUP = "gemini-2.0-flash";
const MODEL_LITE = "gemini-2.0-flash-lite-preview-02-05";

// --- DETERMINISTIC AUTO-REPAIR ---
function autoRepairSlide(slide: SlideNode): SlideNode {
    const components = slide.layoutPlan?.components || [];
    const SAFE_ICONS = ['Activity', 'Zap', 'BarChart3', 'Box', 'Layers', 'PieChart', 'TrendingUp', 'Target', 'CheckCircle', 'Lightbulb'];
    
    const isGarbage = (text: string) => {
        if (!text || text.length < 20) return false;
        const words = text.split(/\s+/);
        if (words.length > 5) {
             const uniqueWords = new Set(words.map(w => w.toLowerCase()));
             if (uniqueWords.size < words.length * 0.5) return true;
        }
        return false;
    };

    components.forEach((c) => {
        if (['metric-cards', 'process-flow', 'icon-grid'].includes(c.type)) {
            const list: any[] = (c as any).metrics || (c as any).steps || (c as any).items || [];
            if (Array.isArray(list)) {
                list.forEach((item, idx) => {
                    if (!item.icon || item.icon === '') {
                        item.icon = SAFE_ICONS[idx % SAFE_ICONS.length];
                    }
                    if (item.label && isGarbage(item.label)) {
                        item.label = "Detail " + (idx + 1);
                    }
                });
            }
        }
        if (c.type === 'text-bullets' && Array.isArray(c.content)) {
            const unique = new Set();
            const cleanContent: string[] = [];
            c.content.forEach(s => {
                let norm = s.trim();
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
    });
    return slide;
}


// --- AGENTS ---

// 1. RESEARCHER
async function runResearcher(topic: string, tracker: TokenTracker): Promise<ResearchFact[]> {
  const researchSchema = {
      type: Type.ARRAY,
      items: {
          type: Type.OBJECT,
          properties: {
              id: { type: Type.STRING },
              category: { type: Type.STRING },
              claim: { type: Type.STRING },
              value: { type: Type.STRING },
              source: { type: Type.STRING },
              confidence: { type: Type.STRING }
          }
      }
  };

  try {
    // Note: When using googleSearch, strict JSON responseSchema can be unstable.
    // We use text mode and rely on our robust JSON extractor.
    const raw = await callAI(
        MODEL_FAST, 
        PROMPTS.RESEARCHER.TASK(topic), 
        { 
            mode: 'text', // Switch to text to avoid conflict with Google Search Grounding response format
            config: { 
                tools: [{ googleSearch: {} }],
                maxOutputTokens: 8192, 
                temperature: 0.3 
            },
            systemInstruction: PROMPTS.RESEARCHER.ROLE
        }, 
        tracker
    );
    
    // Attempt to parse the text response
    try {
        const parsed = cleanAndParseJson(raw);
        if (Array.isArray(parsed)) return parsed;
        // If parsed object is wrapper { facts: [...] }
        if (parsed.facts && Array.isArray(parsed.facts)) return parsed.facts;
        
        return [];
    } catch (parseErr) {
        console.warn("[RESEARCHER] Parsing failed. Attempting repair...");
        // Fallback: Use the JSON Repair Agent to fix the malformed output
        try {
            const repaired = await runJsonRepair(raw, researchSchema, tracker);
            if (Array.isArray(repaired)) return repaired;
        } catch (repairErr) {
            console.error("[RESEARCHER] Repair failed.", repairErr);
        }
        return [];
    }
  } catch (e: any) { 
      console.warn("[RESEARCHER] Agent failed.", e);
      return []; 
  }
}

// 2. ARCHITECT
async function runArchitect(topic: string, facts: ResearchFact[], tracker: TokenTracker): Promise<z.infer<typeof OutlineSchema>> {
  const factContext = facts.map(f => `[${f.id}] ${f.claim}`).join('\n');
  const architectSchema = {
    type: Type.OBJECT,
    properties: {
      narrativeGoal: { type: Type.STRING },
      title: { type: Type.STRING },
      factClusters: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, theme: { type: Type.STRING }, factIds: { type: Type.ARRAY, items: { type: Type.STRING } } } } },
      styleGuide: { type: Type.OBJECT, properties: { themeName: { type: Type.STRING }, fontFamilyTitle: { type: Type.STRING }, fontFamilyBody: { type: Type.STRING }, colorPalette: { type: Type.OBJECT, properties: { primary: { type: Type.STRING }, secondary: { type: Type.STRING }, background: { type: Type.STRING }, text: { type: Type.STRING }, accentHighContrast: { type: Type.STRING } }, required: ["primary", "secondary", "background", "text", "accentHighContrast"] }, imageStyle: { type: Type.STRING }, layoutStrategy: { type: Type.STRING } }, required: ["themeName", "colorPalette"] },
      slides: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { order: { type: Type.NUMBER }, type: { type: Type.STRING }, title: { type: Type.STRING }, purpose: { type: Type.STRING }, relevantClusterIds: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ["order", "type", "title", "purpose"] } }
    },
    required: ["narrativeGoal", "title", "styleGuide", "slides"]
  };

  try {
      const raw = await callAI(
          MODEL_SMART, 
          PROMPTS.ARCHITECT.TASK(topic, factContext), 
          { 
              mode: 'json',
              schema: architectSchema,
              config: { 
                  thinkingConfig: { thinkingBudget: 2048 }, 
                  maxOutputTokens: 8192, 
                  temperature: 0.2 
              },
              systemInstruction: PROMPTS.ARCHITECT.ROLE
          }, 
          tracker
      );
      
      if (!raw || !raw.slides) throw new Error("Missing slides in architect output");
      return raw;
  } catch (e) {
      console.error("[ARCHITECT] Agent failed. Using Fallback.", e);
      return { 
          narrativeGoal: topic, 
          title: topic, 
          knowledgeSheet: facts, 
          factClusters: [], 
          styleGuide: { themeName: "Default", fontFamilyTitle: "Inter", fontFamilyBody: "Inter", colorPalette: { primary: "#10b981", secondary: "#3b82f6", background: "#0f172a", text: "#f8fafc", accentHighContrast: "#f59e0b" }, imageStyle: "Clean", layoutStrategy: "Standard" }, 
          slides: [{ order: 1, type: SLIDE_TYPES.TITLE, title: topic, purpose: "Title", relevantClusterIds: [] }] 
      };
  }
}

// 3. ROUTER
async function runRouter(slideMeta: any, tracker: TokenTracker): Promise<RouterDecision> {
    const routerSchema = {
        type: Type.OBJECT,
        properties: {
            renderMode: { type: Type.STRING, enum: RenderModeSchema.options },
            layoutVariant: { type: Type.STRING, enum: LayoutVariantSchema.options },
            layoutIntent: { type: Type.STRING },
            visualFocus: { type: Type.STRING },
            densityBudget: { type: Type.OBJECT, properties: { maxChars: { type: Type.NUMBER }, maxItems: { type: Type.NUMBER }, minVisuals: { type: Type.NUMBER } }, required: ["maxChars", "maxItems"] }
        },
        required: ["renderMode", "layoutVariant", "densityBudget"]
    };

    try {
        const raw = await callAI(
            MODEL_FAST, 
            PROMPTS.ROUTER.TASK(slideMeta), 
            { mode: 'json', schema: routerSchema, config: { temperature: 0.2 }, systemInstruction: PROMPTS.ROUTER.ROLE }, 
            tracker
        );
        return raw.renderMode ? raw : { renderMode: 'standard', layoutVariant: 'standard-vertical', layoutIntent: 'Fallback', densityBudget: { maxChars: 500, maxItems: 5, minVisuals: 0 }, visualFocus: 'Content' };
    } catch (e) {
        console.warn("[ROUTER] Agent failed, using default layout.", e);
        return { renderMode: 'standard', layoutVariant: 'standard-vertical', layoutIntent: 'Fallback (Recovery)', densityBudget: { maxChars: 500, maxItems: 5, minVisuals: 0 }, visualFocus: 'Content' };
    }
}

// 4. CONTENT PLANNER
async function runContentPlanner(meta: any, factsContext: string, tracker: TokenTracker) {
    const contentPlanSchema = {
        type: Type.OBJECT,
        properties: {
            title: { type: Type.STRING },
            keyPoints: { type: Type.ARRAY, items: { type: Type.STRING }, maxItems: 5 }, // Strict limit
            dataPoints: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { label: {type:Type.STRING}, value: {type:Type.STRING} } }, maxItems: 4 },
            narrative: { type: Type.STRING }
        },
        required: ["title", "keyPoints"]
    };

    try {
        return await callAI(
            MODEL_FAST,
            PROMPTS.CONTENT_PLANNER.TASK(meta.title, meta.purpose, factsContext),
            { mode: 'json', schema: contentPlanSchema, config: { maxOutputTokens: 2048, temperature: 0.2 }, systemInstruction: PROMPTS.CONTENT_PLANNER.ROLE },
            tracker
        );
    } catch (e) {
        console.warn("[CONTENT PLANNER] Phase 1 failed. Using basic fallback.", e);
        return {
            title: meta.title,
            keyPoints: ["Content generation failed. Please edit manually."],
            narrative: "Fallback due to agent error."
        };
    }
}

// 5. GENERATOR (Final Assembly)
async function runGeneratorWithRLM(
  meta: any, 
  routerConfig: RouterDecision,
  contentPlan: any, 
  visualDesignSpec: VisualDesignSpec | undefined,
  facts: ResearchFact[],
  factClusters: z.infer<typeof FactClusterSchema>[],
  tracker: TokenTracker
): Promise<SlideNode> {
    
    // --- PHASE 3: FINAL ASSEMBLY (Pro, Strict Mapping) ---
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
                        maxItems: 2, // UI Limit
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                type: { type: Type.STRING, enum: ["metric-cards", "process-flow", "icon-grid", "text-bullets", "chart-frame"] },
                                title: { type: Type.STRING },
                                content: { type: Type.ARRAY, items: { type: Type.STRING }, maxItems: 6 },
                                metrics: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { value: { type: Type.STRING }, label: { type: Type.STRING }, icon: { type: Type.STRING } } }, maxItems: 4 },
                                steps: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { number: { type: Type.NUMBER }, title: { type: Type.STRING }, description: { type: Type.STRING }, icon: { type: Type.STRING } } }, maxItems: 4 },
                                items: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { label: { type: Type.STRING }, icon: { type: Type.STRING }, description: { type: Type.STRING } } }, maxItems: 6 },
                                chartType: { type: Type.STRING },
                                data: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { label: { type: Type.STRING }, value: { type: Type.NUMBER } } }, maxItems: 8 }
                            },
                            required: ["type"]
                        }
                    }
                },
                required: ["title", "components"]
            },
            speakerNotesLines: { type: Type.ARRAY, items: { type: Type.STRING }, maxItems: 5 },
            chartSpec: { type: Type.OBJECT, properties: { type: { type: Type.STRING }, title: { type: Type.STRING }, data: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { label: { type: Type.STRING }, value: { type: Type.NUMBER } } }, maxItems: 8 } } },
            selfCritique: { 
                type: Type.OBJECT, 
                properties: { 
                    readabilityScore: { type: Type.NUMBER }, 
                    textDensityStatus: { type: Type.STRING, enum: ['optimal', 'high', 'overflow'] }, 
                    layoutAction: { type: Type.STRING, enum: ['keep', 'simplify', 'shrink_text', 'add_visuals'] } 
                } 
            }
        },
        required: ["layoutPlan", "speakerNotesLines", "selfCritique"]
    };

    let retries = 0;
    const MAX_RETRIES = 2;
    let currentSlideData: any = null;
    let lastValidation = null;
    let forceSkeletonMode = false;

    while (retries <= MAX_RETRIES) {
        let prompt = "";
        let role = PROMPTS.VISUAL_DESIGNER.ROLE;
        
        // RECOVERY STRATEGIES
        if (forceSkeletonMode) {
             prompt = PROMPTS.VISUAL_DESIGNER.TASK(JSON.stringify(contentPlan), routerConfig);
             prompt += "\n\nEMERGENCY SKELETON MODE: STRICT FORMAT. USE ONLY 'text-bullets'. MAX 3 ITEMS. NO ICONS. SIMPLEST VALID JSON.";
        } else if (retries > 0 && currentSlideData && lastValidation?.errors) {
             // If we have previous data but it failed validation, use repairer
             prompt = PROMPTS.REPAIRER.TASK(JSON.stringify(currentSlideData), lastValidation.errors);
             role = PROMPTS.REPAIRER.ROLE;
        } else {
             // Fresh Generation
             prompt = PROMPTS.VISUAL_DESIGNER.TASK(JSON.stringify(contentPlan), routerConfig);
        }

        let raw;
        try {
             // Pass strict schema
             // Increased token budget significantly to prevent truncation
             raw = await callAI(
                MODEL_SMART, 
                prompt, 
                {
                    mode: 'json',
                    schema: generatorResponseSchema,
                    config: { 
                        // Increase thinking budget to allow for detailed planning
                        thinkingConfig: { thinkingBudget: 2048 }, 
                        // Max output tokens increased to prevent JSON truncation
                        maxOutputTokens: 8192, 
                        temperature: forceSkeletonMode ? 0.0 : 0.1 
                    }, 
                    systemInstruction: role
                },
                tracker,
                retries
            );
        } catch(e: any) {
            // ERROR HANDLING TREE
            if (e instanceof JsonParseError) {
                if (e.type === 'REPETITION') {
                    // Critical: Loop Detected. Force skeleton mode on next retry.
                    console.warn("[GENERATOR] Repetition loop detected. Switching to SKELETON MODE.");
                    forceSkeletonMode = true;
                    raw = null;
                } else if (e.type === 'TRUNCATION' || e.type === 'MALFORMED') {
                    // Try agentic repair for mangled JSON
                     console.warn(`[GENERATOR] JSON Error (${e.type}). Triggering specialized repair agent...`);
                     try {
                         raw = await runJsonRepair(e.text, generatorResponseSchema, tracker);
                     } catch (repairError) {
                         console.error("Agentic repair failed.", repairError);
                         raw = null;
                     }
                } else {
                    raw = null;
                }
            } else {
                // Quota or Network error: Do not repair. Let loop retry or fail.
                console.error("[GENERATOR] System error.", e.message);
                raw = null;
            }
        }
        
        if (!raw) {
             if (retries < MAX_RETRIES) {
                 retries++;
                 continue;
             } else {
                 break;
             }
        }

        currentSlideData = raw;

        let candidate: SlideNode = {
            order: meta.order || 0,
            type: meta.type as any,
            title: raw.layoutPlan?.title || meta.title,
            purpose: meta.purpose,
            routerConfig,
            layoutPlan: raw.layoutPlan,
            visualReasoning: "Derived from content plan",
            visualPrompt: "", 
            visualDesignSpec, // Attach visual spec
            speakerNotesLines: raw.speakerNotesLines || [],
            citations: [],
            chartSpec: raw.chartSpec,
            selfCritique: raw.selfCritique,
            readabilityCheck: 'pass',
            validation: undefined,
            warnings: []
        };
        
        if (forceSkeletonMode) {
            candidate.warnings = [...(candidate.warnings||[]), "Generated in Safe Mode due to stability issues."];
        }

        if (candidate.type === 'data-viz' && candidate.chartSpec && candidate.layoutPlan?.components) {
             const hasFrame = candidate.layoutPlan.components.some((c:any) => c.type === 'chart-frame');
             if (!hasFrame) {
                 candidate.layoutPlan.components.push({
                     type: 'chart-frame',
                     title: candidate.chartSpec.title || "Data Analysis",
                     chartType: (['bar','pie','doughnut','line'].includes(candidate.chartSpec.type) ? candidate.chartSpec.type : 'bar') as any,
                     data: candidate.chartSpec.data
                 });
             }
        }

        candidate = autoRepairSlide(candidate);
        let validation = validateSlide(candidate);
        lastValidation = validation;

        if (validation.passed) {
            candidate.validation = validation;
            return candidate;
        }
        
        // If validation failed specifically due to repetition in strings, force skeleton mode next time
        if (validation.errors.some(err => err.code === 'ERR_REPETITION_DETECTED')) {
            forceSkeletonMode = true;
        }

        retries++;
    }

    // Fallback
    return {
        order: meta.order || 0,
        type: meta.type as any,
        title: meta.title,
        purpose: meta.purpose,
        routerConfig,
        layoutPlan: { title: meta.title, background: 'solid', components: [{ type: 'text-bullets', title: "Key Insights", content: contentPlan.keyPoints || ["Data unavailable."], style: 'standard' }] },
        visualReasoning: "Fallback",
        visualPrompt: "",
        visualDesignSpec,
        speakerNotesLines: ["Fallback due to validation errors."],
        readabilityCheck: 'warning',
        citations: [],
        warnings: lastValidation?.errors.map(e => e.message) || ["Generation failed"]
    };
}


// --- ORCHESTRATOR ---

export const generateAgenticDeck = async (
  topic: string, 
  onProgress: (status: string, percent?: number) => void
): Promise<EditableSlideDeck> => {
    const tracker = new TokenTracker();
    const startTime = Date.now();

    onProgress("Agent 1/5: Deep Research...", 10);
    const facts = await runResearcher(topic, tracker);
    
    onProgress("Agent 2/5: Structuring Narrative...", 25);
    const outline = await runArchitect(topic, facts, tracker);

    const slides: SlideNode[] = [];
    const totalSlides = outline.slides.length;

    for (let i = 0; i < totalSlides; i++) {
        const slideMeta = outline.slides[i];
        
        // 1. Route Layout
        onProgress(`Agent 3/5: Routing Slide ${i+1}/${totalSlides}...`, 30 + Math.floor((i/(totalSlides*2)) * 30));
        const routerConfig = await runRouter(slideMeta, tracker);
        
        // 2. Plan Content
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
        
        onProgress(`Agent 3b/5: Content Planning Slide ${i+1}...`, 32 + Math.floor((i/(totalSlides*2)) * 30));
        const contentPlan = await runContentPlanner(slideMeta, factsContext, tracker);
        
        // 3. Visual Design (New Agent)
        onProgress(`Agent 3c/5: Visual Design Slide ${i+1}...`, 34 + Math.floor((i/(totalSlides*2)) * 30));
        const visualDesign = await runVisualDesigner(
          slideMeta.title,
          contentPlan,
          routerConfig,
          facts,
          tracker
        );

        // 4. Final Generation
        onProgress(`Agent 4/5: Generating Slide ${i+1}...`, 40 + Math.floor((i/(totalSlides*2)) * 40));
        const slideNode = await runGeneratorWithRLM(
            slideMeta, 
            routerConfig, 
            contentPlan,
            visualDesign,
            facts, 
            outline.factClusters || [], 
            tracker
        );
        
        // 5. Image Generation (Using optimized prompt from Visual Designer)
        // If Visual Designer prompt is available, use it. Otherwise fallback.
        const finalVisualPrompt = visualDesign.prompt_with_composition || `${slideNode.title} professional abstract background`;
        slideNode.visualPrompt = finalVisualPrompt;

        if (finalVisualPrompt) {
            onProgress(`Agent 5/5: Rendering Visual ${i+1}...`, 60 + Math.floor((i/totalSlides) * 40));
            const imgResult = await generateImageFromPrompt(finalVisualPrompt, "16:9");
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
        metrics: { totalDurationMs: Date.now() - startTime, retries: 0, totalCost: tracker.totalCost }
    };
};

export const regenerateSingleSlide = async (
    meta: any, 
    currentSlide: SlideNode,
    facts: ResearchFact[],
    factClusters: z.infer<typeof FactClusterSchema>[] = [] 
): Promise<SlideNode> => {
    const tracker = new TokenTracker();
    
    // We assume the router config is still valid or we re-run it
    // For specialized regeneration we might want to keep the router decision?
    // Let's re-run for freshness.
    const routerConfig = await runRouter(meta, tracker);
    
    // Content Plan
    const contentPlan = await runContentPlanner(meta, "", tracker); // Lost context facts for now in this simple helper
    
    // Visual Design
    const visualDesign = await runVisualDesigner(meta.title, contentPlan, routerConfig, facts, tracker);

    const newSlide = await runGeneratorWithRLM(meta, routerConfig, contentPlan, visualDesign, facts, factClusters, tracker);
    
    newSlide.visualPrompt = visualDesign.prompt_with_composition;
    
    if (newSlide.visualPrompt) {
         const imgResult = await generateImageFromPrompt(newSlide.visualPrompt, "16:9");
         if (imgResult) {
             newSlide.backgroundImageUrl = imgResult.imageUrl;
             tracker.addImageCost(imgResult.model);
         }
    }
    return newSlide;
};
