
import { SlideNode, ValidationResult, RenderModeSchema, VisualDesignSpec, RouterDecision, SlideLayoutPlanSchema } from "../types/slideTypes";

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
