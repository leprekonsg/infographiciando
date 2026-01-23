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
  
  switch (element.type) {
    case 'badge':
      return renderBadge(element as BadgeElement, context);
    case 'divider':
      return renderDivider(element as DividerElement, context);
    case 'accent-shape':
      return renderAccentShape(element as AccentShapeElement, context);
    case 'glow':
      return renderGlow(element as GlowElement, context);
    case 'connector':
      return renderConnector(element as ConnectorElement, context);
    default:
      console.warn(`[DecorativeRenderer] Unknown element type: ${(element as any).type}`);
      return [];
  }
}

// ============================================================================
// BADGE RENDERER
// ============================================================================

/**
 * Renders a category badge/pill like "⚙️ PROCESS TRANSFORMATION"
 * 
 * Structure:
 * ┌─────────────────────────────────┐
 * │ [icon] CATEGORY TEXT           │
 * └─────────────────────────────────┘
 * 
 * Styles:
 * - pill: Full rounded ends (like iOS pills)
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
  
  const charWidth = 0.07; // Approximate width per character
  const textWidth = contentText.length * charWidth;
  const iconWidth = badge.icon ? 0.28 : 0;
  const padding = 0.15;
  const totalWidth = textWidth + iconWidth + (padding * 2);
  const height = 0.35;
  
  // Badge background with safe style lookup
  const styleConfigs: Record<string, { radius: number; fillAlpha: number; borderAlpha: number }> = {
    'pill': { radius: 0.5, fillAlpha: 0.15, borderAlpha: 0.4 },
    'tag': { radius: 0.12, fillAlpha: 0.12, borderAlpha: 0.35 },
    'minimal': { radius: 0.08, fillAlpha: 0.08, borderAlpha: 0.2 }
  };
  const styleConfig = styleConfigs[style] || styleConfigs['pill'];
  
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
      width: 1.2,
      alpha: styleConfig.borderAlpha
    },
    rectRadius: styleConfig.radius,
    zIndex: context.baseZIndex
  });
  
  // Icon (if present)
  let textX = badge.position.x + padding;
  
  if (badge.icon) {
    const iconData = context.iconCache.get(badge.icon);
    if (iconData) {
      const iconSize = 0.2;
      elements.push({
        type: 'image',
        data: iconData,
        x: badge.position.x + 0.08,
        y: badge.position.y + (height - iconSize) / 2,
        w: iconSize,
        h: iconSize,
        zIndex: context.baseZIndex + 1
      });
      textX += iconWidth;
    }
  }
  
  // Text
  elements.push({
    type: 'text',
    content: contentText.toUpperCase(),
    x: textX,
    y: badge.position.y + 0.07,
    w: textWidth + 0.1,
    h: height - 0.14,
    fontSize: 10,
    color: normalizeColor(color),
    bold: true,
    align: 'left',
    zIndex: context.baseZIndex + 2
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
