/**
 * Composition Architect Agent
 * 
 * A new agent that sits between Router and Visual Designer in the pipeline.
 * Its role is to plan the LAYER STRUCTURE and COMPOSITIONAL PRIMITIVES for a slide,
 * enabling high serendipity while maintaining theme coherence.
 * 
 * Pipeline Position:
 * Router → **Composition Architect** → Visual Designer → Generator
 * 
 * Responsibilities:
 * 1. Layer Planning: Decide what goes in background, decorative, content, overlay layers
 * 2. Primitive Selection: Choose card styles, badge placements, accent usage
 * 3. Variation Budget Execution: Use variationBudget to inject controlled surprises
 * 4. Theme Enforcement: Ensure choices align with SerendipityDNA
 */

import { z } from "zod";
import {
  CompositionPlan,
  CompositionPlanSchema,
  SerendipityDNA,
  SurpriseSlot,
  CardStyle,
  DecorativeTypeSchema
} from "../../types/serendipityTypes";
import {
  RouterDecision,
  ResearchFact,
  NarrativeTrail
} from "../../types/slideTypes";
import {
  createJsonInteraction,
  CostTracker,
  MODEL_SIMPLE
} from "../interactionsClient";

// ============================================================================
// CONSTANTS
// ============================================================================

// Use MODEL_SIMPLE (gemini-2.5-flash) for Composition Architect
// This is a classification/planning task, not reasoning-heavy
const COMPOSITION_ARCHITECT_MODEL = MODEL_SIMPLE;

// ============================================================================
// PROMPTS
// ============================================================================

const COMPOSITION_ARCHITECT_ROLE = `You are a Visual Composition Architect specializing in modern, layer-based slide design.
Your job is to plan the STRUCTURE of a slide using explicit layers and compositional primitives.

You understand:
- Layer hierarchy: Background → Decorative → Content → Overlay
- Modern design patterns: glass cards, category badges, accent glows
- Theme coherence: maintaining DNA while introducing controlled variation
- The PowerPoint native model: shapes, text, images with z-ordering`;

const buildCompositionTask = (
  slideTitle: string,
  slidePurpose: string,
  routerConfig: RouterDecision,
  contentSummary: string,
  serendipityDNA?: SerendipityDNA,
  variationBudget?: number,
  narrativeTrail?: NarrativeTrail[],
  usedSurprises?: string[]
): string => `
TASK: Plan the layer structure and compositional primitives for a slide.

SLIDE CONTEXT:
- Title: "${slideTitle}"
- Purpose: ${slidePurpose}
- Layout Variant: ${routerConfig.layoutVariant}
- Render Mode: ${routerConfig.renderMode}
- Visual Focus: ${routerConfig.visualFocus}
- Density Budget: max ${routerConfig.densityBudget.maxItems} items, ${routerConfig.densityBudget.maxChars} chars

CONTENT SUMMARY:
${contentSummary}

${serendipityDNA ? `THEME DNA:
- Motifs: ${serendipityDNA.motifs?.join(', ')}
- Card Style Preference: ${serendipityDNA.cardStyle || 'glass'}
- Accent Density: ${serendipityDNA.accentDensity || 'balanced'}
- Composition Bias: ${serendipityDNA.compositionBias || 'balanced'}` : ''}

VARIATION BUDGET: ${variationBudget?.toFixed(2) || '0.5'} (0=conservative, 1=bold)

${narrativeTrail?.length ? `PREVIOUS SLIDES (avoid repetition):
${narrativeTrail.map(t => `- ${t.title}: ${t.mainPoint}`).join('\n')}` : ''}

${usedSurprises?.length ? `ALREADY USED SURPRISES (avoid repeating):
${usedSurprises.join(', ')}` : ''}

YOUR DECISIONS:

1. BACKGROUND LAYER:
   - Type: solid | gradient | image | mesh
   - If mesh: which pattern? (circuit, topological, particle)

2. DECORATIVE LAYER (0-4 elements):
   - Should there be a category badge? Where?
   - Any dividers or accent shapes?
   - Any glow effects behind key elements?

3. CONTENT STRUCTURE:
   - Pattern: single-hero | card-row | card-grid | split-content | metrics-rail | narrative-flow
   - How many cards? (0-4)
   - Card style: glass | solid | outline
   - How many text blocks? (0-3)

4. SERENDIPITY ALLOCATION:
   - Based on variation budget, allocate 0-2 surprise elements
   - Surprise types: category-badge, accent-underline, icon-glow, quote-callout, asymmetric-emphasis, connector-flow
   - Each surprise should enhance visual interest without breaking theme

OUTPUT: Return a JSON object matching the CompositionPlan schema.
Include brief reasoning for your decisions.
`;

// ============================================================================
// SCHEMA FOR INTERACTIONS API
// ============================================================================

const COMPOSITION_PLAN_SCHEMA = {
  type: "object",
  properties: {
    slideId: { type: "string" },
    layerPlan: {
      type: "object",
      properties: {
        background: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["solid", "gradient", "image", "mesh"] },
            suggestion: { type: "string" }
          },
          required: ["type", "suggestion"]
        },
        decorativeElements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              placement: { type: "string" },
              purpose: { type: "string" }
            }
          }
        },
        contentStructure: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              enum: ["single-hero", "card-row", "card-grid", "split-content", "metrics-rail", "narrative-flow"]
            },
            cardCount: { type: "number" },
            cardStyle: { type: "string", enum: ["glass", "solid", "outline", "gradient", "elevated"] },
            textBlockCount: { type: "number" }
          },
          required: ["pattern"]
        },
        overlayIntention: { type: "string" }
      },
      required: ["background", "contentStructure"]
    },
    serendipityPlan: {
      type: "object",
      properties: {
        variationBudget: { type: "number" },
        allocatedSurprises: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              target: { type: "string" },
              intensity: { type: "string", enum: ["subtle", "moderate", "bold"] },
              params: { type: "object" }
            },
            required: ["type", "intensity"]
          }
        },
        compositionChoices: {
          type: "object",
          properties: {
            cardArrangement: { type: "string" },
            iconStyle: { type: "string" },
            accentPlacement: { type: "string" }
          }
        }
      },
      required: ["variationBudget", "allocatedSurprises"]
    },
    reasoning: { type: "string" }
  },
  required: ["slideId", "layerPlan", "serendipityPlan", "reasoning"]
};

// ============================================================================
// MAIN AGENT FUNCTION
// ============================================================================

export interface CompositionArchitectInput {
  slideId: string;
  slideTitle: string;
  slidePurpose: string;
  routerConfig: RouterDecision;
  contentPlan: {
    keyPoints?: string[];
    dataPoints?: Array<{ label: string; value: number }>;
  };
  serendipityDNA?: SerendipityDNA;
  variationBudget: number;
  narrativeTrail?: NarrativeTrail[];
  usedSurprisesInDeck?: string[]; // Track surprises already used to avoid repetition
}

export async function runCompositionArchitect(
  input: CompositionArchitectInput,
  tracker: CostTracker
): Promise<CompositionPlan> {
  // Input validation
  if (!input) {
    console.error('[COMPOSITION ARCHITECT] Null input provided');
    return createFallbackPlan({
      slideId: 'unknown',
      slideTitle: 'Unknown',
      slidePurpose: 'Unknown',
      routerConfig: {
        renderMode: 'standard',
        layoutVariant: 'standard-vertical',
        layoutIntent: '',
        densityBudget: { maxChars: 500, maxItems: 4, minVisuals: 1 },
        visualFocus: ''
      },
      contentPlan: {},
      variationBudget: 0.5
    });
  }
  
  if (!tracker) {
    console.error('[COMPOSITION ARCHITECT] Null tracker provided');
    return createFallbackPlan(input);
  }
  
  console.log(`[COMPOSITION ARCHITECT] Planning composition for "${input.slideTitle || 'untitled'}"...`);
  
  // Build content summary for the prompt
  const contentSummary = buildContentSummary(input.contentPlan);
  
  // Build the task prompt
  const taskPrompt = buildCompositionTask(
    input.slideTitle,
    input.slidePurpose,
    input.routerConfig,
    contentSummary,
    input.serendipityDNA,
    input.variationBudget,
    input.narrativeTrail,
    input.usedSurprisesInDeck
  );
  
  try {
    const result = await createJsonInteraction<CompositionPlan>(
      COMPOSITION_ARCHITECT_MODEL,
      taskPrompt,
      COMPOSITION_PLAN_SCHEMA,
      {
        systemInstruction: COMPOSITION_ARCHITECT_ROLE,
        temperature: 0.4, // Moderate temperature for some variation
        maxOutputTokens: 2048
      },
      tracker
    );
    
    // Validate and normalize
    const normalized = normalizeCompositionPlan(result, input);
    
    console.log(`[COMPOSITION ARCHITECT] Plan complete:
  - Background: ${normalized.layerPlan.background.type}
  - Content Pattern: ${normalized.layerPlan.contentStructure.pattern}
  - Surprises: ${normalized.serendipityPlan.allocatedSurprises.map(s => s.type).join(', ') || 'none'}`);
    
    return normalized;
    
  } catch (error: any) {
    console.error(`[COMPOSITION ARCHITECT] Failed: ${error.message}`);
    
    // Return a safe fallback plan
    return createFallbackPlan(input);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function buildContentSummary(contentPlan: CompositionArchitectInput['contentPlan'] | undefined | null): string {
  if (!contentPlan) {
    return 'No content plan available';
  }
  
  const parts: string[] = [];
  
  if (Array.isArray(contentPlan.keyPoints) && contentPlan.keyPoints.length > 0) {
    const validPoints = contentPlan.keyPoints.filter(p => typeof p === 'string' && p.trim());
    if (validPoints.length > 0) {
      parts.push(`Key Points (${validPoints.length}): ${validPoints.slice(0, 3).join('; ')}`);
    }
  }
  
  if (Array.isArray(contentPlan.dataPoints) && contentPlan.dataPoints.length > 0) {
    const validData = contentPlan.dataPoints.filter(d => d && typeof d.label === 'string');
    if (validData.length > 0) {
      parts.push(`Data Points (${validData.length}): ${validData.map(d => `${d.label}: ${d.value ?? 'N/A'}`).join(', ')}`);
    }
  }
  
  return parts.join('\n') || 'No structured content available';
}

function normalizeCompositionPlan(
  raw: any,
  input: CompositionArchitectInput
): CompositionPlan {
  // Guard against null/undefined raw response
  if (!raw || typeof raw !== 'object') {
    console.warn('[normalizeCompositionPlan] Invalid raw response, using fallback');
    return createFallbackPlan(input);
  }
  
  // Safely extract decorative elements
  const decorativeElements = Array.isArray(raw.layerPlan?.decorativeElements)
    ? raw.layerPlan.decorativeElements.filter((el: any) => el && typeof el.type === 'string')
    : [];
  
  // Safely extract surprises
  const rawSurprises = Array.isArray(raw.serendipityPlan?.allocatedSurprises)
    ? raw.serendipityPlan.allocatedSurprises
    : [];
  
  const allocatedSurprises = rawSurprises
    .slice(0, 2)
    .filter((s: any) => s && typeof s.type === 'string')
    .map((s: any) => ({
      type: String(s.type || 'category-badge'),
      target: s.target ? String(s.target) : undefined,
      intensity: ['subtle', 'moderate', 'bold'].includes(s.intensity) ? s.intensity : 'subtle',
      params: typeof s.params === 'object' ? s.params : undefined
    }));
  
  // Validate card style
  const validCardStyles = ['glass', 'solid', 'outline', 'gradient', 'elevated'];
  const rawCardStyle = raw.layerPlan?.contentStructure?.cardStyle;
  const cardStyle = validCardStyles.includes(rawCardStyle) ? rawCardStyle as CardStyle : 'glass';
  
  // Validate content pattern
  const validPatterns = ['single-hero', 'card-row', 'card-grid', 'split-content', 'metrics-rail', 'narrative-flow'];
  const rawPattern = raw.layerPlan?.contentStructure?.pattern;
  const pattern = validPatterns.includes(rawPattern) ? rawPattern : 'split-content';
  
  return {
    slideId: raw.slideId || input.slideId,
    layerPlan: {
      background: {
        type: ['solid', 'gradient', 'image', 'mesh'].includes(raw.layerPlan?.background?.type)
          ? raw.layerPlan.background.type
          : 'gradient',
        suggestion: String(raw.layerPlan?.background?.suggestion || 'Dark professional gradient')
      },
      decorativeElements,
      contentStructure: {
        pattern,
        cardCount: typeof raw.layerPlan?.contentStructure?.cardCount === 'number'
          ? Math.max(0, Math.min(6, raw.layerPlan.contentStructure.cardCount))
          : undefined,
        cardStyle,
        textBlockCount: typeof raw.layerPlan?.contentStructure?.textBlockCount === 'number'
          ? Math.max(0, Math.min(4, raw.layerPlan.contentStructure.textBlockCount))
          : undefined
      },
      overlayIntention: raw.layerPlan?.overlayIntention ? String(raw.layerPlan.overlayIntention) : undefined
    },
    serendipityPlan: {
      variationBudget: typeof input.variationBudget === 'number'
        ? Math.max(0, Math.min(1, input.variationBudget))
        : 0.5,
      allocatedSurprises,
      compositionChoices: raw.serendipityPlan?.compositionChoices || undefined
    },
    reasoning: String(raw.reasoning || 'Plan normalized from LLM output')
  };
}

function createFallbackPlan(input: CompositionArchitectInput): CompositionPlan {
  // Conservative fallback that still looks modern
  const hasData = (input.contentPlan.dataPoints?.length || 0) > 0;
  
  return {
    slideId: input.slideId,
    layerPlan: {
      background: {
        type: 'gradient',
        suggestion: 'Dark navy to slate gradient'
      },
      decorativeElements: [],
      contentStructure: {
        pattern: hasData ? 'split-content' : 'single-hero',
        cardCount: hasData ? 2 : 0,
        cardStyle: 'glass',
        textBlockCount: 1
      },
      overlayIntention: undefined
    },
    serendipityPlan: {
      variationBudget: input.variationBudget,
      allocatedSurprises: [], // No surprises in fallback (safe)
      compositionChoices: undefined
    },
    reasoning: 'Fallback plan: conservative glass-card layout'
  };
}

// ============================================================================
// DECK-LEVEL SURPRISE TRACKING
// ============================================================================

/**
 * Tracks which surprise types have been used in a deck to avoid repetition.
 * Call this after each slide is composed.
 */
export function trackUsedSurprises(
  currentUsed: string[],
  newPlan: CompositionPlan | null | undefined
): string[] {
  // Guard against null inputs
  const safeCurrentUsed = Array.isArray(currentUsed) ? currentUsed : [];
  
  if (!newPlan || !newPlan.serendipityPlan || !Array.isArray(newPlan.serendipityPlan.allocatedSurprises)) {
    return safeCurrentUsed;
  }
  
  const newSurprises = newPlan.serendipityPlan.allocatedSurprises
    .filter(s => s && typeof s.type === 'string')
    .map(s => s.type);
  
  return [...new Set([...safeCurrentUsed, ...newSurprises])];
}

/**
 * Determines variation budget for a slide based on position and type.
 * Extends the existing computeVariationBudget with per-axis control.
 */
export interface VariationBudgets {
  overall: number;
  layout: number;
  color: number;
  typography: number;
  decoration: number;
}

export function computeDetailedVariationBudget(
  slideIndex: number,
  totalSlides: number,
  slideType: string,
  serendipityDNA?: SerendipityDNA | null
): VariationBudgets {
  // Guard against invalid inputs
  const safeSlideIndex = typeof slideIndex === 'number' && slideIndex >= 0 ? slideIndex : 0;
  const safeTotalSlides = typeof totalSlides === 'number' && totalSlides > 0 ? totalSlides : 1;
  const safeSlideType = typeof slideType === 'string' ? slideType.toLowerCase() : '';
  
  // Base calculation (replicates existing logic)
  const isTitle = safeSlideIndex === 0 || safeSlideType.includes('title');
  const isConclusion = safeSlideIndex === safeTotalSlides - 1 || safeSlideType.includes('conclusion');
  
  const base = isTitle || isConclusion ? 0.25 : 0.45;
  // Prevent division by zero with Math.max(1, ...)
  const drift = 0.15 * (safeSlideIndex / Math.max(1, safeTotalSlides - 1));
  const overall = Math.max(0, Math.min(1, base + drift));
  
  // Apply DNA modifiers with null safety
  const densityMod = serendipityDNA?.accentDensity === 'rich' ? 1.3 :
                     serendipityDNA?.accentDensity === 'minimal' ? 0.7 : 1.0;
  const biasMod = serendipityDNA?.compositionBias === 'dynamic' ? 1.2 :
                  serendipityDNA?.compositionBias === 'symmetric' ? 0.8 : 1.0;
  
  return {
    overall,
    layout: Math.min(1, overall * biasMod),
    color: overall * 0.8, // Keep color more consistent
    typography: overall * 0.6, // Typography least variable
    decoration: Math.min(1, overall * densityMod)
  };
}
