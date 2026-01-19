

import { SlideNode, ValidationResult, RenderModeSchema, VisualDesignSpec, RouterDecision, SlideLayoutPlanSchema } from "../types/slideTypes";

// Helper for contrast check (very basic hex check)
const hasGoodContrast = (hex: string): boolean => {
    // Convert hex to RGB
    const r = parseInt(hex.substring(1, 3), 16);
    const g = parseInt(hex.substring(3, 5), 16);
    const b = parseInt(hex.substring(5, 7), 16);
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
  
  // 2. Check negative space allocation
  const negativeSpacePct = parseFloat(visualDesign.negative_space_allocation?.match(/\d+/)?.[0] || '0');
  if (negativeSpacePct < 10 || negativeSpacePct > 60) {
    // score -= 15; // Soften this rule as LLM parsing of % can be flaky
    // errors.push({
    //   code: 'POOR_NEGATIVE_SPACE',
    //   message: `Negative space allocation (${negativeSpacePct}%) outside optimal range`,
    //   suggestedFix: 'Adjust composition to include breathing room'
    // });
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
  
  // 4. Ensure visual zones don't compete with text zones
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
  const SUPPORTED_TYPES = ['text-bullets', 'metric-cards', 'process-flow', 'icon-grid', 'chart-frame'];
  components.forEach((c, idx) => {
      if (!SUPPORTED_TYPES.includes(c.type)) {
          isCriticalFailure = true;
          score -= 40;
          errors.push({ 
              code: "ERR_UNSUPPORTED_COMPONENT", 
              message: `Component type '${c.type}' is not supported by the renderer.`, 
              suggestedFix: "Change to 'text-bullets' or 'metric-cards'." 
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
    } catch (e) {}
  });

  if (requiresIcons && iconCount === 0) {
      score -= 30;
      isCriticalFailure = true;
      errors.push({ code: "ERR_MISSING_VISUALS_CRITICAL", message: "Visual component has 0 icons.", suggestedFix: "Inject icons." });
  }

  // 4. CHECK: Mode Compliance
  if (routerConfig?.renderMode === 'data-viz' || slide.type === 'data-viz') {
     const hasChartFrame = components.some(c => c.type === 'chart-frame');
     const hasChartSpec = !!slide.chartSpec;
     if (!hasChartFrame && !hasChartSpec) {
       score -= 30;
       isCriticalFailure = true;
       errors.push({ code: "ERR_MODE_MISMATCH", message: "Data-Viz mode requires a Chart.", suggestedFix: "Add chart." });
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
