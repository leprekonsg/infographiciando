

import { SlideNode, RouterDecision, VisualDesignSpec, VisualDesignSpecSchema, ResearchFact } from "../types/slideTypes";
import { PROMPTS } from "./promptRegistry";
import { callAI, TokenTracker } from "./geminiService";
import { validateVisualLayoutAlignment } from "./validators";
import { SpatialLayoutEngine } from "./spatialRenderer";
import { Type } from "@google/genai";

const MODEL_SMART = "gemini-3-pro-preview";

// Helper to determine component types for the prompt before they exist
function estimateComponentTypes(routerConfig: RouterDecision, contentPlan: any): string[] {
    if (routerConfig.renderMode === 'data-viz') return ['chart-frame'];
    if (routerConfig.layoutVariant === 'bento-grid') return ['metric-cards', 'icon-grid'];
    if (routerConfig.layoutVariant === 'timeline-horizontal') return ['process-flow'];
    if (contentPlan.dataPoints && contentPlan.dataPoints.length > 0) return ['metric-cards'];
    return ['text-bullets'];
}

export const runVisualDesigner = async (
  slideTitle: string,
  contentPlan: any, // Phase 1 Content Plan
  routerConfig: RouterDecision,
  facts: ResearchFact[],
  tracker: TokenTracker
): Promise<VisualDesignSpec> => {
  const MAX_ATTEMPTS = 2;
  const layoutEngine = new SpatialLayoutEngine();
  
  // STEP 1: Analyze spatial requirements
  // We use the layout engine to get the "Ideal" zones for this variant
  const zones = layoutEngine.getZonesForVariant(routerConfig.layoutVariant);
  const spatialStrategy = {
      zones,
      compositional_hierarchy: "Derived from layout template",
      negative_space_plan: "Standard",
      visual_weight_distribution: "Balanced"
  };

  const componentTypes = estimateComponentTypes(routerConfig, contentPlan);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
          const visualPrompt = await callAI(
            MODEL_SMART,
            PROMPTS.VISUAL_COMPOSER.TASK({
              title: slideTitle,
              visualFocus: routerConfig.visualFocus,
              layoutVariant: routerConfig.layoutVariant,
              spatialStrategy: spatialStrategy, 
              componentTypes: componentTypes,
              densityContext: routerConfig.densityBudget,
              styleGuide: "Modern Professional" // TODO: Pass real style guide
            }),
            {
              mode: 'json',
              schema: {
                  type: Type.OBJECT,
                  properties: {
                      spatial_strategy: { 
                          type: Type.OBJECT, 
                          properties: { 
                              zones: {
                                  type: Type.ARRAY,
                                  items: {
                                      type: Type.OBJECT,
                                      properties: {
                                          id: { type: Type.STRING },
                                          purpose: { type: Type.STRING },
                                          x: { type: Type.NUMBER },
                                          y: { type: Type.NUMBER },
                                          w: { type: Type.NUMBER },
                                          h: { type: Type.NUMBER },
                                          content_suggestion: { type: Type.STRING }
                                      },
                                      required: ["id", "purpose", "x", "y", "w", "h"]
                                  }
                              }, 
                              compositional_hierarchy:{type: Type.STRING}, 
                              negative_space_plan:{type: Type.STRING}, 
                              visual_weight_distribution:{type: Type.STRING} 
                          } 
                      },
                      prompt_with_composition: { type: Type.STRING },
                      foreground_elements: { type: Type.ARRAY, items: { type: Type.STRING } },
                      background_treatment: { type: Type.STRING },
                      negative_space_allocation: { type: Type.STRING },
                      color_harmony: { type: Type.OBJECT, properties: { primary: {type: Type.STRING}, accent: {type: Type.STRING}, background_tone: {type: Type.STRING} } }
                  },
                  required: ["spatial_strategy", "prompt_with_composition", "background_treatment", "color_harmony"]
              }
            },
            tracker
          );
          
          // STEP 3: Validate visual alignment with layout
          const alignment = validateVisualLayoutAlignment(
            visualPrompt,
            routerConfig
          );
          
          if (alignment.passed || attempt === MAX_ATTEMPTS) {
              return visualPrompt as VisualDesignSpec;
          }
          
          // If failed, loop with feedback? (Simplified: just retry once or accept)
          console.warn(`[VISUAL DESIGNER] Validation warning: ${alignment.errors.map(e => e.message).join(', ')}`);
          
      } catch (e) {
          console.error("[VISUAL DESIGNER] Failed", e);
      }
  }

  // Fallback
  return {
      spatial_strategy: spatialStrategy as any,
      prompt_with_composition: `${slideTitle} professional presentation background, abstract, high quality`,
      background_treatment: "Solid",
      negative_space_allocation: "20%",
      color_harmony: { primary: "#10b981", accent: "#f59e0b", background_tone: "#0f172a" }
  };
};
