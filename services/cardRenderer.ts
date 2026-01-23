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
// PREMIUM CARD STYLE CONSTANTS
// ============================================================================
// These styles define the visual language for premium-quality cards.
// Inspired by Apple keynote presentations and modern SaaS dashboards.
// Key principle: Subtle sophistication over flashy effects.

const CARD_STYLES: Record<CardStyle, {
  fillAlpha: number;
  borderAlpha: number;
  borderWidth: number;
  blur?: boolean;
  // Premium enhancements
  innerGlow?: { color: string; alpha: number; spread: number };
  cornerHighlight?: { alpha: number; size: number };
  shadow?: { color: string; alpha: number; offsetY: number; blur: number };
}> = {
  'glass': {
    fillAlpha: 0.08,        // Much more subtle (was 0.12)
    borderAlpha: 0.18,      // Softer border (was 0.25)
    borderWidth: 1.0,       // Thinner, more elegant (was 1.2)
    blur: true,
    // Premium: Subtle inner glow for depth
    innerGlow: { color: 'FFFFFF', alpha: 0.03, spread: 0.05 },
    // Premium: Top-left corner highlight for 3D effect
    cornerHighlight: { alpha: 0.08, size: 0.4 },
    // Premium: Soft drop shadow for elevation
    shadow: { color: '000000', alpha: 0.25, offsetY: 0.05, blur: 0.1 }
  },
  'solid': {
    fillAlpha: 0.75,        // Slightly more transparent (was 0.85)
    borderAlpha: 0.3,       // Softer border (was 0.4)
    borderWidth: 0.8,       // Thinner (was 1)
    shadow: { color: '000000', alpha: 0.15, offsetY: 0.04, blur: 0.08 }
  },
  'outline': {
    fillAlpha: 0.03,        // Almost invisible (was 0.05)
    borderAlpha: 0.4,       // Slightly less prominent (was 0.5)
    borderWidth: 1.2        // Slightly thinner (was 1.5)
  },
  'gradient': {
    fillAlpha: 0.5,         // Slightly more transparent (was 0.6)
    borderAlpha: 0.2,       // Softer border (was 0.3)
    borderWidth: 0.8,       // Thinner (was 1)
    innerGlow: { color: 'FFFFFF', alpha: 0.05, spread: 0.08 }
  },
  'elevated': {
    fillAlpha: 0.85,        // Slightly more transparent (was 0.9)
    borderAlpha: 0.15,      // Softer border (was 0.2)
    borderWidth: 0,
    shadow: { color: '000000', alpha: 0.35, offsetY: 0.08, blur: 0.15 }
  }
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

  // 0. Premium: Drop Shadow (rendered first, behind everything)
  if (style.shadow) {
    elements.push(createCardShadow(card, style.shadow, zIndex++));
  }

  // 1. Card Background
  elements.push(createCardBackground(card, style, context, zIndex++));

  // 2. Premium: Inner Glow (subtle light effect inside card)
  if (style.innerGlow) {
    elements.push(createInnerGlow(card, style.innerGlow, zIndex++));
  }

  // 3. Premium: Corner Highlight (top-left light reflection)
  if (style.cornerHighlight) {
    elements.push(createCornerHighlight(card, style.cornerHighlight, context, zIndex++));
  }

  // 4. Card Border (separate for glass effect)
  if (style.borderWidth > 0) {
    elements.push(createCardBorder(card, style, context, zIndex++));
  }

  // 5. Icon Container (if present)
  if (card.header?.icon) {
    const iconElements = renderIconContainer(
      card,
      context,
      zIndex
    );
    elements.push(...iconElements);
    zIndex += iconElements.length;
  }

  // 6. Header Text (overline + title + subtitle)
  if (card.header) {
    const headerElements = renderCardHeader(
      card,
      context,
      zIndex
    );
    elements.push(...headerElements);
    zIndex += headerElements.length;
  }

  // 7. Body Text
  if (card.body) {
    elements.push(renderCardBody(card, context, zIndex++));
  }

  // 8. Optional Glow Effect (external glow, behind card)
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
// PREMIUM CARD EFFECTS
// ============================================================================

/**
 * Creates a soft drop shadow behind the card for elevation effect.
 * Uses a slightly larger, offset rounded rect with low opacity.
 */
function createCardShadow(
  card: CardElement,
  shadow: { color: string; alpha: number; offsetY: number; blur: number },
  zIndex: number
): VisualElement {
  // Shadow is slightly larger and offset downward
  const spread = shadow.blur * 0.5;

  return {
    type: 'shape',
    shapeType: 'roundRect',
    x: card.position.x - spread * 0.5,
    y: card.position.y + shadow.offsetY,
    w: card.position.w + spread,
    h: card.position.h + spread,
    fill: {
      color: normalizeColor(shadow.color),
      alpha: shadow.alpha
    },
    rectRadius: 0.18, // Slightly larger radius for soft shadow
    zIndex
  };
}

/**
 * Creates a subtle inner glow effect for glass cards.
 * Renders as a smaller inset shape with white/light fill.
 */
function createInnerGlow(
  card: CardElement,
  glow: { color: string; alpha: number; spread: number },
  zIndex: number
): VisualElement {
  // Inner glow is inset from the card edges
  const inset = glow.spread;

  return {
    type: 'shape',
    shapeType: 'roundRect',
    x: card.position.x + inset,
    y: card.position.y + inset,
    w: card.position.w - (inset * 2),
    h: card.position.h - (inset * 2),
    fill: {
      color: normalizeColor(glow.color),
      alpha: glow.alpha
    },
    rectRadius: 0.12, // Slightly smaller radius for inner shape
    zIndex
  };
}

/**
 * Creates a top-left corner highlight for 3D glass effect.
 * Mimics light reflecting off the surface.
 */
function createCornerHighlight(
  card: CardElement,
  highlight: { alpha: number; size: number },
  context: CardRenderContext,
  zIndex: number
): VisualElement {
  // Highlight is positioned in the top-left corner
  const highlightSize = Math.min(card.position.w, card.position.h) * highlight.size;

  return {
    type: 'shape',
    shapeType: 'roundRect',
    x: card.position.x + 0.05,
    y: card.position.y + 0.05,
    w: highlightSize,
    h: highlightSize * 0.3, // Narrow horizontal highlight
    fill: {
      color: 'FFFFFF',
      alpha: highlight.alpha
    },
    rectRadius: 0.08,
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

// Premium typography constants for card headers
const CARD_PREMIUM_TYPOGRAPHY = {
  overline: {
    size: 10,
    letterSpacing: 1.5,  // Spread for category labels
    fontWeight: 600,
    lineHeight: 1.2
  },
  title: {
    size: 18,
    letterSpacing: 0.3,
    fontWeight: 700,
    lineHeight: 1.15
  },
  subtitle: {
    size: 14,
    letterSpacing: 0,
    fontWeight: 400,
    lineHeight: 1.3
  }
};

function renderCardHeader(
  card: CardElement,
  context: CardRenderContext,
  baseZIndex: number
): VisualElement[] {
  const elements: VisualElement[] = [];
  const header = card.header!;

  const padding = 0.18; // Slightly more padding for breathing room
  const containerConfig = ICON_CONTAINER_SIZES[header.iconContainer || 'circle'] || ICON_CONTAINER_SIZES['circle'];

  // Calculate text start position
  // If icon exists, start text below it
  const hasIcon = !!header.icon && header.iconContainer !== 'none';
  let textY = card.position.y + padding;

  if (hasIcon) {
    textY += containerConfig.size + 0.18; // Below icon with generous gap
  }

  const textX = card.position.x + padding;
  const textW = card.position.w - (padding * 2);

  let zIndex = baseZIndex;

  // 1. Overline (small caps text above title) - PREMIUM TYPOGRAPHY
  if (header.overline) {
    elements.push({
      type: 'text',
      content: header.overline.toUpperCase(),
      x: textX,
      y: textY,
      w: textW,
      h: 0.25,
      fontSize: CARD_PREMIUM_TYPOGRAPHY.overline.size,
      color: normalizeColor(context.palette.textMuted),
      bold: true,
      align: 'left',
      zIndex: zIndex++,
      letterSpacing: CARD_PREMIUM_TYPOGRAPHY.overline.letterSpacing,
      fontWeight: CARD_PREMIUM_TYPOGRAPHY.overline.fontWeight,
      textTransform: 'uppercase'
    });
    textY += 0.26; // Slightly more space after overline
  }

  // 2. Title - PREMIUM TYPOGRAPHY
  elements.push({
    type: 'text',
    content: header.title,
    x: textX,
    y: textY,
    w: textW,
    h: 0.4, // Taller for larger title
    fontSize: CARD_PREMIUM_TYPOGRAPHY.title.size,
    color: normalizeColor(context.palette.text),
    bold: true,
    align: 'left',
    zIndex: zIndex++,
    letterSpacing: CARD_PREMIUM_TYPOGRAPHY.title.letterSpacing,
    fontWeight: CARD_PREMIUM_TYPOGRAPHY.title.fontWeight,
    lineHeight: CARD_PREMIUM_TYPOGRAPHY.title.lineHeight
  });
  textY += 0.4;

  // 3. Subtitle (optional) - PREMIUM TYPOGRAPHY
  if (header.subtitle) {
    elements.push({
      type: 'text',
      content: header.subtitle,
      x: textX,
      y: textY,
      w: textW,
      h: 0.3,
      fontSize: CARD_PREMIUM_TYPOGRAPHY.subtitle.size,
      color: normalizeColor(context.palette.textMuted),
      bold: false,
      align: 'left',
      zIndex: zIndex++,
      letterSpacing: CARD_PREMIUM_TYPOGRAPHY.subtitle.letterSpacing,
      fontWeight: CARD_PREMIUM_TYPOGRAPHY.subtitle.fontWeight,
      lineHeight: CARD_PREMIUM_TYPOGRAPHY.subtitle.lineHeight
    });
  }

  return elements;
}

// ============================================================================
// CARD BODY
// ============================================================================

// Premium body typography constants
const CARD_BODY_TYPOGRAPHY = {
  size: 13,
  letterSpacing: 0,
  fontWeight: 400,
  lineHeight: 1.45  // Comfortable reading
};

function renderCardBody(
  card: CardElement,
  context: CardRenderContext,
  zIndex: number
): VisualElement {
  const padding = 0.18; // Consistent premium padding

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
    fontSize: CARD_BODY_TYPOGRAPHY.size,
    color: normalizeColor(context.palette.textMuted),
    bold: false,
    align: 'left',
    zIndex,
    lineHeight: CARD_BODY_TYPOGRAPHY.lineHeight,
    fontWeight: CARD_BODY_TYPOGRAPHY.fontWeight
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
