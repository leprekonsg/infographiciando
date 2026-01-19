
import { z } from "zod";

export const SLIDE_TYPES = {
  TITLE: 'title-slide',
  SECTION: 'section-header',
  CONTENT: 'content-main',
  DATA: 'data-viz',
  CONCLUSION: 'conclusion'
} as const;

// --- RLM & ROUTING SCHEMAS ---

export const RenderModeSchema = z.enum([
  'statement',      // Big text, low density, high impact
  'infographic',    // Structured lists, steps, grids
  'data-viz',       // Chart heavy
  'standard',       // Classic Title + Bullets (fallback)
]);

export const LayoutVariantSchema = z.enum([
  'standard-vertical', // Classic top-down
  'split-left-text',   // Text Left, Visual Right
  'split-right-text',  // Visual Left, Text Right
  'hero-centered',     // Big impact text center
  'bento-grid',        // Boxed layout
  'timeline-horizontal' // Left to right flow
]);

export const DensityBudgetSchema = z.object({
  maxChars: z.number(),
  maxItems: z.number(),
  minVisuals: z.number(),
  forbiddenPatterns: z.array(z.string()).optional()
});

export const RouterDecisionSchema = z.object({
  renderMode: RenderModeSchema,
  layoutVariant: LayoutVariantSchema,
  layoutIntent: z.string().describe("Specific layout direction (e.g. 'Split screen with flowchart')"),
  densityBudget: DensityBudgetSchema,
  visualFocus: z.string().describe("What is the primary visual hook?")
});

export const ValidationResultSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  errors: z.array(z.object({
    code: z.string(),
    message: z.string(),
    suggestedFix: z.string().optional()
  }))
});

// --- VISUAL & SPATIAL SCHEMAS (NEW) ---

export const SpatialZoneSchema = z.object({
  id: z.string(),
  purpose: z.enum(['hero', 'secondary', 'accent', 'negative-space']),
  x: z.number(), y: z.number(), w: z.number(), h: z.number(),
  content_suggestion: z.string().optional()
});

export const SpatialStrategySchema = z.object({
  zones: z.array(SpatialZoneSchema),
  compositional_hierarchy: z.string(),
  negative_space_plan: z.string(),
  visual_weight_distribution: z.string()
});

export const VisualDesignSpecSchema = z.object({
  spatial_strategy: SpatialStrategySchema,
  prompt_with_composition: z.string(),
  foreground_elements: z.array(z.string()).optional(),
  background_treatment: z.string(),
  negative_space_allocation: z.string(),
  color_harmony: z.object({
    primary: z.string(),
    accent: z.string(),
    background_tone: z.string()
  })
});

// --- CORE DATA SCHEMAS ---

// 1. CITATION SCHEMA (The Contract)
export const CitationSchema = z.object({
  id: z.string(),
  claim: z.string(),
  source: z.string().optional(),
  factId: z.string().optional() // Link back to the FactCluster ID
});

export const ResearchFactSchema = z.object({
  id: z.string(),
  category: z.string(),
  claim: z.string(),
  value: z.string().optional(),
  source: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low'])
});

export const FactClusterSchema = z.object({
  id: z.string(),
  theme: z.string(),
  factIds: z.array(z.string())
});

export const KnowledgeSheetSchema = z.array(ResearchFactSchema);

// 2. DATA VIZ SCHEMA (Visual Contract)
export const ChartSpecSchema = z.object({
  type: z.enum(['bar', 'line', 'pie', 'stat-big', 'doughnut']),
  title: z.string().optional(),
  data: z.array(z.object({
    label: z.string(),
    value: z.number(),
    color: z.string().optional()
  })),
  summary: z.string().optional(),
  yAxisLabel: z.string().optional()
});

export const TemplateComponentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('title-section'),
    title: z.string().max(100),
    subtitle: z.string().optional(),
  }),
  z.object({
    type: z.literal('metric-cards'),
    intro: z.string().optional(),
    metrics: z.array(z.object({
      value: z.string(),
      label: z.string().max(40),
      icon: z.string().optional(), 
      trend: z.enum(['up', 'down', 'neutral']).optional(),
    })).min(2).max(6),
  }),
  z.object({
    type: z.literal('process-flow'),
    intro: z.string().optional(),
    steps: z.array(z.object({
      number: z.number(),
      title: z.string().max(30),
      description: z.string().max(80),
      icon: z.string().optional(),
    })).min(3).max(5),
  }),
  z.object({
    type: z.literal('icon-grid'),
    cols: z.number().min(2).max(4),
    intro: z.string().optional(),
    items: z.array(z.object({
      label: z.string().max(40),
      icon: z.string(),
      description: z.string().optional()
    })).min(3).max(8),
  }),
  z.object({
    type: z.literal('text-bullets'),
    title: z.string().optional(),
    content: z.array(z.string()).min(1).max(6),
    style: z.enum(['standard', 'highlight', 'quote']).optional()
  }),
  z.object({
    type: z.literal('chart-frame'),
    title: z.string().max(80),
    chartType: z.enum(['bar', 'pie', 'line', 'doughnut']),
    data: z.array(z.object({
      label: z.string(),
      value: z.number(),
    })),
  }),
]);

export type TemplateComponent = z.infer<typeof TemplateComponentSchema>;

export const SlideLayoutPlanSchema = z.object({
  title: z.string().max(100),
  components: z.array(TemplateComponentSchema).min(1).max(3),
  background: z.enum(['solid', 'gradient', 'image']).default('solid'),
});

// --- AGENT LAYOUT SCHEMAS ---

export const AgentLayoutSchema = z.object({
  shapes: z.array(z.any()), // Simplified for brevity in this specific update
  textPlacements: z.array(z.any()),
  designIntent: z.string().optional(),
});

export const StyleGuideSchema = z.object({
  themeName: z.string(),
  fontFamilyTitle: z.string(),
  fontFamilyBody: z.string(),
  colorPalette: z.object({
    primary: z.string(), secondary: z.string(), background: z.string(), text: z.string(), accentHighContrast: z.string()
  }),
  imageStyle: z.string(),
  layoutStrategy: z.string(),
});

// 3. SLIDE NODE (Recursive Refinement)
export const SelfCritiqueSchema = z.object({
  readabilityScore: z.number().min(0).max(10),
  textDensityStatus: z.enum(['optimal', 'high', 'overflow']),
  layoutAction: z.enum(['keep', 'simplify', 'shrink_text', 'add_visuals'])
});

export const SlideNodeSchema = z.object({
  order: z.number(),
  type: z.nativeEnum(SLIDE_TYPES),
  title: z.string(),
  purpose: z.string(),
  
  // RLM Fields
  routerConfig: RouterDecisionSchema.optional(),
  validation: ValidationResultSchema.optional(),

  layoutPlan: SlideLayoutPlanSchema.optional(),
  visualDesignSpec: VisualDesignSpecSchema.optional(), // New: Detailed visual spec
  agentLayout: AgentLayoutSchema.optional(), // Legacy/Advanced
  
  // Content & Evidence
  content: z.array(z.string()).optional(), // Legacy compat
  citations: z.array(CitationSchema).optional(),
  
  // SCHEMA HARDENING: Use array of strings to prevent newline breakage in JSON
  speakerNotesLines: z.array(z.string()),

  // Specialized Payloads
  chartSpec: ChartSpecSchema.optional(),

  // Visuals (Critique 1: Stop fighting yourself)
  visualReasoning: z.string(),
  visualPrompt: z.string(), 
  backgroundImageUrl: z.string().optional(), 
  
  // Optimization Loop (Critique 2: Programmatic optimization)
  selfCritique: SelfCritiqueSchema.optional(),

  readabilityCheck: z.enum(['pass', 'warning', 'fail']),
  warnings: z.array(z.string()).optional()
});

// 4. THE ENVIRONMENT (Critique 2: Context as Environment)
export const OutlineSchema = z.object({
  narrativeGoal: z.string(),
  title: z.string(),
  knowledgeSheet: KnowledgeSheetSchema,
  factClusters: z.array(FactClusterSchema).optional(), // The Librarian's Index
  styleGuide: StyleGuideSchema, 
  slides: z.array(z.object({
    order: z.number(),
    type: z.nativeEnum(SLIDE_TYPES),
    title: z.string(),
    purpose: z.string(),
    relevantFactIds: z.array(z.string()).optional(), // Legacy
    relevantClusterIds: z.array(z.string()).optional() // RLM
  })).min(4).max(12)
});

export type SlideNode = z.infer<typeof SlideNodeSchema>;
export type EditableSlideDeck = {
  id: string;
  topic: string;
  meta: z.infer<typeof OutlineSchema>;
  slides: SlideNode[];
  metrics: {
    totalDurationMs: number;
    retries: number;
    totalCost?: number;
    avgQualityScore?: number;
  };
};
export type GlobalStyleGuide = z.infer<typeof StyleGuideSchema>;
export type RouterDecision = z.infer<typeof RouterDecisionSchema>;
export type LayoutVariant = z.infer<typeof LayoutVariantSchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type ResearchFact = z.infer<typeof ResearchFactSchema>;
export type AgentLayout = z.infer<typeof AgentLayoutSchema>;
export type FactCluster = z.infer<typeof FactClusterSchema>;
export type VisualDesignSpec = z.infer<typeof VisualDesignSpecSchema>;
export type SpatialZone = z.infer<typeof SpatialZoneSchema>;
export type SpatialStrategy = z.infer<typeof SpatialStrategySchema>;

export type VisualElement = 
  | {
      type: 'shape';
      shapeType: string;
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: { color: string; alpha: number };
      border?: { color: string; width: number; alpha: number };
      text?: string;
      textColor?: string;
      rotation?: number;
      zIndex?: number;
      rectRadius?: number;
    }
  | {
      type: 'text';
      content: string;
      x: number;
      y: number;
      w: number;
      h: number;
      fontSize: number;
      color: string;
      fontFamily?: string;
      bold?: boolean;
      italic?: boolean;
      align?: "left" | "center" | "right";
      rotation?: number;
      zIndex?: number;
    }
  | {
      type: 'image';
      data: string;
      x: number;
      y: number;
      w: number;
      h: number;
      zIndex?: number;
      transparency?: number;
  };
