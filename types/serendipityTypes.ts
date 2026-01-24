/**
 * Serendipity Types - Layer-Based Composition Model
 * 
 * This module defines the new type system for high-serendipity slide generation.
 * It introduces explicit layer modeling to match PowerPoint's native structure.
 * 
 * Key Concepts:
 * - LayeredComposition: Explicit z-order layers (background → decorative → content → overlay)
 * - CardElement: First-class card primitive with glass/solid/outline styles
 * - SerendipityDNA: Extended theme tokens with controlled variation
 * - SurpriseSlot: Intentional "delight" elements allocated per slide
 */

import { z } from "zod";

// ============================================================================
// LAYER 0: BACKGROUND
// ============================================================================

export const BackgroundTypeSchema = z.enum([
  'solid',
  'gradient',
  'image',
  'mesh'
]);

export const MeshPatternSchema = z.enum([
  'circuit',
  'topological',
  'particle',
  'bokeh',
  'waves',
  'grid'
]);

export const BackgroundLayerSchema = z.object({
  type: BackgroundTypeSchema,
  colors: z.array(z.string()).min(1).max(4),
  gradientAngle: z.number().optional(), // 0-360
  imageUrl: z.string().optional(),
  meshPattern: MeshPatternSchema.optional(),
  meshIntensity: z.number().min(0).max(1).optional() // 0 = subtle, 1 = prominent
});

// ============================================================================
// LAYER 1: DECORATIVE ELEMENTS
// ============================================================================

export const DecorativeTypeSchema = z.enum([
  'badge',          // Category pill (e.g., "⚙️ PROCESS TRANSFORMATION")
  'divider',        // Horizontal/vertical line
  'accent-shape',   // Underline, bracket, highlight bar
  'glow',           // Soft glow behind elements
  'connector',      // Lines connecting cards/elements
  'watermark'       // Subtle background text/logo
]);

export const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number()
});

export const BadgeElementSchema = z.object({
  type: z.literal('badge'),
  position: PositionSchema,
  content: z.string().max(40),
  icon: z.string().optional(),
  color: z.string().optional(), // Defaults to primary
  style: z.enum(['pill', 'tag', 'minimal']).optional()
});

export const DividerElementSchema = z.object({
  type: z.literal('divider'),
  position: PositionSchema,
  orientation: z.enum(['horizontal', 'vertical']),
  style: z.enum(['solid', 'gradient', 'glow', 'dashed']),
  color: z.string().optional()
});

export const AccentShapeElementSchema = z.object({
  type: z.literal('accent-shape'),
  position: PositionSchema,
  shape: z.enum(['underline', 'bracket-left', 'bracket-right', 'highlight', 'arrow']),
  color: z.string().optional(),
  thickness: z.number().optional()
});

export const GlowElementSchema = z.object({
  type: z.literal('glow'),
  position: PositionSchema,
  color: z.string(),
  intensity: z.enum(['subtle', 'medium', 'strong']),
  blur: z.number().optional()
});

export const ConnectorElementSchema = z.object({
  type: z.literal('connector'),
  from: z.object({ x: z.number(), y: z.number() }),
  to: z.object({ x: z.number(), y: z.number() }),
  style: z.enum(['line', 'arrow', 'dotted', 'curved']),
  color: z.string().optional()
});

export const DecorativeElementSchema = z.discriminatedUnion('type', [
  BadgeElementSchema,
  DividerElementSchema,
  AccentShapeElementSchema,
  GlowElementSchema,
  ConnectorElementSchema
]);

export const DecorativeLayerSchema = z.object({
  elements: z.array(DecorativeElementSchema).max(10)
});

// ============================================================================
// LAYER 2: CONTENT - CARDS
// ============================================================================

export const CardStyleSchema = z.enum([
  'glass',    // Semi-transparent with blur (modern)
  'solid',    // Opaque background
  'outline',  // Border only, transparent fill
  'gradient', // Gradient fill
  'elevated'  // Solid with shadow
]);

export const IconContainerStyleSchema = z.enum([
  'circle',
  'rounded-square',
  'square',
  'none'
]);

export const CardHeaderSchema = z.object({
  icon: z.string().optional(),
  iconContainer: IconContainerStyleSchema.optional(),
  iconColor: z.string().optional(),
  overline: z.string().max(30).optional(), // Small text above title
  title: z.string().max(60),
  subtitle: z.string().max(80).optional()
});

export const CardElementSchema = z.object({
  id: z.string(),
  position: PositionSchema,
  style: CardStyleSchema,
  header: CardHeaderSchema.optional(),
  body: z.string().max(200).optional(),
  footer: z.string().max(50).optional(),
  emphasis: z.enum(['primary', 'secondary', 'muted']).optional(),
  // Visual modifiers
  glowColor: z.string().optional(),
  borderAccent: z.boolean().optional()
});

// ============================================================================
// LAYER 2: CONTENT - TEXT BLOCKS
// ============================================================================

export const TextBlockStyleSchema = z.enum([
  'hero',       // Large, impactful text
  'title',      // Standard title
  'subtitle',   // Smaller supporting text
  'bullets',    // Bulleted list
  'prose',      // Paragraph text
  'quote',      // Quote with emphasis
  'caption'     // Small descriptive text
]);

export const TextBlockElementSchema = z.object({
  id: z.string(),
  position: PositionSchema,
  style: TextBlockStyleSchema,
  content: z.union([z.string(), z.array(z.string())]),
  alignment: z.enum(['left', 'center', 'right']).optional(),
  color: z.string().optional(),
  maxLines: z.number().optional()
});

// ============================================================================
// LAYER 2: CONTENT - DATA VIZ
// ============================================================================

export const DataVizElementSchema = z.object({
  id: z.string(),
  position: PositionSchema,
  vizType: z.enum(['bar', 'line', 'pie', 'doughnut', 'metric', 'diagram']),
  data: z.any(), // Flexible for different viz types
  title: z.string().optional()
});

export const ContentLayerSchema = z.object({
  cards: z.array(CardElementSchema).max(6),
  textBlocks: z.array(TextBlockElementSchema).max(4),
  dataViz: z.array(DataVizElementSchema).max(2)
});

// ============================================================================
// LAYER 3: OVERLAY
// ============================================================================

export const OverlayElementSchema = z.object({
  type: z.enum(['tooltip', 'callout', 'annotation', 'floating-stat']),
  position: PositionSchema,
  content: z.string(),
  style: z.any().optional()
});

export const OverlayLayerSchema = z.object({
  elements: z.array(OverlayElementSchema).max(3)
});

// ============================================================================
// LAYERED COMPOSITION (THE COMPLETE MODEL)
// ============================================================================

export const LayeredCompositionSchema = z.object({
  slideId: z.string(),
  background: BackgroundLayerSchema,
  decorative: DecorativeLayerSchema,
  content: ContentLayerSchema,
  overlay: OverlayLayerSchema.optional()
});

// ============================================================================
// SERENDIPITY DNA (EXTENDED THEME SYSTEM)
// ============================================================================

export const VariationAxisSchema = z.enum([
  'card-arrangement',    // How cards are laid out (1×3, 2×2, staggered)
  'icon-style',          // Icon container variations
  'typography-weight',   // Hero → Regular weight distribution
  'accent-placement',    // Where decorative accents appear
  'color-temperature',   // Warm ↔ Cool shifts within palette
  'spacing-rhythm'       // Tight ↔ Airy spacing
]);

export const SerendipityDNASchema = z.object({
  // Core theme (from existing SlideStyleDNA)
  motifs: z.array(z.string()).min(1).max(3),
  texture: z.enum(['mesh', 'circuit', 'soft-bands', 'bokeh', 'minimal-lines', 'gradient-ribbons', 'abstract-geo']).optional(),
  gridRhythm: z.enum(['tight', 'balanced', 'airy']).optional(),
  accentRule: z.enum(['single', 'dual', 'highlight']).optional(),
  cardStyle: CardStyleSchema.optional(),
  
  // NEW: Serendipity Controls
  variationAxes: z.array(VariationAxisSchema).optional(), // Which axes allow variation
  surpriseSlots: z.number().min(0).max(2).optional(),     // Max surprise elements per slide
  compositionBias: z.enum(['symmetric', 'asymmetric', 'dynamic']).optional(),
  accentDensity: z.enum(['minimal', 'balanced', 'rich']).optional(),
  
  // NEW: Visual Vocabulary Permissions
  allowedDecorations: z.array(DecorativeTypeSchema).optional(),
  allowedCardStyles: z.array(CardStyleSchema).optional(),
  iconContainerStyle: IconContainerStyleSchema.optional(),
  
  // NEW: Surprise cues for the Composition Architect
  surpriseCues: z.array(z.string()).optional() // E.g., ["asymmetric card emphasis", "subtle icon glow"]
});

// ============================================================================
// SURPRISE SLOT SYSTEM
// ============================================================================

export const SurpriseElementTypeSchema = z.enum([
  'category-badge',       // Add a category pill at top
  'accent-underline',     // Underline the title
  'icon-glow',            // Add glow behind icons
  'quote-callout',        // Style a text block as quote
  'asymmetric-emphasis',  // Make one card larger
  'connector-flow',       // Add connecting lines between cards
  'floating-stat',        // Add a floating metric
  'gradient-border'       // Add gradient border to cards
]);

export const SurpriseSlotSchema = z.object({
  type: SurpriseElementTypeSchema,
  target: z.string().optional(), // Which element to apply to
  intensity: z.enum(['subtle', 'moderate', 'bold']),
  // NOTE: Use passthrough to avoid empty properties object which Gemini rejects
  // "should be non-empty for OBJECT type" error
  color: z.string().optional(),  // For glows, borders
  scale: z.number().optional()   // For asymmetric emphasis (1.0-1.5)
});

export const SlideSerendipityPlanSchema = z.object({
  variationBudget: z.number().min(0).max(1),
  allocatedSurprises: z.array(SurpriseSlotSchema).max(2),
  compositionChoices: z.object({
    cardArrangement: z.string().optional(),
    iconStyle: IconContainerStyleSchema.optional(),
    accentPlacement: z.string().optional()
  }).optional()
});

// ============================================================================
// COMPOSITION ARCHITECT OUTPUT
// ============================================================================

export const CompositionPlanSchema = z.object({
  slideId: z.string(),
  
  // Layer structure decisions
  layerPlan: z.object({
    background: z.object({
      type: BackgroundTypeSchema,
      suggestion: z.string() // E.g., "mesh with topological pattern"
    }),
    decorativeElements: z.array(z.object({
      type: DecorativeTypeSchema,
      placement: z.string(),
      purpose: z.string()
    })).max(4),
    contentStructure: z.object({
      pattern: z.enum([
        'single-hero',         // One large text block
        'card-row',            // Horizontal card array (like reference)
        'card-grid',           // 2×2 or similar
        'split-content',       // Text left, visual right (or vice versa)
        'metrics-rail',        // Side metrics + main content
        'narrative-flow'       // Sequential cards with story arc
      ]),
      cardCount: z.number().optional(),
      cardStyle: CardStyleSchema.optional(),
      textBlockCount: z.number().optional()
    }),
    overlayIntention: z.string().optional() // E.g., "No overlay needed"
  }),
  
  // Serendipity execution
  serendipityPlan: SlideSerendipityPlanSchema,
  
  // Reasoning (for debugging)
  reasoning: z.string().max(200)
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type BackgroundType = z.infer<typeof BackgroundTypeSchema>;
export type MeshPattern = z.infer<typeof MeshPatternSchema>;
export type BackgroundLayer = z.infer<typeof BackgroundLayerSchema>;
export type DecorativeType = z.infer<typeof DecorativeTypeSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type DecorativeElement = z.infer<typeof DecorativeElementSchema>;
export type DecorativeLayer = z.infer<typeof DecorativeLayerSchema>;
export type CardStyle = z.infer<typeof CardStyleSchema>;
export type IconContainerStyle = z.infer<typeof IconContainerStyleSchema>;
export type CardElement = z.infer<typeof CardElementSchema>;
export type TextBlockStyle = z.infer<typeof TextBlockStyleSchema>;
export type TextBlockElement = z.infer<typeof TextBlockElementSchema>;
export type DataVizElement = z.infer<typeof DataVizElementSchema>;
export type ContentLayer = z.infer<typeof ContentLayerSchema>;
export type OverlayLayer = z.infer<typeof OverlayLayerSchema>;
export type LayeredComposition = z.infer<typeof LayeredCompositionSchema>;
export type VariationAxis = z.infer<typeof VariationAxisSchema>;
export type SerendipityDNA = z.infer<typeof SerendipityDNASchema>;
export type SurpriseElementType = z.infer<typeof SurpriseElementTypeSchema>;
export type SurpriseSlot = z.infer<typeof SurpriseSlotSchema>;
export type SlideSerendipityPlan = z.infer<typeof SlideSerendipityPlanSchema>;
export type CompositionPlan = z.infer<typeof CompositionPlanSchema>;
