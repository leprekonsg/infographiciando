
import { z } from "zod";
import { CompositionPlanSchema } from "./serendipityTypes";

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
  'timeline-horizontal', // Left to right flow
  'dashboard-tiles',   // Title + metric row + split panels
  'metrics-rail',      // Left rail metrics + right content
  'asymmetric-grid'    // Large panel + stacked side panels
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

// --- VISUAL CRITIQUE SCHEMAS (System 2) ---

export const CritiqueSeveritySchema = z.enum(['critical', 'major', 'minor']);

export const CritiqueCategorySchema = z.enum([
  'overlap',      // Components overlap in spatial space
  'contrast',     // Text/background contrast issues
  'alignment',    // Elements not aligned to grid
  'hierarchy',    // Visual weight doesn't match importance
  'density'       // Too many/few elements in zone
]);

export const CritiqueIssueSchema = z.object({
  severity: CritiqueSeveritySchema,
  category: CritiqueCategorySchema,
  zone: z.string().optional(),
  description: z.string().max(200),
  suggestedFix: z.string().max(200)
});

export const VisualCritiqueReportSchema = z.object({
  issues: z.array(CritiqueIssueSchema).max(10),
  overallScore: z.number().min(0).max(100),
  hasCriticalIssues: z.boolean()
});

export type CritiqueSeverity = z.infer<typeof CritiqueSeveritySchema>;
export type CritiqueCategory = z.infer<typeof CritiqueCategorySchema>;
export type CritiqueIssue = z.infer<typeof CritiqueIssueSchema>;
export type VisualCritiqueReport = z.infer<typeof VisualCritiqueReportSchema>;

// System 2 Visual Critique Thresholds
export const VISUAL_THRESHOLDS = {
  EXCELLENT: 95,        // No critique needed
  TARGET: 85,           // Critique activation point
  REPAIR_REQUIRED: 70,  // Force repair attempt
  CRITICAL: 60,         // Aggressive repair
  FALLBACK: 50          // Give up
} as const;

export type VisualThreshold = typeof VISUAL_THRESHOLDS[keyof typeof VISUAL_THRESHOLDS];

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

export const SlideStyleDNASchema = z.object({
  motifs: z.array(z.string()).min(1).max(3),
  texture: z.enum(['mesh', 'circuit', 'soft-bands', 'bokeh', 'minimal-lines', 'gradient-ribbons', 'abstract-geo']).optional(),
  gridRhythm: z.enum(['tight', 'balanced', 'airy']).optional(),
  accentRule: z.enum(['single', 'dual', 'highlight']).optional(),
  cardStyle: z.enum(['glass', 'outline', 'solid']).optional(),
  surpriseBudget: z.number().min(1).max(3).optional(), // Max "wow" moments per deck
  surpriseCues: z.array(z.string()).optional() // Short phrases for tasteful novelty
});

// --- AGENT DATA CONTRACT SCHEMAS ---

/**
 * Content Plan Schema - The contract between Content Planner and downstream agents
 * This is the canonical shape that generators, visual designers, and layout selectors depend on.
 * 
 * CRITICAL: All consumers of content plan data MUST validate against this schema
 * or use ensureValidContentPlan() from slideAgentService.ts
 */
export const ContentPlanSchema = z.object({
  title: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).min(1).max(10),
  dataPoints: z.array(z.object({
    label: z.string().min(1).max(40),
    value: z.union([z.number(), z.string()])
  })).default([]),
  narrative: z.string().optional(),
  chartSpec: z.object({
    type: z.enum(['bar', 'line', 'pie', 'doughnut', 'stat-big']),
    title: z.string().optional(),
    data: z.array(z.object({
      label: z.string(),
      value: z.number(),
      color: z.string().optional()
    }))
  }).optional()
});

export type ContentPlan = z.infer<typeof ContentPlanSchema>;

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
  z.object({
    type: z.literal('diagram-svg'),
    title: z.string().max(60).optional(),
    diagramType: z.literal('circular-ecosystem'),
    elements: z.array(z.object({
      id: z.string(),
      label: z.string().max(30),
      icon: z.string().optional()
    })).min(3).max(8),
    centralTheme: z.string().max(40).optional()
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
  styleDNA: SlideStyleDNASchema.optional(),
  themeTokens: z.object({
    typography: z.object({
      scale: z.object({
        hero: z.number().optional(),
        title: z.number().optional(),
        subtitle: z.number().optional(),
        body: z.number().optional(),
        label: z.number().optional(),
        metric: z.number().optional(),
        micro: z.number().optional()
      }).optional(),
      weights: z.object({
        hero: z.number().optional(),
        title: z.number().optional(),
        subtitle: z.number().optional(),
        body: z.number().optional(),
        label: z.number().optional(),
        metric: z.number().optional()
      }).optional(),
      lineHeights: z.object({
        title: z.number().optional(),
        body: z.number().optional()
      }).optional(),
      letterSpacing: z.object({
        title: z.number().optional(),
        body: z.number().optional()
      }).optional()
    }).optional(),
    spacing: z.object({
      xs: z.number().optional(),
      sm: z.number().optional(),
      md: z.number().optional(),
      lg: z.number().optional()
    }).optional(),
    radii: z.object({
      card: z.number().optional(),
      pill: z.number().optional()
    }).optional(),
    surfaces: z.object({
      cardStyle: z.enum(['solid', 'outline', 'glass']).optional(),
      borderWidth: z.number().optional(),
      opacity: z.number().optional()
    }).optional(),
    background: z.object({
      style: z.enum(['solid', 'gradient', 'mesh', 'textured']).optional(),
      gradientStops: z.array(z.string()).optional()
    }).optional()
  }).optional()
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
  compositionPlan: CompositionPlanSchema.optional(), // Serendipity: Layer-based composition
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
  warnings: z.array(z.string()).optional(),

  // Environment State Snapshot (for context propagation)
  environmentSnapshot: z.object({
    elements: z.array(z.any()),
    zones: z.array(z.any())
  }).optional()
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

// --- LEVEL 3 AGENTIC STACK TYPES ---

/**
 * NarrativeTrail: Context Folding for orchestrator-level memory.
 * Allows Generator to know narrative arc without verbose fact re-injection.
 * Enhanced with design decisions and visual themes for better coherence.
 */
export interface NarrativeTrail {
  title: string;
  mainPoint: string; // First 100 chars of speaker notes
  // Enhanced fields for better context
  layoutVariant?: string; // Layout used (e.g., 'split-left-text')
  renderMode?: string; // Render mode (e.g., 'infographic')
  componentTypes?: string[]; // Component types used (e.g., ['text-bullets', 'metric-cards'])
  visualTheme?: string; // Visual design theme or color harmony
  designDecisions?: string; // Key design choices made
}

/**
 * RouterConstraints: Allows circuit breaker to avoid failed layouts.
 */
export interface RouterConstraints {
  avoidLayoutVariants?: string[];
  minTextHeight?: number;
  textDensityTarget?: number;
  allowDynamicScaling?: boolean;
}

/**
 * GeneratorResult: Extended return type for circuit breaker pattern.
 * If needsReroute is true, orchestrator should re-run pipeline with new constraints.
 */
export enum GeneratorFailureReason {
  LowFitScore = 'low_fit_score',
  QwenQaFailed = 'qwen_qa_failed',
  CriticalValidation = 'critical_validation',
  VisualFocusMissing = 'visual_focus_missing',
  ModelDegeneration = 'model_degeneration',
  Unknown = 'unknown'
}

export interface GeneratorResult {
  slide: SlideNode;
  needsReroute: boolean;
  rerouteReason?: string;
  rerouteReasonType?: GeneratorFailureReason;
  avoidLayoutVariants?: string[];
  // System 2 tracking
  visualCritiqueRan?: boolean;
  visualRepairAttempted?: boolean;
  visualRepairSucceeded?: boolean;
  // System 2 cost breakdown
  system2Cost?: number;
  system2InputTokens?: number;
  system2OutputTokens?: number;
}

/**
 * DeckMetrics: Enhanced metrics for reliability tracking.
 * Target: 95% decks ≤1 fallback slide, 80% visual designs pass 1st attempt.
 */
export interface DeckMetrics {
  totalDurationMs: number;
  retries: number;
  totalCost?: number;
  avgQualityScore?: number;
  // Level 3 Reliability Tracking
  fallbackSlides: number;
  visualAlignmentFirstPassSuccess: number;
  totalVisualDesignAttempts: number;
  rerouteCount: number;
  // System 2 Visual Critique Tracking
  visualCritiqueAttempts: number;
  visualRepairSuccess: number;
  // System 2 Cost Breakdown
  system2Cost?: number;
  system2TokensInput?: number;
  system2TokensOutput?: number;
  // GAP 2: Deck-Wide Narrative Coherence
  coherenceScore?: number;
  coherenceIssues?: number;
  // Visual Architect Metrics
  visualArchitectMetrics?: VisualArchitectMetrics;
}

export type EditableSlideDeck = {
  id: string;
  topic: string;
  meta: z.infer<typeof OutlineSchema>;
  slides: SlideNode[];
  metrics: DeckMetrics;
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
export type SlideStyleDNA = z.infer<typeof SlideStyleDNASchema>;

// --- ENVIRONMENT STATE (Shadow State Pattern for Agent Visibility) ---

/**
 * EnvironmentState: Lightweight JSON snapshot of spatial layout health.
 * This is the "shadow state" that allows agents to see spatial issues and
 * make informed decisions about rerouting or accepting a layout.
 *
 * Implements the "Context-as-Environment" pattern from the Level 3 architecture.
 */
export interface EnvironmentState {
  slideId: string;

  // Layout health metrics (0-1 normalized scores)
  fit_score: number; // 1 = perfect, 0.5 = tight, <0.5 = critical
  text_density: number; // Ratio of text content to available space
  visual_utilization: number; // How much of visual zones are filled

  // Zone-level details for granular analysis
  zones: Array<{
    id: string;
    capacity_used: number; // 0-1 ratio
    warnings: string[];
    content_type?: string;
    is_critical_overflow: boolean;
  }>;

  // Overall health assessment
  health_level: 'perfect' | 'good' | 'tight' | 'critical';
  needs_reroute: boolean;
  reroute_reason?: string;
  suggested_action?: 'keep' | 'scale_down' | 'reroute_layout' | 'simplify_content';

  // Metadata for debugging and agent logging
  render_timestamp: number;
  render_duration_ms: number;
  warnings_count: number;
  errors_count: number;
}

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

// --- VISUAL ARCHITECT SCHEMAS (Qwen-VL3 Integration) ---

/**
 * RepairAction: Structured repair instructions from Qwen-VL3 Visual Architect
 * Each action targets a specific component and describes a spatial/visual modification
 */
export interface RepairAction {
  component_id: string; // Format: "{type}-{index}" (e.g., "text-bullets-0")
  action: 'resize' | 'reposition' | 'adjust_color' | 'adjust_spacing' | 'simplify_content';
  params: Record<string, any>; // Action-specific parameters (width, height, x, y, color, etc.)
  reason: string; // Why this repair is needed (for logging)
}

/**
 * VisualArchitectResult: Result of Qwen-VL3 Visual Architect iterative loop
 * Tracks convergence, repair history, and final slide state
 */
export interface VisualArchitectResult {
  slide: SlideNode; // Final repaired slide
  rounds: number; // Number of critique-repair rounds executed
  finalScore: number; // Final visual quality score (0-100)
  repairs: RepairAction[]; // All repairs applied across rounds
  converged: boolean; // True if score >= 85 or explicit acceptance
  totalCost?: number; // Total cost of Visual Architect loop
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

/**
 * Enhanced DeckMetrics with Visual Architect tracking
 */
export interface VisualArchitectMetrics {
  enabled: boolean;
  totalRounds: number;
  avgRoundsPerSlide: number;
  convergenceRate: number; // % slides that converged
  avgInitialScore: number;
  avgFinalScore: number;
  totalRepairs: number;
  repairsByType: Record<string, number>; // resize: 5, reposition: 3, etc.
}
