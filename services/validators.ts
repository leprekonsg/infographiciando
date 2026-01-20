
import { SlideNode, ValidationResult, RenderModeSchema, VisualDesignSpec, RouterDecision, SlideLayoutPlanSchema, VisualCritiqueReportSchema, VisualCritiqueReport } from "../types/slideTypes";

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
  // If YIQ >= 128, it's light (needs dark text). If < 128, it's dark (needs light text).
  // Assuming white text overlay, we need dark background (< 180 safe margin for readability)
  return yiq < 180;
};

export const validateVisualLayoutAlignment = (
  visualDesign: VisualDesignSpec,
  routerConfig: RouterDecision,
  layoutPlan?: any
): ValidationResult => {
  const errors: any[] = [];
  let score = 100;

  // 1. Check spatial strategy matches layout variant
  const validLayoutVariants = ['standard-vertical', 'split-left-text', 'split-right-text', 'hero-centered', 'bento-grid', 'timeline-horizontal'];
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

  // Validate negative space is in optimal range (10-50%)
  if (negativeSpacePct < 10) {
    score -= 10;
    errors.push({
      code: 'POOR_NEGATIVE_SPACE',
      message: `Negative space allocation (${negativeSpacePct}%) is too low for professional design`,
      suggestedFix: 'Increase negative space to at least 15%'
    });
  } else if (negativeSpacePct > 50) {
    score -= 5;
    errors.push({
      code: 'EXCESSIVE_NEGATIVE_SPACE',
      message: `Negative space allocation (${negativeSpacePct}%) is unusually high`,
      suggestedFix: 'Reduce negative space to 35% or less for better content density'
    });
  }

  // 3. Check color contrast with background
  if (routerConfig.densityBudget.maxChars > 500) {
    // Heavy text load needs good contrast
    if (visualDesign.color_harmony?.background_tone && !hasGoodContrast(visualDesign.color_harmony.background_tone)) {
      score -= 20;
      errors.push({
        code: 'POOR_TEXT_CONTRAST',
        message: 'Background color won\'t provide sufficient contrast for text overlay',
        suggestedFix: 'Use darker/lighter background treatment'
      });
    }
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
  const SUPPORTED_TYPES = ['text-bullets', 'metric-cards', 'process-flow', 'icon-grid', 'chart-frame'];
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

  // 1.6. CHECK: Layout Compatibility
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
    } catch (e) { }
    return acc + text.length;
  }, 0);

  const maxChars = routerConfig?.densityBudget.maxChars || 600;
  if (totalText > maxChars) {
    score -= 20;
    if (totalText > maxChars * 2) {
      isCriticalFailure = true;
      errors.push({ code: "ERR_TEXT_OVERFLOW_CRITICAL", message: `Text length ${totalText} is double the budget.`, suggestedFix: "Summarize." });
    } else {
      errors.push({ code: "WARN_TEXT_OVERFLOW", message: `Text length ${totalText} exceeds budget.`, suggestedFix: "Summarize." });
    }
  }

  // 3. CHECK: Visual Density
  let iconCount = 0;
  let requiresIcons = false;
  components.forEach(c => {
    try {
      if (c.type === 'metric-cards') { requiresIcons = true; iconCount += (c.metrics || []).filter(m => !!m.icon).length; }
      if (c.type === 'icon-grid') { requiresIcons = true; iconCount += (c.items || []).filter(i => !!i.icon).length; }
    } catch (e) { }
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

/**
 * Validates API response for visual critique against Zod schema.
 * Returns validated VisualCritiqueReport or null on failure.
 */
export function validateCritiqueResponse(raw: any): VisualCritiqueReport | null {
  const result = VisualCritiqueReportSchema.safeParse(raw);
  if (!result.success) {
    console.error('[VALIDATOR] Critique response invalid:', result.error.format());
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
    console.error('[VALIDATOR] Repair response invalid:', result.error.format());
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
      const hasRequired = expectations.requiredTypes.some(type => componentTypes.includes(type));
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

  const densityBudget = routerConfig.densityBudget;
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
    const purpose = slide.meta?.purpose?.toLowerCase() || '';

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
