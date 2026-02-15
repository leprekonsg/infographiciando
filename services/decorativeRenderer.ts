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

// ============================================================================
// COLOR CONTRAST UTILITIES
// ============================================================================

const getYiq = (hex: string): number => {
  const clean = hex.replace('#', '').trim();
  if (clean.length !== 6) return 0;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return ((r * 299) + (g * 587) + (b * 114)) / 1000;
};

const resolveReadableTextColor = (backgroundHex: string, fallbackTextHex: string): string => {
  const yiq = getYiq(backgroundHex);
  // Prefer dark text on light backgrounds, light text on dark backgrounds
  const preferred = yiq > 180 ? '0F172A' : 'F8FAFC';
  // If fallback already provides good contrast, keep it
  const fallbackYiq = getYiq(fallbackTextHex);
  const hasContrast = Math.abs(yiq - fallbackYiq) >= 80;
  return hasContrast ? fallbackTextHex : preferred;
};

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

const normalizeDecorativeType = (rawType: unknown): string | undefined => {
  if (typeof rawType !== 'string') return undefined;
  const cleaned = rawType
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .trim();
  if (!cleaned) return undefined;

  const direct = DECORATIVE_TYPE_MAP[cleaned] || cleaned;
  if (['badge', 'divider', 'accent-shape', 'glow', 'connector'].includes(direct)) {
    return direct;
  }

  for (const [needle, mapped] of Object.entries(DECORATIVE_TYPE_MAP)) {
    if (cleaned.includes(needle)) return mapped;
  }

  if (/badge|pill|tag/.test(cleaned)) return 'badge';
  if (/divider|underline|line/.test(cleaned)) return 'divider';
  if (/glow|halo/.test(cleaned)) return 'glow';
  if (/connector|arrow|flow/.test(cleaned)) return 'connector';
  if (/accent|highlight|emphasis/.test(cleaned)) return 'accent-shape';
  return undefined;
};

const resolveSemanticColorToken = (
  rawColor: unknown,
  fallback: string,
  context: DecorativeRenderContext
): string => {
  if (typeof rawColor !== 'string') return fallback;
  const token = rawColor.trim().toLowerCase().replace(/\s+/g, '-');
  if (!token) return fallback;

  if (/^#[0-9a-f]{3,8}$/i.test(token) || /^rgb(a)?\(/i.test(token) || /^hsl(a)?\(/i.test(token)) {
    return token;
  }
  if (token === 'brand-primary' || token === 'primary') return context.palette.primary;
  if (token === 'brand-secondary' || token === 'secondary') return context.palette.secondary;
  if (token === 'brand-accent' || token === 'accent') return context.palette.accent;
  if (token === 'brand-text' || token === 'text') return context.palette.text;
  if (token === 'brand-background' || token === 'background') return context.palette.background;
  return fallback;
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
  const normalizedType = normalizeDecorativeType(rawType);
  if (!normalizedType) {
    const preview = String(rawType).slice(0, 140);
    console.warn(`[DecorativeRenderer] Unknown element type (truncated): ${preview}`);
    return [];
  }
  
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
      // Should be unreachable after normalizeDecorativeType guard.
      console.warn(`[DecorativeRenderer] Unknown element type: ${String(rawType).slice(0, 140)}`);
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
  const color = resolveSemanticColorToken(badge.color, context.palette.primary, context);
  const textColor = resolveReadableTextColor(context.palette.background, context.palette.text);
  
  // Safely calculate badge dimensions with guards for empty content
  const contentText = String(badge.content || '').trim();
  if (contentText.length === 0) {
    console.warn('[renderBadge] Empty badge content');
    return [];
  }

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const requestedHeight = typeof badge.position.h === 'number' && badge.position.h > 0 ? badge.position.h : 0.38;
  const maxAllowedWidth = typeof badge.position.w === 'number' && badge.position.w > 0 ? badge.position.w : 3.6;

  // Allow badges/icons to resize from placement hints instead of hard-coding dimensions.
  const baseHeight = 0.38;
  const height = clamp(requestedHeight, 0.24, 0.42);
  const sizeScale = height / baseHeight;
  const padding = clamp(0.16 * sizeScale, 0.08, 0.2);
  const iconSize = clamp(0.22 * sizeScale, 0.14, 0.24);
  const iconGap = clamp(0.07 * sizeScale, 0.04, 0.1);
  const iconInsetX = clamp(0.09 * sizeScale, 0.05, 0.12);
  const textInsetY = clamp(0.08 * sizeScale, 0.04, 0.1);
  const charWidth = 0.075 * sizeScale;
  const letterSpacingWidthPerChar = 0.018 * sizeScale;

  const computeTextWidth = (text: string): number => {
    const length = text.length;
    if (length === 0) return 0;
    return (length * charWidth) + (Math.max(0, length - 1) * letterSpacingWidthPerChar);
  };

  let normalizedText = contentText.toUpperCase();
  let textWidth = computeTextWidth(normalizedText);

  const iconData = badge.icon ? context.iconCache.get(badge.icon) : undefined;
  const hasIcon = Boolean(iconData);
  const iconSlotWidth = hasIcon ? iconSize + iconGap : 0;

  let totalWidth = textWidth + iconSlotWidth + (padding * 2);
  if (totalWidth > maxAllowedWidth) {
    const reservedWidth = iconSlotWidth + (padding * 2);
    const maxTextWidth = Math.max(0.48, maxAllowedWidth - reservedWidth);
    if (textWidth > maxTextWidth) {
      const avgCharWidth = Math.max(0.03, charWidth + letterSpacingWidthPerChar);
      const allowedChars = Math.max(6, Math.floor((maxTextWidth / avgCharWidth) * 0.9));
      if (normalizedText.length > allowedChars) {
        const suffix = '...';
        const headLength = Math.max(3, allowedChars - suffix.length);
        normalizedText = `${normalizedText.slice(0, headLength).trimEnd()}${suffix}`;
      }
      textWidth = computeTextWidth(normalizedText);
    }
    totalWidth = Math.min(maxAllowedWidth, textWidth + reservedWidth);
  }

  const textBoxWidth = Math.max(0.35, totalWidth - iconSlotWidth - (padding * 2) + 0.06);
  const textBoxHeight = Math.max(0.12, height - clamp(0.14 * sizeScale, 0.08, 0.18));
  const fontSize = Math.round(clamp(BADGE_TYPOGRAPHY.fontSize * sizeScale, 8, 12));
  const letterSpacing = clamp(BADGE_TYPOGRAPHY.letterSpacing * sizeScale, 0.6, 2.0);
  
  // Get premium style config with safe lookup
  const styleConfig = BADGE_PREMIUM_STYLES[style] || BADGE_PREMIUM_STYLES['pill'];
  const radius = clamp(styleConfig.radius * sizeScale, 0.08, 0.5);
  const borderWidth = clamp(styleConfig.borderWidth * sizeScale, 0.5, 1.4);
  
  // 0. Premium: Subtle glow behind badge (rendered first, lowest z-index)
  if (styleConfig.hasGlow) {
    elements.push({
      type: 'shape',
      shapeType: 'roundRect',
      x: badge.position.x - (0.03 * sizeScale),
      y: badge.position.y - (0.02 * sizeScale),
      w: totalWidth + (0.06 * sizeScale),
      h: height + (0.04 * sizeScale),
      fill: {
        color: normalizeColor(color),
        alpha: styleConfig.glowAlpha
      },
      rectRadius: clamp(radius + 0.1, 0.1, 0.6),
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
      width: borderWidth,
      alpha: styleConfig.borderAlpha
    },
    rectRadius: radius,
    zIndex: context.baseZIndex
  });
  
  // 2. Icon (if present)
  let textX = badge.position.x + padding;
  
  if (hasIcon && iconData) {
    elements.push({
      type: 'image',
      data: iconData,
      x: badge.position.x + iconInsetX,
      y: badge.position.y + (height - iconSize) / 2,
      w: iconSize,
      h: iconSize,
      zIndex: context.baseZIndex + 1
    });
    textX += iconSlotWidth;
  }
  
  // 3. Text with premium letter-spacing
  elements.push({
    type: 'text',
    content: normalizedText,
    x: textX,
    y: badge.position.y + textInsetY,
    w: textBoxWidth,
    h: textBoxHeight,
    fontSize,
    color: normalizeColor(textColor),
    bold: true,
    align: 'left',
    zIndex: context.baseZIndex + 2,
    letterSpacing,
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
  const color = resolveSemanticColorToken(divider.color, context.palette.secondary, context);
  
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
  const color = resolveSemanticColorToken(accent.color, context.palette.accent, context);
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
  
  const glowColor = resolveSemanticColorToken(glow.color, context.palette.accent, context);
  return [{
    type: 'shape',
    shapeType: 'ellipse',
    x: glow.position.x - spread,
    y: glow.position.y - spread,
    w: glow.position.w + (spread * 2),
    h: glow.position.h + (spread * 2),
    fill: {
      color: normalizeColor(glowColor),
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
  const color = resolveSemanticColorToken(connector.color, context.palette.secondary, context);
  
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
