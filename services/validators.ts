

import { SlideNode, ValidationResult, RenderModeSchema } from "../types/slideTypes";

// --- DELIGHT QA VALIDATOR ---
// A deterministic scoring engine that rejects low-quality output.

export const validateSlide = (slide: SlideNode): ValidationResult => {
  const errors: { code: string; message: string; suggestedFix?: string }[] = [];
  let score = 100;
  let isCriticalFailure = false;

  const components = slide.layoutPlan?.components || [];
  const routerConfig = slide.routerConfig;

  // 1. FATAL: Missing Content
  if (!components || components.length === 0) {
    return {
      passed: false,
      score: 0,
      errors: [{ code: "ERR_EMPTY_SLIDE", message: "No components generated.", suggestedFix: "Regenerate with lower temperature." }]
    };
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
    } catch (e) {
        // Ignore malformed components in text count
    }
    return acc + text.length;
  }, 0);

  const maxChars = routerConfig?.densityBudget.maxChars || 600; 
  if (totalText > maxChars) {
    score -= 20; 
    if (totalText > maxChars * 2) {
        isCriticalFailure = true;
        errors.push({
            code: "ERR_TEXT_OVERFLOW_CRITICAL",
            message: `Text length ${totalText} is double the budget ${maxChars}.`,
            suggestedFix: "Summarize text drastically."
        });
    } else {
        errors.push({
            code: "WARN_TEXT_OVERFLOW",
            message: `Text length ${totalText} exceeds budget ${maxChars}.`,
            suggestedFix: "Consider summarizing."
        });
    }
  }

  // 3. CHECK: Visual Density (Missing Icons)
  // Logic Updated: Only mark as critical if the component type STRONGLY implies visuals.
  let iconCount = 0;
  let requiresIcons = false;

  components.forEach(c => {
    try {
        if (c.type === 'metric-cards') {
            requiresIcons = true;
            iconCount += (c.metrics || []).filter(m => !!m.icon).length;
        }
        if (c.type === 'process-flow') {
            // Steps usually have numbers, icons optional but nice
            iconCount += (c.steps || []).filter(s => !!s.icon).length;
        }
        if (c.type === 'icon-grid') {
            requiresIcons = true;
            iconCount += (c.items || []).filter(i => !!i.icon).length;
        }
    } catch (e) {}
  });

  const minVisuals = routerConfig?.densityBudget.minVisuals || 0;
  
  // If specific components exist that NEED icons, we fail if 0 are found.
  // Note: autoRepairSlide typically fixes this before we get here.
  if (requiresIcons && iconCount === 0) {
      score -= 30;
      isCriticalFailure = true;
      errors.push({
          code: "ERR_MISSING_VISUALS_CRITICAL",
          message: "Visual component (cards/grid) has 0 icons.",
          suggestedFix: "Inject standard icons into item objects."
      });
  } else if (iconCount < minVisuals) {
    score -= 15;
    errors.push({
      code: "WARN_MISSING_VISUALS",
      message: `Found ${iconCount} icons, required ${minVisuals}.`,
      suggestedFix: "Add 'icon' property to metrics, steps, or grid items."
    });
  }

  // 4. CHECK: Mode Compliance (Data-Viz & Charts)
  if (routerConfig?.renderMode === 'data-viz' || slide.type === 'data-viz') {
     const hasChartFrame = components.some(c => c.type === 'chart-frame');
     const hasChartSpec = !!slide.chartSpec;
     
     if (!hasChartFrame && !hasChartSpec) {
       score -= 30;
       isCriticalFailure = true; // Critical for data slides
       errors.push({
         code: "ERR_MODE_MISMATCH",
         message: "Data-Viz mode requires a Chart component or Chart Spec.",
         suggestedFix: "Change component type to 'chart-frame' or add valid chartSpec."
       });
     }
  }

  // 5. CHECK: Citations (The Contract)
  // If slide has claims, it should ideally have citations.
  if (components.length > 0 && (!slide.citations || slide.citations.length === 0)) {
       // Not critical, but a warning for professional slides
       errors.push({
           code: "WARN_NO_CITATIONS",
           message: "Slide contains content but no citations found.",
           suggestedFix: "Ensure factual claims map to source IDs."
       });
  }

  // 6. CHECK: Component Structure Integrity (Critical)
  components.forEach(c => {
      if (c.type === 'process-flow' && (!c.steps || !Array.isArray(c.steps))) {
           isCriticalFailure = true;
           errors.push({ code: "ERR_MALFORMED_COMPONENT", message: "Process flow missing steps array." });
      }
      if (c.type === 'metric-cards' && (!c.metrics || !Array.isArray(c.metrics))) {
           isCriticalFailure = true;
           errors.push({ code: "ERR_MALFORMED_COMPONENT", message: "Metric cards missing metrics array." });
      }
      if (c.type === 'text-bullets' && (!c.content || !Array.isArray(c.content))) {
           isCriticalFailure = true;
           errors.push({ code: "ERR_MALFORMED_COMPONENT", message: "Text bullets missing content array." });
      }
  });

  // 7. CHECK: Repetition / Loops (Anti-Hallucination)
  const contentString = JSON.stringify(components).toLowerCase();
  
  // A. Immediate Word Repetition (e.g., "secure secure secure")
  const wordRepetitionRegex = /\b([a-z]{3,})(?:[\s\W]+\1){3,}\b/g;
  const wordMatch = contentString.match(wordRepetitionRegex);
  
  if (wordMatch) {
      score -= 50;
      isCriticalFailure = true;
      errors.push({
          code: "ERR_REPETITION_DETECTED",
          message: `Detected repetitive loop: "${wordMatch[0].substring(0, 20)}..."`,
          suggestedFix: "Rewrite content to remove repeated words."
      });
  }

  // B. Duplicate List Items
  components.forEach(c => {
      let items: string[] = [];

      if (c.type === 'text-bullets') {
          items = c.content || [];
      } else if (c.type === 'process-flow') {
          items = c.steps?.map(s => s.description || "") || [];
      } else if (c.type === 'metric-cards') {
          items = c.metrics?.map(m => m.label || "") || [];
      } else if (c.type === 'icon-grid') {
          items = c.items?.map(i => i.label || "") || [];
      } else if (c.type === 'chart-frame') {
          items = c.data?.map(d => d.label || "") || [];
      }

      const uniqueItems = new Set(items.map(i => typeof i === 'string' ? i.trim().toLowerCase() : ""));
      if (items.length > uniqueItems.size) {
           score -= 20;
           // If it's mostly duplicates, it's critical
           if (uniqueItems.size < items.length / 2) {
               isCriticalFailure = true;
               errors.push({ code: "ERR_REPETITION_DETECTED", message: "Component contains identical items.", suggestedFix: "Ensure list items are unique." });
           } else {
               errors.push({ code: "WARN_DUPLICATE_ITEMS", message: "Some list items are duplicates.", suggestedFix: "Deduplicate list items." });
           }
      }
  });

  return {
    passed: !isCriticalFailure,
    score,
    errors
  };
};
