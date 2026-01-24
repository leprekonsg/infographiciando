
import { SlideNode, ValidationResult, RenderModeSchema, VisualDesignSpec, RouterDecision, SlideLayoutPlanSchema, VisualCritiqueReportSchema, VisualCritiqueReport, PREMIUM_QUALITY_CHECKS } from "../types/slideTypes";
import { CompositionPlan } from "../types/serendipityTypes";

// Helper for contrast check (handles hex with or without # prefix)
const hasGoodContrast = (hex: string): boolean => {
  if (!hex || typeof hex !== 'string') return true; // Assume OK if no color specified

  // Normalize: remove # if present, ensure 6 chars
  let cleanHex = hex.replace('#', '').trim();
  if (cleanHex.length === 3) {
    cleanHex = cleanHex[0] + cleanHex[0] + cleanHex[1] + cleanHex[1] + cleanHex[2] + cleanHex[2];
  }
  if (cleanHex.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(cleanHex)) {
    // Can't parse - assume OK
    return true;
  }

  // Convert hex to RGB
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
  // Allow very dark or very light backgrounds (text color can adapt)
  // Flag mid-tone backgrounds that often reduce legibility
  return yiq < 160 || yiq > 220;
};

const isPlaceholderValue = (value: any): boolean => {
  if (value === null || value === undefined) return true;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return true;
  return [
    'n/a', 'na', 'tbd', 'unknown', 'none', 'null', 'nil', 'not available',
    '-', '—', '...', 'n.a.'
  ].includes(raw);
};

// ============================================================================
// PREMIUM/SERENDIPITY MODE VALIDATION
// ============================================================================

/**
 * Validates a composition plan against premium quality standards.
 * Used when SERENDIPITY_MODE_ENABLED is true to ensure "Steve Jobs quality".
 * 
 * @param compositionPlan - The composition plan from Composition Architect
 * @param slideNode - The slide being validated
 * @returns ValidationResult with premium-specific checks
 */
export const validatePremiumComposition = (
  compositionPlan: CompositionPlan | undefined,
  slideNode: SlideNode
): ValidationResult => {
  const errors: { code: string; message: string; suggestedFix?: string }[] = [];
  let score = 100;

  if (!compositionPlan) {
    return { passed: true, score: 100, errors: [] }; // Skip if no composition plan
  }

  // 1. Check decorative element count (not too many surprises)
  const decorativeCount = compositionPlan.layerPlan?.decorativeElements?.length || 0;
  if (decorativeCount > PREMIUM_QUALITY_CHECKS.MAX_BADGES_PER_SLIDE) {
    score -= 10;
    errors.push({
      code: 'PREMIUM_TOO_MANY_DECORATIVES',
      message: `Too many decorative elements (${decorativeCount}) - premium slides should be minimal`,
      suggestedFix: `Reduce decorative elements to ${PREMIUM_QUALITY_CHECKS.MAX_BADGES_PER_SLIDE} or fewer`
    });
  }

  // 2. Check card count for card-based patterns
  const cardCount = compositionPlan.layerPlan?.contentStructure?.cardCount || 0;
  const pattern = compositionPlan.layerPlan?.contentStructure?.pattern;
  
  if ((pattern === 'card-row' || pattern === 'narrative-flow' || pattern === 'card-grid') 
      && cardCount > PREMIUM_QUALITY_CHECKS.MAX_CARDS_PER_SLIDE) {
    score -= 15;
    errors.push({
      code: 'PREMIUM_TOO_MANY_CARDS',
      message: `Too many cards (${cardCount}) - premium designs use 2-4 cards max`,
      suggestedFix: `Reduce to ${PREMIUM_QUALITY_CHECKS.MAX_CARDS_PER_SLIDE} cards for visual clarity`
    });
  }

  // 3. Check surprise intensity matches budget
  const surprises = compositionPlan.serendipityPlan?.allocatedSurprises || [];
  const budget = compositionPlan.serendipityPlan?.variationBudget || 0.5;
  const boldSurprises = surprises.filter(s => s.intensity === 'bold').length;
  
  if (budget < 0.5 && boldSurprises > 0) {
    score -= 10;
    errors.push({
      code: 'PREMIUM_SURPRISE_BUDGET_MISMATCH',
      message: 'Bold surprises used with conservative budget - breaks design consistency',
      suggestedFix: 'Use subtle or moderate intensity surprises for conservative slides'
    });
  }

  // 4. Narrative-flow pattern validation
  if (pattern === 'narrative-flow' && cardCount !== 3) {
    score -= 5;
    errors.push({
      code: 'PREMIUM_NARRATIVE_CARD_COUNT',
      message: 'Narrative-flow pattern should have exactly 3 cards (problem/insight/solution)',
      suggestedFix: 'Adjust card count to 3 for proper narrative structure'
    });
  }

  // 5. Check negative space is planned (breathing room)
  const layoutComponents = slideNode.layoutPlan?.components || [];
  if (layoutComponents.length > PREMIUM_QUALITY_CHECKS.MAX_ELEMENT_DENSITY) {
    score -= 15;
    errors.push({
      code: 'PREMIUM_HIGH_DENSITY',
      message: `Too many components (${layoutComponents.length}) - premium slides need breathing room`,
      suggestedFix: 'Simplify content to fewer, higher-impact elements'
    });
  }

  return {
    passed: errors.length === 0,
    score,
    errors
  };
};

// ============================================================================
// STANDARD VALIDATION
// ============================================================================

export const validateVisualLayoutAlignment = (
  visualDesign: VisualDesignSpec,
  routerConfig: RouterDecision,
  layoutPlan?: any
): ValidationResult => {
  const errors: any[] = [];
  let score = 100;

  // 1. Check spatial strategy matches layout variant
  const validLayoutVariants = ['standard-vertical', 'split-left-text', 'split-right-text', 'hero-centered', 'bento-grid', 'timeline-horizontal', 'dashboard-tiles', 'metrics-rail', 'asymmetric-grid'];
  if (!validLayoutVariants.includes(routerConfig.layoutVariant)) {
    score -= 20;
    errors.push({
      code: 'INVALID_LAYOUT_VARIANT',
      message: `Layout variant not recognized`,
      suggestedFix: `Use one of: ${validLayoutVariants.join(', ')}`
    });
  }

  // 2. Check negative space allocation with robust parsing
  // Handle various formats: "20%", "20 percent", "twenty percent", or just "20"
  let negativeSpacePct = 20; // Default to a reasonable value if parsing fails
  if (visualDesign.negative_space_allocation) {
    const negMatch = visualDesign.negative_space_allocation.match(/(\d+)/);
    if (negMatch) {
      negativeSpacePct = parseInt(negMatch[1], 10);
    } else {
      // Try to handle word-based percentages
      const wordToNum: Record<string, number> = {
        'ten': 10, 'fifteen': 15, 'twenty': 20, 'twenty-five': 25,
        'thirty': 30, 'thirty-five': 35, 'forty': 40, 'fifty': 50
      };
      const lower = visualDesign.negative_space_allocation.toLowerCase();
      for (const [word, num] of Object.entries(wordToNum)) {
        if (lower.includes(word)) {
          negativeSpacePct = num;
          break;
        }
      }
    }
  }

  // Validate negative space is in optimal range (15-35%)
  if (negativeSpacePct < 15) {
    score -= 10;
    errors.push({
      code: 'POOR_NEGATIVE_SPACE',
      message: `Negative space allocation (${negativeSpacePct}%) is too low for professional design`,
      suggestedFix: 'Increase negative space to at least 15%'
    });
  } else if (negativeSpacePct > 35) {
    score -= 5;
    errors.push({
      code: 'EXCESSIVE_NEGATIVE_SPACE',
      message: `Negative space allocation (${negativeSpacePct}%) is unusually high`,
      suggestedFix: 'Reduce negative space to 35% or less for better content density'
    });
  }

  // 3. Check color contrast with background (flag mid-tone ambiguity)
  if (visualDesign.color_harmony?.background_tone && !hasGoodContrast(visualDesign.color_harmony.background_tone)) {
    score -= 15;
    errors.push({
      code: 'POOR_TEXT_CONTRAST',
      message: 'Background tone is mid-contrast; ensure text color adapts or provide a text-safe zone',
      suggestedFix: 'Use a darker or lighter background tone, or add a text-safe band with strong contrast'
    });
  }

  // 4. Visual Focus Alignment (Did the agent listen to the router?)
  if (routerConfig.visualFocus && routerConfig.visualFocus !== 'Content') {
    const focusTerms = routerConfig.visualFocus.toLowerCase().split(' ');
    const promptLower = visualDesign.prompt_with_composition.toLowerCase();
    const elementsLower = (visualDesign.foreground_elements || []).join(' ').toLowerCase();

    const mentionsFocus = focusTerms.some(term =>
      term.length > 3 && (promptLower.includes(term) || elementsLower.includes(term))
    );

    if (!mentionsFocus) {
      score -= 15;
      errors.push({
        code: 'VISUAL_FOCUS_MISSING',
        message: `Visual spec does not reflect the required focus: "${routerConfig.visualFocus}"`,
        suggestedFix: `Include "${routerConfig.visualFocus}" in the prompt or foreground elements`
      });
    }
  }

  // 5. Ensure visual zones don't compete with text zones
  // This is a heuristic check
  if (layoutPlan) {
    const textZones = layoutPlan.components?.filter((c: any) => c.type === 'text-bullets').length || 0;
    const visualElements = visualDesign.foreground_elements?.length || 0;
    if (visualElements > 3 && textZones > 2) {
      score -= 10;
      errors.push({
        code: 'VISUAL_TEXT_CONFLICT',
        message: 'Too many visual and text elements competing for attention',
        suggestedFix: 'Simplify either visual elements or text components'
      });
    }
  }

  return {
    passed: errors.length === 0,
    score,
    errors
  };
};

export const validateSlide = (slide: SlideNode): ValidationResult => {
  const errors: { code: string; message: string; suggestedFix?: string }[] = [];
  let score = 100;
  let isCriticalFailure = false;

  const CONTENT_LIMITS = {
    title: 70,
    bullet: 120,
    metricValue: 10,
    metricLabel: 20,
    stepTitle: 15,
    stepDescription: 70,
    iconLabel: 20,
    iconDescription: 60,
    chartLabel: 18
  };

  const components = slide.layoutPlan?.components || [];
  const routerConfig = slide.routerConfig;

  // 0. CHECK: Garbage String Detection (The "X-101-A100" Fix)
  // Recursively check all string values in the object for repetitive patterns
  const checkForGarbage = (obj: any, path: string = "") => {
    if (typeof obj === 'string') {
      if (obj.length > 30) {
        const tokens = obj.toLowerCase().split(/[\s-]+/); // Split on space or hyphen
        if (tokens.length > 5) {
          const unique = new Set(tokens);
          // If unique tokens are less than 40% of total tokens, it's garbage
          // e.g. "A100 A100 A100 A100" -> 1 unique / 4 total = 0.25 (FAIL)
          if (unique.size < tokens.length * 0.4) {
            isCriticalFailure = true;
            score -= 50;
            errors.push({
              code: "ERR_REPETITION_DETECTED",
              message: `Garbage detected in ${path}: "${obj.substring(0, 20)}..."`,
              suggestedFix: "Delete this item or rewrite."
            });
          }
        }
      }
    } else if (typeof obj === 'object' && obj !== null) {
      Object.keys(obj).forEach(key => checkForGarbage(obj[key], `${path}.${key}`));
    }
  };

  // Scan the entire layout plan
  checkForGarbage(slide.layoutPlan);

  if (isCriticalFailure) {
    return { passed: false, score, errors };
  }


  // 1. FATAL: Missing Content
  if (!components || components.length === 0) {
    return {
      passed: false,
      score: 0,
      errors: [{ code: "ERR_EMPTY_SLIDE", message: "No components generated.", suggestedFix: "Regenerate with lower temperature." }]
    };
  }

  // 1.5. CHECK: Unsupported or Unknown Components
  // Note: autoRepairSlide should have already mapped these, but we still check as a safety net
  const SUPPORTED_TYPES = ['text-bullets', 'metric-cards', 'process-flow', 'icon-grid', 'chart-frame', 'diagram-svg'];
  components.forEach((c, idx) => {
    if (!SUPPORTED_TYPES.includes(c.type)) {
      // Reduced severity - autoRepairSlide should handle this, but log a warning
      score -= 15;
      errors.push({
        code: "WARN_UNKNOWN_COMPONENT",
        message: `Component type '${c.type}' was not mapped by autoRepair.`,
        suggestedFix: "Check autoRepairSlide type mapping."
      });
    }
  });

  // 1.6. CHECK: Diagram-specific validation
  components.forEach((c, idx) => {
    if (c.type === 'diagram-svg') {
      const elements = (c as any).elements || [];
      if (elements.length < 3) {
        score -= 20;
        errors.push({
          code: "ERR_DIAGRAM_INSUFFICIENT_ELEMENTS",
          message: `Diagram at index ${idx} has only ${elements.length} elements (min: 3)`,
          suggestedFix: "Add more elements or use icon-grid instead"
        });
      }
      if (elements.length > 8) {
        score -= 15;
        errors.push({
          code: "WARN_DIAGRAM_TOO_COMPLEX",
          message: `Diagram at index ${idx} has ${elements.length} elements (max: 8)`,
          suggestedFix: "Split into multiple slides or reduce to 8 elements"
        });
      }
      // Check element structure
      elements.forEach((el: any, elIdx: number) => {
        if (!el.id || !el.label) {
          score -= 10;
          errors.push({
            code: "ERR_DIAGRAM_INVALID_ELEMENT",
            message: `Diagram element ${elIdx} missing required id or label`,
            suggestedFix: "Ensure all elements have id and label fields"
          });
        }
        if (el.label && el.label.length > 30) {
          score -= 5;
          errors.push({
            code: "WARN_DIAGRAM_LABEL_TOO_LONG",
            message: `Diagram element "${el.label}" exceeds 30 characters`,
            suggestedFix: "Shorten label to max 30 characters"
          });
        }
      });
    }
  });

  // 1.7. CHECK: Layout Compatibility
  if (routerConfig?.layoutVariant === 'hero-centered') {
    // Hero centered prefers text-bullets or metric-cards
    // It *can* render others via fallback, but best practice is strictly text-bullets for the "Hero" look.
    if (components.length > 0 && !['text-bullets', 'metric-cards'].includes(components[0].type)) {
      // Not critical anymore since we added fallback, but still a warning for design intent
      score -= 10;
      errors.push({
        code: "WARN_LAYOUT_MISMATCH",
        message: "Hero layout works best with 'text-bullets'.",
        suggestedFix: "Switch component type."
      });
    }
  }

  // 2. CHECK: Density Budget (Text Overflow)
  const totalText = components.reduce((acc, c) => {
    let text = "";
    try {
      if (c.type === 'text-bullets') text += (c.content || []).join(" ");
      if (c.type === 'process-flow') text += (c.steps || []).map(s => s.description || "").join(" ");
      if (c.type === 'metric-cards') text += (c.metrics || []).map(m => m.label || "").join(" ");
      if (c.type === 'icon-grid') text += (c.items || []).map(i => i.label || "").join(" ");
      if (c.type === 'chart-frame' && c.data) text += c.data.map(d => d.label || "").join(" ");
    } catch (e: any) {
      console.warn(`[VALIDATOR] Failed to read component text content: ${e?.message || e}`);
    }
    return acc + text.length;
  }, 0);

  const maxChars = routerConfig?.densityBudget?.maxChars || 600;
  if (totalText > maxChars) {
    score -= 20;
    if (totalText > maxChars * 2) {
      isCriticalFailure = true;
      errors.push({ code: "ERR_TEXT_OVERFLOW_CRITICAL", message: `Text length ${totalText} is double the budget.`, suggestedFix: "Summarize." });
    } else {
      errors.push({ code: "WARN_TEXT_OVERFLOW", message: `Text length ${totalText} exceeds budget.`, suggestedFix: "Summarize." });
    }
  }

  // 2.5. CHECK: Content Quality (Per-item length limits)
  const addLengthIssue = (code: string, message: string, critical = false) => {
    score -= critical ? 10 : 5;
    if (critical) isCriticalFailure = true;
    errors.push({ code, message, suggestedFix: "Shorten text to meet layout constraints" });
  };

  if (slide.layoutPlan?.title && slide.layoutPlan.title.length > CONTENT_LIMITS.title) {
    const critical = slide.layoutPlan.title.length > CONTENT_LIMITS.title * 1.8;
    addLengthIssue(critical ? 'ERR_TITLE_TOO_LONG' : 'WARN_TITLE_TOO_LONG',
      `Slide title exceeds ${CONTENT_LIMITS.title} chars (${slide.layoutPlan.title.length})`,
      critical);
  }

  components.forEach((c, idx) => {
    if (c.type === 'text-bullets') {
      if (c.title && c.title.length > CONTENT_LIMITS.title) {
        addLengthIssue('WARN_COMPONENT_TITLE_TOO_LONG',
          `Text-bullets title exceeds ${CONTENT_LIMITS.title} chars (index ${idx})`);
      }
      (c.content || []).forEach((b: any, i: number) => {
        if (typeof b === 'string' && b.length > CONTENT_LIMITS.bullet) {
          const critical = b.length > CONTENT_LIMITS.bullet * 1.6;
          addLengthIssue(critical ? 'ERR_BULLET_TOO_LONG' : 'WARN_BULLET_TOO_LONG',
            `Bullet ${i + 1} exceeds ${CONTENT_LIMITS.bullet} chars (index ${idx})`,
            critical);
        }
      });
    }

    if (c.type === 'metric-cards') {
      (c.metrics || []).forEach((m: any, i: number) => {
        if (m?.value && String(m.value).length > CONTENT_LIMITS.metricValue) {
          addLengthIssue('WARN_METRIC_VALUE_TOO_LONG',
            `Metric value too long (${String(m.value).length} chars) at index ${idx}.${i}`);
        }
        if (m?.label && String(m.label).length > CONTENT_LIMITS.metricLabel) {
          addLengthIssue('WARN_METRIC_LABEL_TOO_LONG',
            `Metric label too long (${String(m.label).length} chars) at index ${idx}.${i}`);
        }

        if (isPlaceholderValue(m?.value) || isPlaceholderValue(m?.label)) {
          score -= 25;
          errors.push({
            code: 'ERR_PLACEHOLDER_METRIC',
            message: `Placeholder metric detected at index ${idx}.${i}.`,
            suggestedFix: 'Remove metric-cards or provide real dataPoints.'
          });
          isCriticalFailure = true;
        }
      });
    }

    if (c.type === 'process-flow') {
      (c.steps || []).forEach((s: any, i: number) => {
        if (s?.title && String(s.title).length > CONTENT_LIMITS.stepTitle) {
          addLengthIssue('WARN_STEP_TITLE_TOO_LONG',
            `Step title too long (${String(s.title).length} chars) at index ${idx}.${i}`);
        }
        if (s?.description && String(s.description).length > CONTENT_LIMITS.stepDescription) {
          const critical = String(s.description).length > CONTENT_LIMITS.stepDescription * 1.6;
          addLengthIssue(critical ? 'ERR_STEP_DESC_TOO_LONG' : 'WARN_STEP_DESC_TOO_LONG',
            `Step description too long (${String(s.description).length} chars) at index ${idx}.${i}`,
            critical);
        }
      });
    }

    if (c.type === 'icon-grid') {
      (c.items || []).forEach((it: any, i: number) => {
        if (it?.label && String(it.label).length > CONTENT_LIMITS.iconLabel) {
          addLengthIssue('WARN_ICON_LABEL_TOO_LONG',
            `Icon label too long (${String(it.label).length} chars) at index ${idx}.${i}`);
        }
        if (it?.description && String(it.description).length > CONTENT_LIMITS.iconDescription) {
          addLengthIssue('WARN_ICON_DESC_TOO_LONG',
            `Icon description too long (${String(it.description).length} chars) at index ${idx}.${i}`);
        }
      });
    }

    if (c.type === 'chart-frame') {
      (c.data || []).forEach((d: any, i: number) => {
        if (d?.label && String(d.label).length > CONTENT_LIMITS.chartLabel) {
          addLengthIssue('WARN_CHART_LABEL_TOO_LONG',
            `Chart label too long (${String(d.label).length} chars) at index ${idx}.${i}`);
        }
      });
    }
  });

  // 3. CHECK: Visual Density
  let iconCount = 0;
  let requiresIcons = false;
  components.forEach(c => {
    try {
      if (c.type === 'metric-cards') { requiresIcons = true; iconCount += (c.metrics || []).filter(m => !!m.icon).length; }
      if (c.type === 'icon-grid') { requiresIcons = true; iconCount += (c.items || []).filter(i => !!i.icon).length; }
    } catch (e: any) {
      console.warn(`[VALIDATOR] Failed to read icon data: ${e?.message || e}`);
    }
  });

  if (requiresIcons && iconCount === 0) {
    score -= 30;
    isCriticalFailure = true;
    errors.push({ code: "ERR_MISSING_VISUALS_CRITICAL", message: "Visual component has 0 icons.", suggestedFix: "Inject icons." });
  }

  // 4. CHECK: Mode Compliance (Demoted to Warning - graceful degradation is OK)
  if (routerConfig?.renderMode === 'data-viz' || slide.type === 'data-viz') {
    const hasChartFrame = components.some(c => c.type === 'chart-frame');
    const hasChartSpec = !!slide.chartSpec;
    // Also check for metric-cards which is an acceptable fallback for data-viz
    const hasMetricCards = components.some(c => c.type === 'metric-cards');

    if (!hasChartFrame && !hasChartSpec && !hasMetricCards) {
      // Only deduct points, don't fail - metric-cards or text-bullets are acceptable fallbacks
      score -= 15;
      errors.push({
        code: "WARN_MODE_MISMATCH",
        message: "Data-Viz mode prefers a chart but will gracefully degrade.",
        suggestedFix: "Add chart-frame or metric-cards component."
      });
    }
  }

  // 5. CHECK: Structure Integrity
  components.forEach(c => {
    if (c.type === 'process-flow' && (!c.steps || !Array.isArray(c.steps))) { isCriticalFailure = true; errors.push({ code: "ERR_MALFORMED_COMPONENT", message: "Process flow missing steps." }); }
    if (c.type === 'metric-cards' && (!c.metrics || !Array.isArray(c.metrics))) { isCriticalFailure = true; errors.push({ code: "ERR_MALFORMED_COMPONENT", message: "Metric cards missing metrics." }); }
  });

  return {
    passed: !isCriticalFailure,
    score,
    errors
  };
};

// ============================================================================
// CONTENT COMPLETENESS VALIDATION
// ============================================================================
// Validates that slides have substantive content, not just placeholders.
// QA score = 100 should mean "this slide is actually useful", not just "valid JSON".

/** Placeholder phrases that indicate empty/unfinished content */
const PLACEHOLDER_PATTERNS = [
  /no data available/i,
  /key points?$/i,            // Just "Key Points" with no actual points
  /data visualization$/i,     // Placeholder chart label
  /to be (added|determined)/i,
  /coming soon/i,
  /placeholder/i,
  /\[.*\]/,                   // [Insert text here] style
  /n\/a/i,
  /tbd/i
];

/** 
 * Check if a string matches placeholder patterns
 */
function isPlaceholderContent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 3) return true;
  return PLACEHOLDER_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Calculate string similarity using word overlap (Jaccard-like for word tokens)
 * Returns value between 0 (no similarity) and 1 (identical)
 */
function calculateStringSimilarity(str1: string, str2: string): number {
  // Tokenize into words, filter short words and common stop words
  const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by', 'from', 'and', 'or', 'but', 'so', 'yet',
    'this', 'that', 'these', 'those', 'it', 'its']);
  
  const tokenize = (s: string): Set<string> => {
    const words = s.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    return new Set(words);
  };
  
  const tokens1 = tokenize(str1);
  const tokens2 = tokenize(str2);
  
  if (tokens1.size === 0 || tokens2.size === 0) return 0;
  
  // Calculate Jaccard similarity
  const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
  const union = new Set([...tokens1, ...tokens2]);
  
  return intersection.size / union.size;
}

/**
 * Content Completeness Validation
 * Checks that slides have real, substantive content rather than:
 * - Empty bullets with "Key Points" labels
 * - Title duplicated as body content
 * - "No Data Available" placeholders
 * - Generic placeholder text
 * - Semantic redundancy (same info repeated)
 * 
 * This validation runs AFTER visual/structural validation and caps QA score.
 */
export interface ContentCompletenessResult {
  passed: boolean;
  score: number;  // 0-100, will cap overall QA score
  issues: { code: string; message: string; severity: 'critical' | 'major' | 'minor'; }[];
}

export function validateContentCompleteness(slide: SlideNode): ContentCompletenessResult {
  const issues: ContentCompletenessResult['issues'] = [];
  let score = 100;
  
  const slideTitle = slide.layoutPlan?.title || slide.title || '';
  const components = slide.layoutPlan?.components || [];
  
  // 1. CHECK: Title duplication in body
  // If the title appears verbatim as a bullet, that's lazy content
  const titleLower = slideTitle.toLowerCase().trim();
  
  components.forEach((comp, idx) => {
    if (comp.type === 'text-bullets') {
      // Filter out null/undefined bullets and ensure all are strings
      const bullets = (comp.content || []).filter((b): b is string => typeof b === 'string' && b !== null);
      
      // Check for title duplication (only if we have a non-empty title)
      if (titleLower && bullets.some(b => b.toLowerCase().trim() === titleLower)) {
        score -= 15;
        issues.push({
          code: 'CONTENT_TITLE_DUPLICATION',
          message: `Slide title "${slideTitle.slice(0, 30)}..." duplicated as bullet content`,
          severity: 'major'
        });
      }
      
      // Check for empty bullets array when title suggests content
      if (bullets.length === 0 && comp.title) {
        score -= 25;
        issues.push({
          code: 'CONTENT_EMPTY_BULLETS',
          message: `Text-bullets component has title "${comp.title}" but no actual bullet points`,
          severity: 'critical'
        });
      }
      
      // Check for placeholder bullets
      bullets.forEach((bullet, bulletIdx) => {
        if (isPlaceholderContent(bullet)) {
          score -= 10;
          issues.push({
            code: 'CONTENT_PLACEHOLDER_BULLET',
            message: `Bullet ${bulletIdx + 1} contains placeholder text: "${bullet.slice(0, 40)}..."`,
            severity: 'major'
          });
        }
      });
      
      // Check for insufficient content (1 bullet that's very short)
      if (bullets.length === 1 && bullets[0] && bullets[0].length < 20) {
        score -= 10;
        issues.push({
          code: 'CONTENT_INSUFFICIENT',
          message: `Only one very short bullet point - slide lacks substance`,
          severity: 'minor'
        });
      }
    }
    
    if (comp.type === 'metric-cards') {
      const metrics = comp.metrics || [];
      
      // Check for "No Data Available" placeholder values
      metrics.forEach((metric, metricIdx) => {
        if (isPlaceholderContent(metric.value) || isPlaceholderContent(metric.label)) {
          score -= 15;
          issues.push({
            code: 'CONTENT_PLACEHOLDER_METRIC',
            message: `Metric ${metricIdx + 1} contains placeholder: "${metric.value}" / "${metric.label}"`,
            severity: 'critical'
          });
        }
      });
      
      // Check for empty metrics array
      if (metrics.length === 0) {
        score -= 25;
        issues.push({
          code: 'CONTENT_EMPTY_METRICS',
          message: 'Metric cards component has no metrics',
          severity: 'critical'
        });
      }
    }
    
    if (comp.type === 'chart-frame') {
      const data = comp.data || [];
      
      // Check for empty chart data
      if (data.length === 0) {
        score -= 25;
        issues.push({
          code: 'CONTENT_EMPTY_CHART',
          message: `Chart "${comp.title || 'Untitled'}" has no data points`,
          severity: 'critical'
        });
      }
      
      // Check for placeholder chart titles
      if (comp.title && isPlaceholderContent(comp.title)) {
        score -= 10;
        issues.push({
          code: 'CONTENT_PLACEHOLDER_CHART_TITLE',
          message: `Chart has placeholder title: "${comp.title}"`,
          severity: 'major'
        });
      }
    }
  });
  
  // 2. CHECK: "Key Points" pattern with no points
  // This catches slides with a "Key Points" section label but empty content
  const allText = extractSlideTextForCompleteness(slide);
  if (/key\s*points?/i.test(allText) && countSubstantiveBullets(components) === 0) {
    score -= 30;
    issues.push({
      code: 'CONTENT_KEY_POINTS_EMPTY',
      message: 'Slide has "Key Points" label but no actual key points',
      severity: 'critical'
    });
  }
  
  // 3. CHECK: Overall content density
  // A slide with components but almost no actual text is incomplete
  const totalChars = allText.replace(/\s+/g, '').length;
  if (totalChars < 50 && components.length > 0) {
    score -= 20;
    issues.push({
      code: 'CONTENT_TOO_SPARSE',
      message: `Slide has ${components.length} components but only ${totalChars} characters of content`,
      severity: 'major'
    });
  }
  
  // ============================================================================
  // 4. CHECK: SEMANTIC REDUNDANCY (within-slide)
  // ============================================================================
  // Detects content that says the same thing twice:
  // - Title duplicated as bullet (already checked above, but also check near-duplicates)
  // - Same information repeated across bullets
  // - Section header that just restates the title
  // 
  // When redundancy is detected, prefer content rewrite over geometry repair,
  // because moving a duplicated bullet doesn't fix the underlying problem.
  
  // 4a. Check for near-duplicate title in component titles
  if (titleLower && titleLower.length > 5) {
    components.forEach((comp, idx) => {
      if ('title' in comp && comp.title) {
        const compTitleLower = comp.title.toLowerCase().trim();
        // Check for high similarity (90%+ overlap)
        if (compTitleLower.length > 5 && calculateStringSimilarity(titleLower, compTitleLower) > 0.85) {
          score -= 10;
          issues.push({
            code: 'CONTENT_REDUNDANT_TITLE',
            message: `Component ${idx} title "${comp.title.slice(0, 30)}..." restates slide title`,
            severity: 'minor'
          });
        }
      }
    });
  }
  
  // 4b. Check for repeated bullets within text-bullets components
  components.forEach((comp, compIdx) => {
    if (comp.type === 'text-bullets') {
      const bullets = (comp.content || []).filter((b): b is string => typeof b === 'string' && b.length > 10);
      
      // Compare each pair of bullets for similarity
      for (let i = 0; i < bullets.length; i++) {
        for (let j = i + 1; j < bullets.length; j++) {
          const similarity = calculateStringSimilarity(
            bullets[i].toLowerCase(),
            bullets[j].toLowerCase()
          );
          
          if (similarity > 0.75) { // 75%+ similarity = likely duplicate
            score -= 15;
            issues.push({
              code: 'CONTENT_REDUNDANT_BULLETS',
              message: `Bullets ${i + 1} and ${j + 1} in component ${compIdx} say nearly the same thing (${Math.round(similarity * 100)}% similar)`,
              severity: 'major'
            });
            break; // Only report first redundancy per component to avoid spam
          }
        }
      }
    }
  });
  
  // 4c. Check for bullet that just restates title with minor changes
  components.forEach((comp, compIdx) => {
    if (comp.type === 'text-bullets' && titleLower.length > 10) {
      const bullets = (comp.content || []).filter((b): b is string => typeof b === 'string' && b.length > 10);
      
      bullets.forEach((bullet, bulletIdx) => {
        const similarity = calculateStringSimilarity(titleLower, bullet.toLowerCase());
        if (similarity > 0.7 && similarity < 0.95) { // Near-duplicate but not exact
          score -= 10;
          issues.push({
            code: 'CONTENT_BULLET_RESTATES_TITLE',
            message: `Bullet ${bulletIdx + 1} appears to restate the slide title with minor changes`,
            severity: 'minor'
          });
        }
      });
    }
  });
  
  return {
    passed: !issues.some(i => i.severity === 'critical'),
    score: Math.max(0, score),
    issues
  };
}

// ============================================================================
// NO-PLACEHOLDER SHIPPING HARD GATE
// ============================================================================

/** 
 * SHIPPING-CRITICAL placeholder strings that should NEVER appear in exported PPTX.
 * These indicate incomplete content that slipped through generation/repair.
 */
const SHIPPING_BLOCK_PLACEHOLDERS = [
  'No Data Available',
  'Data Visualization',
  'Key Points',         // Only when standalone (no actual points follow)
  '[Insert',            // [Insert text here] style
  'Coming Soon',
  'TBD',
  'To Be Determined',
  'N/A',
  'Placeholder',
  'Lorem ipsum',
  '...',               // Ellipsis-only content
];

/**
 * NO-PLACEHOLDER SHIPPING GATE
 * 
 * Final validation gate that blocks export if placeholder content remains.
 * This is a HARD FAIL - no slide with placeholder content should ship.
 * 
 * Unlike validateContentCompleteness (which caps QA score), this is a boolean gate:
 * - Returns false = BLOCK EXPORT (slide cannot ship)
 * - Returns true = OK to ship
 * 
 * When blocking, returns the offending content so it can be:
 * 1. Removed (if component is non-essential)
 * 2. Converted to simpler text-only fallback
 * 3. Flagged for regeneration
 */
export interface ShippingGateResult {
  canShip: boolean;
  blockedContent: {
    componentIndex: number;
    componentType: string;
    placeholderFound: string;
    location: 'title' | 'value' | 'label' | 'content' | 'data';
  }[];
  recommendation: 'remove_component' | 'convert_to_text' | 'regenerate' | 'ok';
}

export function checkNoPlaceholderShippingGate(slide: SlideNode): ShippingGateResult {
  const blockedContent: ShippingGateResult['blockedContent'] = [];
  const components = slide.layoutPlan?.components || [];
  
  // Check helper: case-insensitive match against block list
  const isBlockedPlaceholder = (text: string): string | null => {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    
    for (const placeholder of SHIPPING_BLOCK_PLACEHOLDERS) {
      if (trimmed.toLowerCase() === placeholder.toLowerCase()) {
        return placeholder;
      }
      // Check if starts with placeholder pattern
      if (placeholder.startsWith('[') && trimmed.toLowerCase().startsWith(placeholder.toLowerCase())) {
        return placeholder;
      }
    }
    
    // Check for ellipsis-only content
    if (/^\.{2,}$/.test(trimmed)) {
      return '...';
    }
    
    return null;
  };
  
  components.forEach((comp, idx) => {
    // Check component title (all types)
    if ('title' in comp && comp.title) {
      const blocked = isBlockedPlaceholder(comp.title);
      if (blocked) {
        blockedContent.push({
          componentIndex: idx,
          componentType: comp.type,
          placeholderFound: blocked,
          location: 'title'
        });
      }
    }
    
    // Type-specific checks
    if (comp.type === 'text-bullets') {
      (comp.content || []).forEach((bullet, bIdx) => {
        const blocked = isBlockedPlaceholder(bullet);
        if (blocked) {
          blockedContent.push({
            componentIndex: idx,
            componentType: comp.type,
            placeholderFound: `${blocked} (bullet ${bIdx + 1})`,
            location: 'content'
          });
        }
      });
    }
    
    if (comp.type === 'metric-cards') {
      (comp.metrics || []).forEach((metric, mIdx) => {
        const valueBlocked = isBlockedPlaceholder(metric.value);
        const labelBlocked = isBlockedPlaceholder(metric.label);
        
        if (valueBlocked) {
          blockedContent.push({
            componentIndex: idx,
            componentType: comp.type,
            placeholderFound: `${valueBlocked} (metric ${mIdx + 1} value)`,
            location: 'value'
          });
        }
        if (labelBlocked) {
          blockedContent.push({
            componentIndex: idx,
            componentType: comp.type,
            placeholderFound: `${labelBlocked} (metric ${mIdx + 1} label)`,
            location: 'label'
          });
        }
      });
    }
    
    if (comp.type === 'chart-frame') {
      // Check chart title
      if (comp.title) {
        const blocked = isBlockedPlaceholder(comp.title);
        if (blocked) {
          blockedContent.push({
            componentIndex: idx,
            componentType: comp.type,
            placeholderFound: `${blocked} (chart title)`,
            location: 'title'
          });
        }
      }
      
      // Check if chart has no data (empty chart = placeholder equivalent)
      if (!comp.data || comp.data.length === 0) {
        blockedContent.push({
          componentIndex: idx,
          componentType: comp.type,
          placeholderFound: '(empty chart data)',
          location: 'data'
        });
      }
    }
    
    if (comp.type === 'process-flow') {
      (comp.steps || []).forEach((step, sIdx) => {
        const titleBlocked = isBlockedPlaceholder(step.title);
        const descBlocked = isBlockedPlaceholder(step.description);
        
        if (titleBlocked) {
          blockedContent.push({
            componentIndex: idx,
            componentType: comp.type,
            placeholderFound: `${titleBlocked} (step ${sIdx + 1} title)`,
            location: 'title'
          });
        }
        if (descBlocked) {
          blockedContent.push({
            componentIndex: idx,
            componentType: comp.type,
            placeholderFound: `${descBlocked} (step ${sIdx + 1} description)`,
            location: 'content'
          });
        }
      });
    }
  });
  
  // Determine recommendation based on what was found
  let recommendation: ShippingGateResult['recommendation'] = 'ok';
  
  if (blockedContent.length > 0) {
    const uniqueComponents = new Set(blockedContent.map(b => b.componentIndex));
    
    if (uniqueComponents.size === 1 && blockedContent.length <= 2) {
      // Single component with 1-2 issues: can likely convert to text or remove
      const comp = components[blockedContent[0].componentIndex];
      if (comp.type === 'chart-frame' || comp.type === 'metric-cards') {
        recommendation = 'convert_to_text';
      } else {
        recommendation = 'remove_component';
      }
    } else if (blockedContent.length > 3) {
      // Multiple issues across components: slide needs regeneration
      recommendation = 'regenerate';
    } else {
      recommendation = 'remove_component';
    }
  }
  
  return {
    canShip: blockedContent.length === 0,
    blockedContent,
    recommendation
  };
}

/** Extract all text from slide for content analysis */
function extractSlideTextForCompleteness(slide: SlideNode): string {
  const parts: string[] = [slide.layoutPlan?.title || '', slide.title || ''];
  
  (slide.layoutPlan?.components || []).forEach(comp => {
    if (comp.type === 'text-bullets') {
      if (comp.title) parts.push(comp.title);
      parts.push(...(comp.content || []));
    } else if (comp.type === 'metric-cards') {
      (comp.metrics || []).forEach(m => {
        parts.push(m.label, m.value);
      });
    } else if (comp.type === 'chart-frame') {
      if (comp.title) parts.push(comp.title);
      (comp.data || []).forEach(d => parts.push(d.label));
    } else if (comp.type === 'process-flow') {
      (comp.steps || []).forEach(s => {
        parts.push(s.title, s.description);
      });
    } else if (comp.type === 'icon-grid') {
      (comp.items || []).forEach(i => {
        parts.push(i.label, i.description || '');
      });
    }
  });
  
  return parts.filter(Boolean).join(' ');
}

/** Count meaningful bullet points (excludes empty/placeholder) */
function countSubstantiveBullets(components: any[]): number {
  let count = 0;
  components.forEach(comp => {
    if (comp.type === 'text-bullets') {
      (comp.content || []).forEach((bullet: string) => {
        if (bullet && bullet.trim().length > 10 && !isPlaceholderContent(bullet)) {
          count++;
        }
      });
    }
  });
  return count;
}

/**
 * Validates API response for visual critique against Zod schema.
 * Returns validated VisualCritiqueReport or null on failure.
 */
export function validateCritiqueResponse(raw: any): VisualCritiqueReport | null {
  const result = VisualCritiqueReportSchema.safeParse(raw);
  if (!result.success) {
    console.error('[VALIDATOR] Critique response invalid:', (result as any).error?.format?.() || 'Unknown error');
    return null;
  }
  return result.data;
}

/**
 * Validates API response for layout repair against Zod schema.
 * Returns validated SlideLayoutPlan or null on failure.
 */
export function validateRepairResponse(raw: any): any | null {
  const result = SlideLayoutPlanSchema.safeParse(raw);
  if (!result.success) {
    console.error('[VALIDATOR] Repair response invalid:', (result as any).error?.format?.() || 'Unknown error');
    return null;
  }
  return result.data;
}

/**
 * GAP 1: Content-Intent Alignment Validation
 * Validates that Generator honored Router's layout and density decisions.
 * Prevents slides from deviating from intended structure.
 */
export function validateGeneratorCompliance(
  slide: SlideNode,
  routerConfig: RouterDecision
): ValidationResult {
  const errors: { code: string; message: string; suggestedFix?: string }[] = [];
  let score = 100;
  let isCritical = false;

  const components = slide.layoutPlan?.components || [];
  const componentTypes = components.map(c => c.type);
  const layoutVariant = routerConfig.layoutVariant;

  // 1. Layout Variant Compliance
  const variantExpectations: Record<string, { requiredTypes?: string[], forbiddenTypes?: string[], minComponents?: number, maxComponents?: number }> = {
    'bento-grid': {
      requiredTypes: ['metric-cards', 'icon-grid'],
      maxComponents: 6,
      minComponents: 2
    },
    'dashboard-tiles': {
      requiredTypes: ['metric-cards'],
      minComponents: 2,
      maxComponents: 3
    },
    'metrics-rail': {
      requiredTypes: ['metric-cards', 'icon-grid'],
      minComponents: 2,
      maxComponents: 3
    },
    'asymmetric-grid': {
      minComponents: 1,
      maxComponents: 3
    },
    'hero-centered': {
      maxComponents: 2,
      minComponents: 1
    },
    'split-left-text': {
      minComponents: 2,
      maxComponents: 3
    },
    'split-right-text': {
      minComponents: 2,
      maxComponents: 3
    },
    'timeline-horizontal': {
      requiredTypes: ['process-flow'],
      maxComponents: 2
    }
  };

  const expectations = variantExpectations[layoutVariant];
  if (expectations) {
    // Check required component types
    if (expectations.requiredTypes && expectations.requiredTypes.length > 0) {
      const hasRequired = expectations.requiredTypes.some(type => componentTypes.includes(type as any));
      if (!hasRequired) {
        score -= 25;
        isCritical = true;
        errors.push({
          code: 'ERR_LAYOUT_MISMATCH_CRITICAL',
          message: `Layout '${layoutVariant}' requires one of: ${expectations.requiredTypes.join(', ')}. Found: ${componentTypes.join(', ')}`,
          suggestedFix: `Add ${expectations.requiredTypes[0]} component or reroute to different layout`
        });
      }
    }

    // Check component count constraints
    if (expectations.minComponents && components.length < expectations.minComponents) {
      score -= 15;
      errors.push({
        code: 'ERR_INSUFFICIENT_COMPONENTS',
        message: `Layout '${layoutVariant}' needs at least ${expectations.minComponents} components, found ${components.length}`,
        suggestedFix: 'Add more components or use simpler layout'
      });
    }

    if (expectations.maxComponents && components.length > expectations.maxComponents) {
      score -= 15;
      isCritical = true;
      errors.push({
        code: 'ERR_TOO_MANY_COMPONENTS',
        message: `Layout '${layoutVariant}' supports max ${expectations.maxComponents} components, found ${components.length}`,
        suggestedFix: 'Reduce components or reroute to standard-vertical layout'
      });
    }
  }

  // 2. Density Budget Compliance
  const totalTextChars = components.reduce((sum, comp) => {
    let chars = 0;
    // FIX: text-bullets uses .content, not .items
    if (comp.type === 'text-bullets') chars += (comp.content || []).join('').length;
    if (comp.type === 'metric-cards') chars += (comp.metrics || []).map((m: any) => (m.label || '') + (m.value || '')).join('').length;
    if (comp.type === 'process-flow') chars += (comp.steps || []).map((s: any) => (s.title || '') + (s.description || '')).join('').length;
    if (comp.type === 'icon-grid') chars += (comp.items || []).map((i: any) => (i.label || '') + (i.description || '')).join('').length;
    return sum + chars;
  }, 0);

  const densityBudget = routerConfig?.densityBudget || { maxChars: 600, maxItems: 4 };
  const charOverage = totalTextChars - densityBudget.maxChars;

  if (charOverage > densityBudget.maxChars * 0.3) {
    // More than 30% over budget
    score -= 25;
    isCritical = true;
    errors.push({
      code: 'ERR_DENSITY_CRITICAL_EXCEEDED',
      message: `Text content ${totalTextChars} chars significantly exceeds budget ${densityBudget.maxChars} (${Math.round(charOverage / densityBudget.maxChars * 100)}% over)`,
      suggestedFix: 'Reroute to layout with higher density budget or reduce content'
    });
  } else if (charOverage > densityBudget.maxChars * 0.15) {
    // 15-30% over budget
    score -= 15;
    errors.push({
      code: 'WARN_DENSITY_EXCEEDED',
      message: `Text content ${totalTextChars} chars exceeds budget ${densityBudget.maxChars} by ${Math.round(charOverage / densityBudget.maxChars * 100)}%`,
      suggestedFix: 'Consider reducing bullet points or metric labels'
    });
  }

  // 3. Item Count Budget Compliance
  const totalItems = components.reduce((sum, comp) => {
    // FIX: text-bullets uses .content, not .items
    if (comp.type === 'text-bullets') return sum + (comp.content?.length || 0);
    if (comp.type === 'metric-cards') return sum + (comp.metrics?.length || 0);
    if (comp.type === 'process-flow') return sum + (comp.steps?.length || 0);
    if (comp.type === 'icon-grid') return sum + (comp.items?.length || 0);
    return sum;
  }, 0);

  if (totalItems > densityBudget.maxItems * 1.5) {
    score -= 20;
    isCritical = true;
    errors.push({
      code: 'ERR_ITEM_COUNT_CRITICAL',
      message: `Total items ${totalItems} significantly exceeds budget ${densityBudget.maxItems}`,
      suggestedFix: 'Reduce number of bullet points, metrics, or grid items'
    });
  } else if (totalItems > densityBudget.maxItems) {
    score -= 10;
    errors.push({
      code: 'WARN_ITEM_COUNT_EXCEEDED',
      message: `Total items ${totalItems} exceeds budget ${densityBudget.maxItems}`,
      suggestedFix: 'Consider reducing items for better visual clarity'
    });
  }

  return {
    passed: !isCritical,
    score,
    errors
  };
}

/**
 * GAP 2: Deck-Wide Narrative Coherence Validation
 * Detects repeated content, narrative arc violations, and thematic drift.
 */
export interface CoherenceIssue {
  type: 'repetition' | 'arc_violation' | 'thematic_drift';
  slideIndices: number[];
  message: string;
  severity: 'minor' | 'major' | 'critical';
}

export interface CoherenceReport {
  coherenceScore: number;
  issues: CoherenceIssue[];
  passed: boolean;
}

/**
 * Calculate Jaccard similarity between two sets of text tokens
 */
function jaccardSimilarity(text1: string, text2: string): number {
  const tokens1 = new Set(text1.toLowerCase().split(/\s+/).filter(t => t.length > 3));
  const tokens2 = new Set(text2.toLowerCase().split(/\s+/).filter(t => t.length > 3));

  if (tokens1.size === 0 && tokens2.size === 0) return 0;

  const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
  const union = new Set([...tokens1, ...tokens2]);

  return intersection.size / union.size;
}

/**
 * Extract all text content from a slide
 */
function extractSlideText(slide: SlideNode): string {
  const components = slide.layoutPlan?.components || [];
  const textParts: string[] = [slide.layoutPlan?.title || ''];

  components.forEach(comp => {
    // FIX: text-bullets uses .content, not .items
    if (comp.type === 'text-bullets') {
      textParts.push(...(comp.content || []));
    } else if (comp.type === 'metric-cards') {
      (comp.metrics || []).forEach((m: any) => {
        textParts.push(m.label || '', m.value || '');
      });
    } else if (comp.type === 'process-flow') {
      (comp.steps || []).forEach((s: any) => {
        textParts.push(s.title || '', s.description || '');
      });
    } else if (comp.type === 'icon-grid') {
      // FIX: icon-grid items have .label, not .title
      (comp.items || []).forEach((i: any) => {
        textParts.push(i.label || '', i.description || '');
      });
    }
  });

  return textParts.join(' ');
}

export function validateDeckCoherence(slides: SlideNode[]): CoherenceReport {
  const issues: CoherenceIssue[] = [];
  let score = 100;

  if (slides.length < 2) {
    return { coherenceScore: 100, issues: [], passed: true };
  }

  // 1. Detect Repetition
  const REPETITION_THRESHOLD = 0.6; // 60% similarity is suspicious
  for (let i = 0; i < slides.length; i++) {
    for (let j = i + 1; j < slides.length; j++) {
      const text1 = extractSlideText(slides[i]);
      const text2 = extractSlideText(slides[j]);

      if (text1.length < 50 || text2.length < 50) continue; // Skip very short slides

      const similarity = jaccardSimilarity(text1, text2);

      if (similarity > REPETITION_THRESHOLD) {
        const severity = similarity > 0.8 ? 'critical' : similarity > 0.7 ? 'major' : 'minor';
        score -= severity === 'critical' ? 20 : severity === 'major' ? 10 : 5;

        issues.push({
          type: 'repetition',
          slideIndices: [i, j],
          message: `Slides ${i + 1} and ${j + 1} have ${Math.round(similarity * 100)}% similar content`,
          severity
        });
      }
    }
  }

  // 2. Narrative Arc Validation
  // Intro slides should be early, conclusion slides should be late
  slides.forEach((slide, idx) => {
    const title = slide.layoutPlan?.title?.toLowerCase() || '';
    const purpose = (slide.purpose || (slide as any).meta?.purpose || '').toLowerCase();

    const isIntro = title.includes('intro') || title.includes('overview') ||
                    purpose.includes('intro') || purpose.includes('hook');
    const isConclusion = title.includes('conclusion') || title.includes('summary') ||
                         title.includes('takeaway') || purpose.includes('conclusion');

    // Intro after slide 2 is suspicious
    if (isIntro && idx > 2 && slides.length > 4) {
      score -= 10;
      issues.push({
        type: 'arc_violation',
        slideIndices: [idx],
        message: `Introduction slide at position ${idx + 1} (expected in first 3 slides)`,
        severity: 'major'
      });
    }

    // Conclusion before last 2 slides is suspicious
    if (isConclusion && idx < slides.length - 2 && slides.length > 4) {
      score -= 10;
      issues.push({
        type: 'arc_violation',
        slideIndices: [idx],
        message: `Conclusion slide at position ${idx + 1} (expected in last 2 slides)`,
        severity: 'major'
      });
    }
  });

  // 3. Thematic Drift Detection
  // Check if middle slides diverge significantly from opening theme
  if (slides.length >= 5) {
    const firstSlideText = extractSlideText(slides[0]);
    const middleIndex = Math.floor(slides.length / 2);
    const middleSlideText = extractSlideText(slides[middleIndex]);

    const thematicAlignment = jaccardSimilarity(firstSlideText, middleSlideText);

    // Some divergence is expected (0.1-0.3 is healthy), but < 0.05 suggests drift
    if (thematicAlignment < 0.05 && firstSlideText.length > 100 && middleSlideText.length > 100) {
      score -= 15;
      issues.push({
        type: 'thematic_drift',
        slideIndices: [0, middleIndex],
        message: `Slide ${middleIndex + 1} has minimal thematic connection to opening slide (${Math.round(thematicAlignment * 100)}% overlap)`,
        severity: 'major'
      });
    }
  }

  return {
    coherenceScore: Math.max(0, score),
    issues,
    passed: score >= 70 // 70+ is acceptable coherence
  };
}
