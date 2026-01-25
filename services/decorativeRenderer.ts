/**
 * Decorative Element Renderers
 * 
 * This module renders decorative/accent elements that add visual polish:
 * - Badge: Category pills (e.g., "⚙️ PROCESS TRANSFORMATION")
 * - Divider: Horizontal/vertical separators
 * - AccentShape: Underlines, brackets, highlights
 * - Glow: Soft background glows
 * - Connector: Lines between elements
 * 
 * These elements exist on the decorative layer (z-index 1-19)
 * and provide "serendipity" - small surprising details that delight.
 */

import {
  DecorativeElement,
  BadgeElementSchema,
  DividerElementSchema,
  AccentShapeElementSchema,
  GlowElementSchema,
  ConnectorElementSchema,
  Position
} from '../types/serendipityTypes';
import { VisualElement } from '../types/slideTypes';
import { normalizeColor } from './infographicRenderer';
import { z } from 'zod';

type BadgeElement = z.infer<typeof BadgeElementSchema>;
type DividerElement = z.infer<typeof DividerElementSchema>;
type AccentShapeElement = z.infer<typeof AccentShapeElementSchema>;
type GlowElement = z.infer<typeof GlowElementSchema>;
type ConnectorElement = z.infer<typeof ConnectorElementSchema>;

// ============================================================================
// RENDER CONTEXT
// ============================================================================

export interface DecorativeRenderContext {
  palette: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
  };
  iconCache: Map<string, string>;
  baseZIndex: number;
}

// ============================================================================
// MAIN DISPATCHER
// ============================================================================

// Normalize decorative element types from compositionArchitect to supported renderer types
// This mapping bridges the gap between what the LLM generates and what we can render
const DECORATIVE_TYPE_MAP: Record<string, string> = {
  // Direct mappings
  'badge': 'badge',
  'divider': 'divider',
  'accent-shape': 'accent-shape',
  'glow': 'glow',
  'connector': 'connector',
  
  // CompositionArchitect-generated types → supported types
  'category-badge': 'badge',
  'floating-stat': 'badge',        // Render as badge with stat styling
  'icon-glow': 'glow',
  'accent-underline': 'divider',   // Render as horizontal divider
  'gradient-underline': 'divider', // Render as horizontal divider
  'gradient-divider': 'divider',
  'connector-flow': 'connector',
  'connector-lines': 'connector',
  'quote-callout': 'badge',        // Render as styled badge
  'asymmetric-emphasis': 'accent-shape',
  'narrative-flow-pattern': 'connector',  // Render as flow connector
};

export function renderDecorativeElement(
  element: DecorativeElement,
  context: DecorativeRenderContext
): VisualElement[] {
  // Input validation
  if (!element || !element.type) {
    console.warn('[renderDecorativeElement] Invalid element input');
    return [];
  }
  
  if (!context || !context.palette) {
    console.warn('[renderDecorativeElement] Invalid context input');
    return [];
  }
  
  // Normalize the element type using the mapping
  const rawType = (element as any).type;
  const normalizedType = DECORATIVE_TYPE_MAP[rawType] || rawType;
  
  // If the type was mapped, create a modified element with the normalized type
  const normalizedElement = normalizedType !== rawType
    ? { ...element, type: normalizedType, _originalType: rawType }
    : element;
  
  switch (normalizedType) {
    case 'badge':
      return renderBadge(normalizedElement as BadgeElement, context);
    case 'divider':
      return renderDivider(normalizedElement as DividerElement, context);
    case 'accent-shape':
      return renderAccentShape(normalizedElement as AccentShapeElement, context);
    case 'glow':
      return renderGlow(normalizedElement as GlowElement, context);
    case 'connector':
      return renderConnector(normalizedElement as ConnectorElement, context);
    default:
      // Only warn if we truly don't recognize the type after normalization
      console.warn(`[DecorativeRenderer] Unknown element type: ${rawType} (normalized: ${normalizedType})`);
      return [];
  }
}

// ============================================================================
// PREMIUM BADGE CONSTANTS
// ============================================================================

const BADGE_TYPOGRAPHY = {
  fontSize: 10,
  letterSpacing: 1.5,  // Spread letters for professional look
  fontWeight: 600
};

const BADGE_PREMIUM_STYLES: Record<string, {
  radius: number;
  fillAlpha: number;
  borderAlpha: number;
  borderWidth: number;
  hasGlow: boolean;
  glowAlpha: number;
}> = {
  'pill': { 
    radius: 0.5, 
    fillAlpha: 0.12, 
    borderAlpha: 0.35, 
    borderWidth: 1.0,
    hasGlow: true,
    glowAlpha: 0.08
  },
  'tag': { 
    radius: 0.12, 
    fillAlpha: 0.1, 
    borderAlpha: 0.3, 
    borderWidth: 1.0,
    hasGlow: false,
    glowAlpha: 0
  },
  'minimal': { 
    radius: 0.08, 
    fillAlpha: 0.06, 
    borderAlpha: 0.15, 
    borderWidth: 0.5,
    hasGlow: false,
    glowAlpha: 0
  }
};

// ============================================================================
// BADGE RENDERER
// ============================================================================

/**
 * Renders a PREMIUM category badge/pill like "⚙️ PROCESS TRANSFORMATION"
 * 
 * Structure:
 * ┌─────────────────────────────────┐
 * │ [icon] CATEGORY TEXT           │
 * └─────────────────────────────────┘
 * 
 * Premium Features:
 * - Letter-spacing for professional typography
 * - Optional subtle glow behind badge for depth
 * - Refined border and fill alphas
 * 
 * Styles:
 * - pill: Full rounded ends (like iOS pills) with subtle glow
 * - tag: Less rounded, more rectangular
 * - minimal: Just text with subtle background
 */
export function renderBadge(
  badge: BadgeElement,
  context: DecorativeRenderContext
): VisualElement[] {
  // Input validation
  if (!badge || !badge.position || !badge.content) {
    console.warn('[renderBadge] Invalid badge input');
    return [];
  }
  
  const elements: VisualElement[] = [];
  const style = badge.style || 'pill';
  const color = badge.color || context.palette.primary;
  
  // Safely calculate badge dimensions with guards for empty content
  const contentText = String(badge.content || '').trim();
  if (contentText.length === 0) {
    console.warn('[renderBadge] Empty badge content');
    return [];
  }
  
  // Improved character width calculation (accounting for letter-spacing)
  const charWidth = 0.065; // Slightly narrower base
  const letterSpacingWidth = (contentText.length - 1) * 0.015; // Extra width from spacing
  const textWidth = (contentText.length * charWidth) + letterSpacingWidth;
  const iconWidth = badge.icon ? 0.3 : 0;
  const padding = 0.16;
  const totalWidth = textWidth + iconWidth + (padding * 2);
  const height = 0.38;
  
  // Get premium style config with safe lookup
  const styleConfig = BADGE_PREMIUM_STYLES[style] || BADGE_PREMIUM_STYLES['pill'];
  
  // 0. Premium: Subtle glow behind badge (rendered first, lowest z-index)
  if (styleConfig.hasGlow) {
    elements.push({
      type: 'shape',
      shapeType: 'roundRect',
      x: badge.position.x - 0.03,
      y: badge.position.y - 0.02,
      w: totalWidth + 0.06,
      h: height + 0.04,
      fill: {
        color: normalizeColor(color),
        alpha: styleConfig.glowAlpha
      },
      rectRadius: styleConfig.radius + 0.1,
      zIndex: context.baseZIndex - 1
    });
  }
  
  // 1. Badge background
  elements.push({
    type: 'shape',
    shapeType: 'roundRect',
    x: badge.position.x,
    y: badge.position.y,
    w: totalWidth,
    h: height,
    fill: {
      color: normalizeColor(color),
      alpha: styleConfig.fillAlpha
    },
    border: {
      color: normalizeColor(color),
      width: styleConfig.borderWidth,
      alpha: styleConfig.borderAlpha
    },
    rectRadius: styleConfig.radius,
    zIndex: context.baseZIndex
  });
  
  // 2. Icon (if present)
  let textX = badge.position.x + padding;
  
  if (badge.icon) {
    const iconData = context.iconCache.get(badge.icon);
    if (iconData) {
      const iconSize = 0.22;
      elements.push({
        type: 'image',
        data: iconData,
        x: badge.position.x + 0.09,
        y: badge.position.y + (height - iconSize) / 2,
        w: iconSize,
        h: iconSize,
        zIndex: context.baseZIndex + 1
      });
      textX += iconWidth;
    }
  }
  
  // 3. Text with premium letter-spacing
  elements.push({
    type: 'text',
    content: contentText.toUpperCase(),
    x: textX,
    y: badge.position.y + 0.08,
    w: textWidth + 0.1,
    h: height - 0.14,
    fontSize: BADGE_TYPOGRAPHY.fontSize,
    color: normalizeColor(color),
    bold: true,
    align: 'left',
    zIndex: context.baseZIndex + 2,
    letterSpacing: BADGE_TYPOGRAPHY.letterSpacing,
    fontWeight: BADGE_TYPOGRAPHY.fontWeight,
    textTransform: 'uppercase'
  });
  
  return elements;
}

// ============================================================================
// DIVIDER RENDERER
// ============================================================================

/**
 * Renders a divider line
 * 
 * Styles:
 * - solid: Simple line
 * - gradient: Fades at ends
 * - glow: Has a subtle glow effect
 * - dashed: Dotted/dashed line
 */
export function renderDivider(
  divider: DividerElement,
  context: DecorativeRenderContext
): VisualElement[] {
  const elements: VisualElement[] = [];
  const color = divider.color || context.palette.secondary;
  
  const isHorizontal = divider.orientation === 'horizontal';
  const thickness = 0.02;
  
  // Base line
  elements.push({
    type: 'shape',
    shapeType: 'rect',
    x: divider.position.x,
    y: divider.position.y,
    w: isHorizontal ? divider.position.w : thickness,
    h: isHorizontal ? thickness : divider.position.h,
    fill: {
      color: normalizeColor(color),
      alpha: divider.style === 'glow' ? 0.6 : 0.4
    },
    zIndex: context.baseZIndex
  });
  
  // Glow effect (if style is 'glow')
  if (divider.style === 'glow') {
    elements.unshift({
      type: 'shape',
      shapeType: 'rect',
      x: divider.position.x - 0.02,
      y: divider.position.y - 0.02,
      w: isHorizontal ? divider.position.w + 0.04 : thickness + 0.04,
      h: isHorizontal ? thickness + 0.04 : divider.position.h + 0.04,
      fill: {
        color: normalizeColor(color),
        alpha: 0.15
      },
      zIndex: context.baseZIndex - 1
    });
  }
  
  return elements;
}

// ============================================================================
// ACCENT SHAPE RENDERER
// ============================================================================

/**
 * Renders accent shapes like underlines, brackets, highlights
 */
export function renderAccentShape(
  accent: AccentShapeElement,
  context: DecorativeRenderContext
): VisualElement[] {
  const elements: VisualElement[] = [];
  const color = accent.color || context.palette.accent;
  const thickness = accent.thickness || 0.03;
  
  switch (accent.shape) {
    case 'underline':
      // Simple underline bar
      elements.push({
        type: 'shape',
        shapeType: 'roundRect',
        x: accent.position.x,
        y: accent.position.y + accent.position.h - thickness,
        w: accent.position.w,
        h: thickness,
        fill: {
          color: normalizeColor(color),
          alpha: 0.8
        },
        rectRadius: 0.5, // Rounded ends
        zIndex: context.baseZIndex
      });
      break;
      
    case 'highlight':
      // Background highlight rectangle
      elements.push({
        type: 'shape',
        shapeType: 'roundRect',
        x: accent.position.x,
        y: accent.position.y,
        w: accent.position.w,
        h: accent.position.h,
        fill: {
          color: normalizeColor(color),
          alpha: 0.15
        },
        rectRadius: 0.08,
        zIndex: context.baseZIndex
      });
      break;
      
    case 'bracket-left':
      // Left bracket shape (simple line for now)
      elements.push({
        type: 'shape',
        shapeType: 'rect',
        x: accent.position.x,
        y: accent.position.y,
        w: thickness,
        h: accent.position.h,
        fill: {
          color: normalizeColor(color),
          alpha: 0.6
        },
        zIndex: context.baseZIndex
      });
      break;
      
    case 'bracket-right':
      elements.push({
        type: 'shape',
        shapeType: 'rect',
        x: accent.position.x + accent.position.w - thickness,
        y: accent.position.y,
        w: thickness,
        h: accent.position.h,
        fill: {
          color: normalizeColor(color),
          alpha: 0.6
        },
        zIndex: context.baseZIndex
      });
      break;
      
    case 'arrow':
      // Simple right-pointing indicator
      // Would need triangle shape support in PPTX
      elements.push({
        type: 'shape',
        shapeType: 'rect',
        x: accent.position.x,
        y: accent.position.y + accent.position.h / 2 - thickness / 2,
        w: accent.position.w * 0.8,
        h: thickness,
        fill: {
          color: normalizeColor(color),
          alpha: 0.5
        },
        zIndex: context.baseZIndex
      });
      break;
  }
  
  return elements;
}

// ============================================================================
// GLOW RENDERER
// ============================================================================

/**
 * Renders a soft glow effect behind elements
 */
export function renderGlow(
  glow: GlowElement,
  context: DecorativeRenderContext
): VisualElement[] {
  // Input validation
  if (!glow || !glow.position || !glow.color) {
    console.warn('[renderGlow] Invalid glow input');
    return [];
  }
  
  const intensityMap: Record<string, number> = {
    'subtle': 0.1,
    'medium': 0.2,
    'strong': 0.35
  };
  const intensityAlpha = intensityMap[glow.intensity] || intensityMap['subtle'];
  
  const spread = typeof glow.blur === 'number' && glow.blur > 0 ? glow.blur : 0.15;
  
  return [{
    type: 'shape',
    shapeType: 'ellipse',
    x: glow.position.x - spread,
    y: glow.position.y - spread,
    w: glow.position.w + (spread * 2),
    h: glow.position.h + (spread * 2),
    fill: {
      color: normalizeColor(glow.color),
      alpha: intensityAlpha
    },
    zIndex: context.baseZIndex
  }];
}

// ============================================================================
// CONNECTOR RENDERER
// ============================================================================

/**
 * Renders connecting lines between elements
 * Note: Complex curved connectors would need SVG path support
 */
export function renderConnector(
  connector: ConnectorElement,
  context: DecorativeRenderContext
): VisualElement[] {
  const elements: VisualElement[] = [];
  const color = connector.color || context.palette.secondary;
  
  // Null safety: ensure from/to coordinates exist
  if (!connector.from || !connector.to || 
      typeof connector.from.x !== 'number' || typeof connector.from.y !== 'number' ||
      typeof connector.to.x !== 'number' || typeof connector.to.y !== 'number') {
    console.warn('[DecorativeRenderer] Connector missing valid from/to coordinates, skipping');
    return elements; // Return empty array instead of crashing
  }
  
  // Calculate line geometry
  const dx = connector.to.x - connector.from.x;
  const dy = connector.to.y - connector.from.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  
  const thickness = 0.015;
  
  // Simple straight line
  elements.push({
    type: 'shape',
    shapeType: 'rect',
    x: connector.from.x,
    y: connector.from.y - thickness / 2,
    w: length,
    h: thickness,
    fill: {
      color: normalizeColor(color),
      alpha: connector.style === 'dotted' ? 0.3 : 0.5
    },
    rotation: angle,
    zIndex: context.baseZIndex
  });
  
  // Arrow head (if arrow style)
  if (connector.style === 'arrow') {
    // Simplified arrow - would be triangle in full implementation
    elements.push({
      type: 'shape',
      shapeType: 'ellipse',
      x: connector.to.x - 0.05,
      y: connector.to.y - 0.05,
      w: 0.1,
      h: 0.1,
      fill: {
        color: normalizeColor(color),
        alpha: 0.6
      },
      zIndex: context.baseZIndex + 1
    });
  }
  
  return elements;
}

// ============================================================================
// BATCH RENDERER
// ============================================================================

/**
 * Renders all decorative elements for a slide
 */
export function renderDecorativeLayer(
  elements: DecorativeElement[],
  context: DecorativeRenderContext
): VisualElement[] {
  // Input validation
  if (!Array.isArray(elements)) {
    console.warn('[renderDecorativeLayer] Invalid elements input, expected array');
    return [];
  }
  
  if (elements.length === 0) {
    return [];
  }
  
  if (!context || !context.palette) {
    console.warn('[renderDecorativeLayer] Invalid context input');
    return [];
  }
  
  const result: VisualElement[] = [];
  
  // Use for...of to avoid forEach issues with potential async operations
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (!element) continue; // Skip null/undefined elements
    
    const elementContext = {
      ...context,
      baseZIndex: context.baseZIndex + (i * 3) // Space for sub-elements
    };
    result.push(...renderDecorativeElement(element, elementContext));
  }
  
  return result;
}
