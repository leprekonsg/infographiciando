/**
 * Card Renderer - Glass/Modern Card Primitive
 * 
 * This module renders first-class card elements with modern styles:
 * - Glass: Semi-transparent with blur effect
 * - Solid: Opaque background
 * - Outline: Border only
 * - Gradient: Gradient fill
 * - Elevated: Solid with shadow
 * 
 * Card anatomy (based on reference image):
 * ┌─────────────────────────────────────┐
 * │  ╭───╮  ← Icon in container         │
 * │  │ ! │                              │
 * │  ╰───╯                              │
 * │                                     │
 * │  The Trap:        ← Overline        │
 * │  Avoiding...      ← Title           │
 * │                                     │
 * │  "A broken..."    ← Body            │
 * └─────────────────────────────────────┘
 */

import { 
  CardElement, 
  CardStyle, 
  IconContainerStyle,
  Position 
} from '../types/serendipityTypes';
import { VisualElement, GlobalStyleGuide } from '../types/slideTypes';
import { normalizeColor } from './infographicRenderer';

// ============================================================================
// STYLE CONSTANTS
// ============================================================================

const CARD_STYLES: Record<CardStyle, {
  fillAlpha: number;
  borderAlpha: number;
  borderWidth: number;
  blur?: boolean;
}> = {
  'glass': { fillAlpha: 0.12, borderAlpha: 0.25, borderWidth: 1.2, blur: true },
  'solid': { fillAlpha: 0.85, borderAlpha: 0.4, borderWidth: 1 },
  'outline': { fillAlpha: 0.05, borderAlpha: 0.5, borderWidth: 1.5 },
  'gradient': { fillAlpha: 0.6, borderAlpha: 0.3, borderWidth: 1 },
  'elevated': { fillAlpha: 0.9, borderAlpha: 0.2, borderWidth: 0 }
};

const ICON_CONTAINER_SIZES: Record<IconContainerStyle, {
  size: number;      // Container size (slide units)
  iconScale: number; // Icon size relative to container
  radius: number;    // Border radius (0 = square, 1 = circle)
}> = {
  'circle': { size: 0.5, iconScale: 0.6, radius: 1 },
  'rounded-square': { size: 0.5, iconScale: 0.6, radius: 0.2 },
  'square': { size: 0.5, iconScale: 0.6, radius: 0 },
  'none': { size: 0, iconScale: 1, radius: 0 }
};

const EMPHASIS_MODIFIERS: Record<string, { opacity: number; scale: number }> = {
  'primary': { opacity: 1.0, scale: 1.0 },
  'secondary': { opacity: 0.85, scale: 0.95 },
  'muted': { opacity: 0.7, scale: 0.9 }
};

// ============================================================================
// TYPOGRAPHY CONSTANTS
// ============================================================================

const TYPOGRAPHY = {
  overline: { size: 10, weight: 600, letterSpacing: 1.5, uppercase: true },
  title: { size: 18, weight: 700, letterSpacing: 0 },
  subtitle: { size: 14, weight: 400, letterSpacing: 0 },
  body: { size: 13, weight: 400, lineHeight: 1.4 }
};

// ============================================================================
// CARD RENDERER
// ============================================================================

export interface CardRenderContext {
  palette: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    textMuted: string;
  };
  iconCache: Map<string, string>;
  baseZIndex: number;
}

export function renderCard(
  card: CardElement,
  context: CardRenderContext
): VisualElement[] {
  // Input validation
  if (!card || !card.position) {
    console.warn('[renderCard] Invalid card input');
    return [];
  }
  
  if (!context || !context.palette) {
    console.warn('[renderCard] Invalid context input');
    return [];
  }
  
  const elements: VisualElement[] = [];
  // Safe lookup with fallback to 'glass' style if unknown
  const style = CARD_STYLES[card.style] || CARD_STYLES['glass'];
  const emphasis = EMPHASIS_MODIFIERS[card.emphasis || 'primary'] || EMPHASIS_MODIFIERS['primary'];
  
  let zIndex = context.baseZIndex;
  
  // 1. Card Background
  elements.push(createCardBackground(card, style, context, zIndex++));
  
  // 2. Card Border (separate for glass effect)
  if (style.borderWidth > 0) {
    elements.push(createCardBorder(card, style, context, zIndex++));
  }
  
  // 3. Icon Container (if present)
  if (card.header?.icon) {
    const iconElements = renderIconContainer(
      card,
      context,
      zIndex
    );
    elements.push(...iconElements);
    zIndex += iconElements.length;
  }
  
  // 4. Header Text (overline + title + subtitle)
  if (card.header) {
    const headerElements = renderCardHeader(
      card,
      context,
      zIndex
    );
    elements.push(...headerElements);
    zIndex += headerElements.length;
  }
  
  // 5. Body Text
  if (card.body) {
    elements.push(renderCardBody(card, context, zIndex++));
  }
  
  // 6. Optional Glow Effect
  if (card.glowColor) {
    // Insert glow behind card (lower z-index)
    elements.unshift(createGlowEffect(card, context.baseZIndex - 1));
  }
  
  return elements;
}

// ============================================================================
// CARD BACKGROUND & BORDER
// ============================================================================

function createCardBackground(
  card: CardElement,
  style: typeof CARD_STYLES['glass'],
  context: CardRenderContext,
  zIndex: number
): VisualElement {
  // Determine fill color based on style
  let fillColor = context.palette.background;
  
  // For glass cards on dark backgrounds, use a lighter fill
  if (card.style === 'glass') {
    // Slightly lighter than background for glass effect
    fillColor = lightenColor(context.palette.background, 0.1);
  }
  
  return {
    type: 'shape',
    shapeType: 'roundRect',
    x: card.position.x,
    y: card.position.y,
    w: card.position.w,
    h: card.position.h,
    fill: {
      color: normalizeColor(fillColor),
      alpha: style.fillAlpha
    },
    rectRadius: 0.15, // Modern rounded corners
    zIndex
  };
}

function createCardBorder(
  card: CardElement,
  style: typeof CARD_STYLES['glass'],
  context: CardRenderContext,
  zIndex: number
): VisualElement {
  // Accent border if specified, otherwise subtle
  const borderColor = card.borderAccent 
    ? context.palette.accent 
    : lightenColor(context.palette.background, 0.3);
  
  return {
    type: 'shape',
    shapeType: 'roundRect',
    x: card.position.x,
    y: card.position.y,
    w: card.position.w,
    h: card.position.h,
    fill: { color: '000000', alpha: 0 }, // Transparent fill
    border: {
      color: normalizeColor(borderColor),
      width: style.borderWidth,
      alpha: style.borderAlpha
    },
    rectRadius: 0.15,
    zIndex
  };
}

// ============================================================================
// ICON CONTAINER
// ============================================================================

function renderIconContainer(
  card: CardElement,
  context: CardRenderContext,
  baseZIndex: number
): VisualElement[] {
  const elements: VisualElement[] = [];
  const containerStyle = card.header?.iconContainer || 'circle';
  // Safe lookup with fallback to 'circle' if unknown container style
  const containerConfig = ICON_CONTAINER_SIZES[containerStyle] || ICON_CONTAINER_SIZES['circle'];
  
  if (containerStyle === 'none' || !card.header?.icon) {
    return elements;
  }
  
  // Position: top-left with padding
  const padding = 0.15;
  const iconX = card.position.x + padding;
  const iconY = card.position.y + padding;
  
  // 1. Container Background (filled circle/square)
  const containerColor = card.header.iconColor || context.palette.primary;
  
  elements.push({
    type: 'shape',
    shapeType: containerStyle === 'circle' ? 'ellipse' : 'roundRect',
    x: iconX,
    y: iconY,
    w: containerConfig.size,
    h: containerConfig.size,
    fill: {
      color: normalizeColor(containerColor),
      alpha: 0.2 // Semi-transparent for modern look
    },
    border: {
      color: normalizeColor(containerColor),
      width: 1.5,
      alpha: 0.4
    },
    rectRadius: containerStyle === 'rounded-square' ? 0.2 : undefined,
    zIndex: baseZIndex
  });
  
  // 2. Icon Image
  const iconData = context.iconCache.get(card.header.icon);
  if (iconData) {
    const iconSize = containerConfig.size * containerConfig.iconScale;
    const iconOffset = (containerConfig.size - iconSize) / 2;
    
    elements.push({
      type: 'image',
      data: iconData,
      x: iconX + iconOffset,
      y: iconY + iconOffset,
      w: iconSize,
      h: iconSize,
      zIndex: baseZIndex + 1
    });
  }
  
  return elements;
}

// ============================================================================
// CARD HEADER (Overline + Title + Subtitle)
// ============================================================================

function renderCardHeader(
  card: CardElement,
  context: CardRenderContext,
  baseZIndex: number
): VisualElement[] {
  const elements: VisualElement[] = [];
  const header = card.header!;
  
  const padding = 0.15;
  const containerConfig = ICON_CONTAINER_SIZES[header.iconContainer || 'circle'];
  
  // Calculate text start position
  // If icon exists, start text below it
  const hasIcon = !!header.icon && header.iconContainer !== 'none';
  let textY = card.position.y + padding;
  
  if (hasIcon) {
    textY += containerConfig.size + 0.15; // Below icon with gap
  }
  
  const textX = card.position.x + padding;
  const textW = card.position.w - (padding * 2);
  
  let zIndex = baseZIndex;
  
  // 1. Overline (small caps text above title)
  if (header.overline) {
    elements.push({
      type: 'text',
      content: header.overline.toUpperCase(),
      x: textX,
      y: textY,
      w: textW,
      h: 0.25,
      fontSize: TYPOGRAPHY.overline.size,
      color: normalizeColor(context.palette.textMuted),
      bold: true,
      align: 'left',
      zIndex: zIndex++
    });
    textY += 0.22; // Move down for title
  }
  
  // 2. Title
  elements.push({
    type: 'text',
    content: header.title,
    x: textX,
    y: textY,
    w: textW,
    h: 0.35,
    fontSize: TYPOGRAPHY.title.size,
    color: normalizeColor(context.palette.text),
    bold: true,
    align: 'left',
    zIndex: zIndex++
  });
  textY += 0.35;
  
  // 3. Subtitle (optional)
  if (header.subtitle) {
    elements.push({
      type: 'text',
      content: header.subtitle,
      x: textX,
      y: textY,
      w: textW,
      h: 0.3,
      fontSize: TYPOGRAPHY.subtitle.size,
      color: normalizeColor(context.palette.textMuted),
      bold: false,
      align: 'left',
      zIndex: zIndex++
    });
  }
  
  return elements;
}

// ============================================================================
// CARD BODY
// ============================================================================

function renderCardBody(
  card: CardElement,
  context: CardRenderContext,
  zIndex: number
): VisualElement {
  const padding = 0.15;
  
  // Calculate body position (after header)
  // This is a simplified calculation; real implementation would measure header height
  const bodyY = card.position.y + card.position.h * 0.55;
  
  return {
    type: 'text',
    content: card.body || '',
    x: card.position.x + padding,
    y: bodyY,
    w: card.position.w - (padding * 2),
    h: card.position.h * 0.35,
    fontSize: TYPOGRAPHY.body.size,
    color: normalizeColor(context.palette.textMuted),
    bold: false,
    align: 'left',
    zIndex
  };
}

// ============================================================================
// GLOW EFFECT
// ============================================================================

function createGlowEffect(
  card: CardElement,
  zIndex: number
): VisualElement {
  // Create a larger, blurred shape behind the card
  const spread = 0.1;
  
  return {
    type: 'shape',
    shapeType: 'roundRect',
    x: card.position.x - spread,
    y: card.position.y - spread,
    w: card.position.w + (spread * 2),
    h: card.position.h + (spread * 2),
    fill: {
      color: normalizeColor(card.glowColor || '38BDF8'),
      alpha: 0.15
    },
    rectRadius: 0.2,
    zIndex
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Safely lightens a hex color by a given amount.
 * Handles edge cases: invalid hex, NaN, empty strings.
 * @param hex - Hex color string (with or without #)
 * @param amount - Amount to lighten (0-1)
 * @returns Uppercase 6-digit hex string
 */
function lightenColor(hex: string, amount: number): string {
  // Validate inputs
  if (!hex || typeof hex !== 'string') {
    return 'FFFFFF'; // Fallback to white
  }
  
  const clean = hex.replace('#', '').trim();
  
  // Handle short hex (3 chars) by expanding to 6
  let normalized = clean;
  if (clean.length === 3) {
    normalized = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
  }
  
  // Validate hex format
  if (normalized.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(normalized)) {
    console.warn(`[lightenColor] Invalid hex "${hex}", using fallback`);
    return 'FFFFFF';
  }
  
  // Clamp amount to valid range
  const safeAmount = Math.max(0, Math.min(1, amount || 0));
  
  const r = parseInt(normalized.substring(0, 2), 16);
  const g = parseInt(normalized.substring(2, 4), 16);
  const b = parseInt(normalized.substring(4, 6), 16);
  
  // Guard against NaN (shouldn't happen after regex check, but defensive)
  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    return 'FFFFFF';
  }
  
  const newR = Math.min(255, Math.max(0, r + Math.floor(255 * safeAmount)));
  const newG = Math.min(255, Math.max(0, g + Math.floor(255 * safeAmount)));
  const newB = Math.min(255, Math.max(0, b + Math.floor(255 * safeAmount)));
  
  return `${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`.toUpperCase();
}

// ============================================================================
// NARRATIVE CARD FLOW (Reference Image Pattern)
// ============================================================================

/**
 * Renders a 3-card narrative flow like the reference image:
 * [Problem/Trap] → [Insight/Mandate] → [Vision/Destination]
 * 
 * Each card has:
 * - Distinctive icon in container
 * - Two-line title (overline + main)
 * - Body text
 */
export function renderNarrativeCardFlow(
  cards: Array<{
    icon: string;
    overline: string;
    title: string;
    body: string;
    iconColor?: string;
  }>,
  position: Position, // Bounding box for all 3 cards
  context: CardRenderContext
): VisualElement[] {
  // Input validation
  if (!Array.isArray(cards) || cards.length === 0) {
    console.warn('[renderNarrativeCardFlow] Empty or invalid cards array');
    return [];
  }
  
  if (!position || typeof position.w !== 'number' || typeof position.h !== 'number') {
    console.warn('[renderNarrativeCardFlow] Invalid position object');
    return [];
  }
  
  const elements: VisualElement[] = [];
  
  const cardCount = Math.min(cards.length, 4);
  const gap = 0.2; // Gap between cards
  // Guard against division by zero (cardCount is guaranteed >= 1 after validation)
  const cardWidth = (position.w - (gap * (cardCount - 1))) / cardCount;
  
  cards.slice(0, cardCount).forEach((cardData, index) => {
    const cardElement: CardElement = {
      id: `narrative-card-${index}`,
      position: {
        x: position.x + (index * (cardWidth + gap)),
        y: position.y,
        w: cardWidth,
        h: position.h
      },
      style: 'glass',
      header: {
        icon: cardData.icon,
        iconContainer: 'circle',
        iconColor: cardData.iconColor || context.palette.primary,
        overline: cardData.overline,
        title: cardData.title
      },
      body: cardData.body,
      emphasis: 'primary'
    };
    
    elements.push(...renderCard(cardElement, {
      ...context,
      baseZIndex: context.baseZIndex + (index * 10)
    }));
  });
  
  return elements;
}
