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
 * 5. Style-Aware Composition: Respect StyleMode constraints for layout and density
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
  NarrativeTrail,
  StyleMode,
  StyleProfile,
  getStyleProfile
} from "../../types/slideTypes";
import {
  createJsonInteraction,
  CostTracker,
  MODEL_SIMPLE,
  TOKEN_BUDGETS
} from "../interactionsClient";

// ============================================================================
// CONSTANTS
// ============================================================================

// Use MODEL_SIMPLE (gemini-2.5-flash) for Composition Architect
// This is a classification/planning task, not reasoning-heavy
const COMPOSITION_ARCHITECT_MODEL = MODEL_SIMPLE;

// ============================================================================
// STYLE-AWARE VARIATION BUDGET
// ============================================================================

/**
 * Apply style-specific multiplier to variation budget
 * This is the key integration point that makes Serendipitous mode actually different
 */
export function applyStyleMultiplierToVariationBudget(
  baseVariationBudget: number,
  styleMode: StyleMode | undefined
): number {
  const style = getStyleProfile(styleMode);
  const multiplied = baseVariationBudget * style.variationBudgetMultiplier;
  
  // Clamp to 0-1 range
  return Math.max(0, Math.min(1, multiplied));
}

/**
 * Get style-constrained surprise allowlist
 * Corporate mode limits bold surprises; Serendipitous mode enables more creativity
 */
export function getStyleConstrainedSurprises(
  baseAllowedTypes: string[],
  styleMode: StyleMode | undefined
): string[] {
  const style = getStyleProfile(styleMode);
  
  // Corporate mode: only subtle surprises
  if (style.mode === 'corporate') {
    const corporateAllowed = ['subtle-badge', 'accent-underline', 'icon-glow', 'gradient-divider'];
    return baseAllowedTypes.filter(t => corporateAllowed.includes(t));
  }
  
  // Serendipitous mode: full palette + extras
  if (style.mode === 'serendipitous') {
    const serendipitousExtras = ['asymmetric-emphasis', 'floating-stat', 'connector-flow', 'quote-callout'];
    return [...new Set([...baseAllowedTypes, ...serendipitousExtras])];
  }
  
  // Professional: balanced
  return baseAllowedTypes;
}

/**
 * Get style-appropriate intensity bias
 */
export function getStyleIntensityBias(
  baseIntensity: 'subtle' | 'moderate' | 'bold',
  styleMode: StyleMode | undefined
): 'subtle' | 'moderate' | 'bold' {
  const style = getStyleProfile(styleMode);
  
  // Corporate: always subtle or moderate, never bold
  if (style.mode === 'corporate' && baseIntensity === 'bold') {
    return 'moderate';
  }
  
  // Serendipitous: can bump up intensity
  if (style.mode === 'serendipitous' && baseIntensity === 'subtle') {
    return 'moderate';
  }
  
  return baseIntensity;
}

// ============================================================================
// PROMPTS
// ============================================================================

const COMPOSITION_ARCHITECT_ROLE = `You are an Elite Visual Composition Architect with 20+ years designing presentations for Fortune 500 CEOs and TED speakers.
Your job is to plan the STRUCTURE of a slide using explicit layers and compositional primitives that would make Steve Jobs proud.

CORE EXPERTISE:
- Layer hierarchy: Background → Decorative → Content → Overlay
- Modern design patterns: glass cards, category badges, accent glows, icon containers
- Theme coherence: maintaining DNA while introducing controlled variation
- The PowerPoint native model: shapes, text, images with z-ordering

DESIGN COMMANDMENTS (Non-Negotiable):

1. LESS IS MORE
   - Each slide makes ONE clear point with surgical precision
   - Remove until it breaks, then add back ONE thing
   - If you can't explain the visual in 3 seconds, simplify

2. VISUAL HIERARCHY IS EVERYTHING
   - Hero element gets 60% visual weight (size, contrast, position)
   - Supporting elements share the remaining 40%
   - Eye flow: top-left → center → bottom-right (Z-pattern for narrative)

3. BREATHING ROOM IS MANDATORY
   - 20-30% negative space is the mark of premium design
   - Cramped slides scream "amateur" - space says "confident"
   - When in doubt, add more whitespace, not more content

4. CONTRAST CREATES CLARITY
   - Dark backgrounds demand light text (and vice versa)
   - NEVER place busy text on busy backgrounds
   - Text zones must be "quiet" - low texture, high contrast

5. CARDS ARE FOR STRUCTURE
   - Complex content belongs in glass cards with: icon + overline + title + body
   - Cards provide visual grouping without explicit boxes
   - 2-3 cards in a row for comparison, 1 card for emphasis

6. BADGES ANCHOR CONTEXT
   - Category badges at top-left establish "what this slide is about" instantly
   - Use sparingly (not every slide) for maximum impact
   - Pill shape, icon + uppercase text, brand color

7. ASYMMETRY > CENTERING
   - Center-everything is the hallmark of amateur design
   - Slight offsets and deliberate imbalance feel modern and dynamic
   - Exception: Hero/title slides CAN center for dramatic effect

8. TYPOGRAPHY HIERARCHY MUST BE VISIBLE
   - Title: Bold, large (36-48pt), high contrast
   - Subtitle/Overline: Medium weight, smaller (18-22pt)
   - Body: Regular weight, comfortable (14-16pt)
   - Never use same weight for title and body`;


const buildCompositionTask = (
  slideTitle: string,
  slidePurpose: string,
  routerConfig: RouterDecision,
  contentSummary: string,
  serendipityDNA?: SerendipityDNA,
  variationBudget?: number,
  narrativeTrail?: NarrativeTrail[],
  usedSurprises?: string[],
  styleMode?: StyleMode
): string => {
  const style = getStyleProfile(styleMode);
  
  // COMPACT PROMPT: Reduced token count to prevent truncation (was causing mid-JSON cutoff)
  return `Plan layer structure for a premium slide.

CONTEXT:
- Title: "${slideTitle}"
- Layout: ${routerConfig.layoutVariant}
- Budget: ${variationBudget?.toFixed(2) || '0.5'} (0=safe, 1=bold)${styleMode ? ` [${styleMode}]` : ''}
- Content: ${contentSummary.substring(0, 200)}${contentSummary.length > 200 ? '...' : ''}

${styleMode === 'corporate' ? 'STYLE: Corporate (max stability, clean grids, subtle decorations only)' : 
  styleMode === 'serendipitous' ? 'STYLE: Serendipitous (bold visuals, high whitespace, asymmetric layouts OK)' : 
  'STYLE: Professional (balanced modern)'}

${usedSurprises?.length ? `AVOID REPEATING: ${usedSurprises.slice(0, 3).join(', ')}` : ''}

DECISIONS NEEDED:
1. BACKGROUND: solid/gradient/mesh - must have quiet zones for text
2. DECORATIVE (0-2): category-badge, icon-glow, accent-underline, gradient-divider
3. CONTENT PATTERN (pick ONE):
   - single-hero: Large title, max breathing room
   - card-row: 2-4 horizontal cards with icon+title+body
   - split-content: Text left + visual right
   - metrics-rail: KPIs left + narrative right
4. SURPRISES (based on budget):
   - 0-0.3: max 1 subtle (icon-glow)
   - 0.4-0.6: 1-2 moderate (badge + glow)
   - 0.7-1.0: 2 bold (asymmetric, floating-stat)

OUTPUT: JSON matching CompositionPlan schema. Include brief reasoning.`;
}


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
            cardCount: { type: "integer" },  // FIX: Use "integer" instead of "number" for clearer JSON schema compliance
            cardStyle: { type: "string", enum: ["glass", "solid", "outline", "gradient", "elevated"] },
            textBlockCount: { type: "integer" }  // FIX: Use "integer" instead of "number"
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
          maxItems: 3,  // FIX: Limit array size to prevent excessive output
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              target: { type: "string" },
              intensity: { type: "string", enum: ["subtle", "moderate", "bold"] },
              // FIX: Replace empty params object with explicit color/scale properties
              // Gemini requires non-empty properties for OBJECT type
              color: { type: "string" },  // For glows, borders
              scale: { type: "number" }   // For asymmetric emphasis (1.0-1.5)
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
  styleMode?: StyleMode; // NEW: Style mode for composition constraints
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

  // Apply style multiplier to variation budget
  const styleAdjustedBudget = applyStyleMultiplierToVariationBudget(
    input.variationBudget,
    input.styleMode
  );

  console.log(`[COMPOSITION ARCHITECT] Planning composition for "${input.slideTitle || 'untitled'}"${input.styleMode ? ` (style: ${input.styleMode}, budget: ${input.variationBudget.toFixed(2)} → ${styleAdjustedBudget.toFixed(2)})` : ''}...`);

  // Build content summary for the prompt
  const contentSummary = buildContentSummary(input.contentPlan);

  // Build the task prompt with style-adjusted budget
  const taskPrompt = buildCompositionTask(
    input.slideTitle,
    input.slidePurpose,
    input.routerConfig,
    contentSummary,
    input.serendipityDNA,
    styleAdjustedBudget, // Use style-adjusted budget
    input.narrativeTrail,
    input.usedSurprisesInDeck,
    input.styleMode // Pass style mode to prompt builder
  );

  try {
    // FIX: Increased maxOutputTokens from 2048 to 3072 to prevent mid-JSON truncation
    // Truncation was causing repeated JSON repair overhead and belief anchor failures
    // See: https://www.philschmid.de/building-agents - "tools are belief anchors"
    const result = await createJsonInteraction<CompositionPlan>(
      COMPOSITION_ARCHITECT_MODEL,
      taskPrompt,
      COMPOSITION_PLAN_SCHEMA,
      {
        systemInstruction: COMPOSITION_ARCHITECT_ROLE,
        temperature: 0.3, // Reduced from 0.4 for more deterministic output
        maxOutputTokens: 3072
      },
      tracker
    );

    // Validate and normalize (with style constraints)
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

// ============================================================================
// POSITIONAL SURPRISE CHOREOGRAPHY
// ============================================================================

/**
 * Computes position-aware surprise budget and allowed types.
 * Creates a "narrative arc" for visual surprises across the deck:
 * - Title/intro: Conservative, impactful
 * - Early slides: Establish pattern, moderate surprises
 * - Middle slides: Peak creativity, full palette
 * - Late slides: Converge back to theme
 * - Conclusion: Very conservative, powerful closure
 */
export interface PositionalSurpriseBudget {
  budget: number;
  allowedTypes: string[];
  maxSurprises: number;
  intensityBias: 'subtle' | 'moderate' | 'bold';
  narrativePhase: 'opening' | 'building' | 'climax' | 'resolution' | 'closing';
}

export function computePositionalSurpriseBudget(
  slideIndex: number,
  totalSlides: number,
  slideType: string
): PositionalSurpriseBudget {
  // Guard inputs
  const safeIndex = Math.max(0, slideIndex);
  const safeTotal = Math.max(1, totalSlides);
  const position = safeIndex / Math.max(1, safeTotal - 1);
  const safeType = (slideType || '').toLowerCase();

  // Title slide (index 0): Conservative but impactful
  if (safeIndex === 0 || safeType.includes('title')) {
    return {
      budget: 0.25,
      allowedTypes: ['hero-glow', 'subtle-badge', 'accent-underline'],
      maxSurprises: 1,
      intensityBias: 'subtle',
      narrativePhase: 'opening'
    };
  }

  // Conclusion slide: Very conservative, powerful closure
  if (safeIndex === safeTotal - 1 || safeType.includes('conclusion')) {
    return {
      budget: 0.2,
      allowedTypes: ['hero-glow', 'accent-underline'],
      maxSurprises: 1,
      intensityBias: 'subtle',
      narrativePhase: 'closing'
    };
  }

  // First third (slides 1-33%): Building phase - establish patterns
  if (position < 0.33) {
    return {
      budget: 0.4,
      allowedTypes: [
        'category-badge',
        'accent-underline',
        'icon-glow',
        'gradient-divider'
      ],
      maxSurprises: 1,
      intensityBias: 'subtle',
      narrativePhase: 'building'
    };
  }

  // Middle third (33-66%): Climax phase - peak creativity
  if (position < 0.66) {
    return {
      budget: 0.7,
      allowedTypes: [
        'category-badge',
        'accent-underline',
        'icon-glow',
        'quote-callout',
        'asymmetric-emphasis',
        'connector-flow',
        'floating-stat',
        'gradient-divider',
        'narrative-flow-pattern'
      ],
      maxSurprises: 2,
      intensityBias: 'bold',
      narrativePhase: 'climax'
    };
  }

  // Last third (66-100%): Resolution phase - converge back
  return {
    budget: 0.45,
    allowedTypes: [
      'category-badge',
      'icon-glow',
      'accent-underline',
      'gradient-divider'
    ],
    maxSurprises: 1,
    intensityBias: 'moderate',
    narrativePhase: 'resolution'
  };
}

/**
 * Determines if a slide should use the narrative-flow (3-card story) pattern.
 * This is a premium pattern that works best for transformation/process slides.
 */
export function shouldUseNarrativeFlow(
  slidePurpose: string,
  contentKeyPoints: string[],
  slideType: string
): boolean {
  const purposeLower = (slidePurpose || '').toLowerCase();
  const typeLower = (slideType || '').toLowerCase();

  // Keywords that suggest narrative/transformation content
  const narrativeKeywords = [
    'transform', 'process', 'journey', 'evolution', 'change',
    'problem', 'solution', 'approach', 'trap', 'mandate', 'destination',
    'before', 'after', 'current', 'future', 'vision',
    'challenge', 'opportunity', 'outcome', 'steps', 'phases',
    'old', 'new', 'legacy', 'modern', 're-engineer', 'redesign'
  ];

  const hasNarrativeKeyword = narrativeKeywords.some(kw =>
    purposeLower.includes(kw)
  );

  // Check if content naturally divides into 3 parts
  const hasThreePoints = contentKeyPoints && contentKeyPoints.length >= 3;

  // Best for content-main slides, not title/intro/conclusion
  const appropriateType = !typeLower.includes('title') &&
    !typeLower.includes('conclusion') &&
    !typeLower.includes('intro');

  return hasNarrativeKeyword && hasThreePoints && appropriateType;
}
