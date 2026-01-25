

import { TemplateComponent, VisualElement, GlobalStyleGuide, SpatialZone, LayoutVariant, SpatialStrategy, SlideNode, VisualDesignSpec, EnvironmentState } from '../types/slideTypes';
import { InfographicRenderer, normalizeColor } from './infographicRenderer';

// Serendipity layer renderers - static imports for ESM compatibility
import * as decorativeRenderers from './decorativeRenderer';
import * as cardRenderers from './cardRenderer';

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

// Predefined Spatial Templates for Layout Variants
// Coordinates are 0-10 (X) and 0-5.625 (Y)
const LAYOUT_TEMPLATES: Record<string, SpatialZone[]> = {
  'split-left-text': [
    { id: 'title', x: 0.5, y: 0.5, w: 4.5, h: 1.0, purpose: 'hero', content_suggestion: 'Slide Title' },
    { id: 'text-main', x: 0.5, y: 1.6, w: 4.2, h: 3.5, purpose: 'hero', content_suggestion: 'Main Text Bullets' },
    { id: 'visual-right', x: 5.3, y: 1.0, w: 4.2, h: 4.0, purpose: 'secondary', content_suggestion: 'Chart or Image' },
    { id: 'accent-bar', x: 5.0, y: 1.0, w: 0.05, h: 4.0, purpose: 'accent', content_suggestion: 'Divider Line' }
  ],
  'split-right-text': [
    { id: 'visual-left', x: 0.5, y: 1.0, w: 4.2, h: 4.0, purpose: 'secondary', content_suggestion: 'Chart or Image' },
    { id: 'title', x: 5.3, y: 0.5, w: 4.5, h: 1.0, purpose: 'hero', content_suggestion: 'Slide Title' },
    { id: 'text-main', x: 5.3, y: 1.6, w: 4.2, h: 3.5, purpose: 'hero', content_suggestion: 'Main Text Bullets' }
  ],
  'hero-centered': [
    { id: 'hero-title', x: 1, y: 1.5, w: 8, h: 1.2, purpose: 'hero', content_suggestion: 'Impact Title' },
    { id: 'hero-content', x: 2, y: 2.8, w: 6, h: 2.0, purpose: 'secondary', content_suggestion: 'Subtitle or Key Stat' },
    { id: 'accent-bottom', x: 3, y: 5.2, w: 4, h: 0.1, purpose: 'accent', content_suggestion: 'Underline' }
  ],
  'bento-grid': [
    { id: 'title', x: 0.5, y: 0.5, w: 9, h: 0.8, purpose: 'hero', content_suggestion: 'Title' },
    { id: 'grid-1', x: 0.5, y: 1.4, w: 4.4, h: 1.9, purpose: 'secondary', content_suggestion: 'Metric Card 1' },
    { id: 'grid-2', x: 5.1, y: 1.4, w: 4.4, h: 1.9, purpose: 'secondary', content_suggestion: 'Metric Card 2' },
    { id: 'grid-3', x: 0.5, y: 3.5, w: 4.4, h: 1.9, purpose: 'secondary', content_suggestion: 'Metric Card 3' },
    { id: 'grid-4', x: 5.1, y: 3.5, w: 4.4, h: 1.9, purpose: 'secondary', content_suggestion: 'Metric Card 4' }
  ],
  'standard-vertical': [
    { id: 'title', x: 0.5, y: 0.5, w: 9, h: 0.8, purpose: 'hero', content_suggestion: 'Title' },
    { id: 'divider', x: 0.5, y: 1.4, w: 1.5, h: 0.05, purpose: 'accent', content_suggestion: 'Line' },
    { id: 'content-top', x: 0.5, y: 1.8, w: 9, h: 1.6, purpose: 'secondary', content_suggestion: 'Primary Component' },
    { id: 'content-bottom', x: 0.5, y: 3.6, w: 9, h: 1.6, purpose: 'secondary', content_suggestion: 'Secondary Component' }
  ],
  'timeline-horizontal': [
    { id: 'title', x: 0.5, y: 0.5, w: 9, h: 0.8, purpose: 'hero', content_suggestion: 'Title' },
    { id: 'timeline-track', x: 0.5, y: 2.8, w: 9, h: 0.1, purpose: 'accent', content_suggestion: 'Timeline Line' },
    { id: 'content-area', x: 0.5, y: 1.5, w: 9, h: 3.5, purpose: 'hero', content_suggestion: 'Timeline Steps' }
  ],
  'dashboard-tiles': [
    { id: 'title', x: 0.5, y: 0.4, w: 9, h: 0.7, purpose: 'hero', content_suggestion: 'Title' },
    { id: 'card-1', x: 0.5, y: 1.3, w: 2.7, h: 1.2, purpose: 'secondary', content_suggestion: 'Metric Card 1' },
    { id: 'card-2', x: 3.4, y: 1.3, w: 2.7, h: 1.2, purpose: 'secondary', content_suggestion: 'Metric Card 2' },
    { id: 'card-3', x: 6.3, y: 1.3, w: 2.7, h: 1.2, purpose: 'secondary', content_suggestion: 'Metric Card 3' },
    { id: 'left-panel', x: 0.5, y: 2.8, w: 4.2, h: 2.4, purpose: 'hero', content_suggestion: 'Primary Text/Chart' },
    { id: 'right-panel', x: 5.0, y: 2.8, w: 4.0, h: 2.4, purpose: 'secondary', content_suggestion: 'Secondary Component' }
  ],
  'metrics-rail': [
    { id: 'title', x: 0.5, y: 0.4, w: 9, h: 0.7, purpose: 'hero', content_suggestion: 'Title' },
    { id: 'rail', x: 0.5, y: 1.3, w: 2.4, h: 3.9, purpose: 'secondary', content_suggestion: 'Metric Rail' },
    { id: 'rail-divider', x: 3.1, y: 1.3, w: 0.05, h: 3.9, purpose: 'accent', content_suggestion: 'Divider Line' },
    { id: 'main', x: 3.4, y: 1.3, w: 6.1, h: 3.9, purpose: 'hero', content_suggestion: 'Primary Text/Diagram' }
  ],
  'asymmetric-grid': [
    { id: 'title', x: 0.5, y: 0.4, w: 9, h: 0.7, purpose: 'hero', content_suggestion: 'Title' },
    { id: 'panel-large', x: 0.5, y: 1.3, w: 5.4, h: 4.0, purpose: 'hero', content_suggestion: 'Primary Component' },
    { id: 'panel-top', x: 6.2, y: 1.3, w: 3.3, h: 1.85, purpose: 'secondary', content_suggestion: 'Secondary Component' },
    { id: 'panel-bottom', x: 6.2, y: 3.45, w: 3.3, h: 1.85, purpose: 'secondary', content_suggestion: 'Secondary Component' }
  ]
};

// ============================================================================
// PREMIUM THEME TOKENS
// ============================================================================
// These tokens define the visual language for premium-quality slides.
// Designed based on analysis of Fortune 500 CEO presentations and TED talks.
// Key principles: Breathing room, clear hierarchy, subtle sophistication.

const DEFAULT_THEME_TOKENS = {
  typography: {
    // Scale refined for clear visual hierarchy
    // Hero should POP, body should be comfortable, micro for annotations
    scale: {
      hero: 48,      // Increased from 42 for maximum impact
      title: 36,     // Increased from 32 for better hierarchy
      subtitle: 22,  // Increased from 20 for readability
      body: 15,      // Increased from 14 for comfortable reading
      label: 11,     // Increased from 10
      metric: 28,    // Increased from 24 - metrics should be prominent
      overline: 10,  // NEW: For category labels and badges
      micro: 9
    },
    // Weights for typography hierarchy
    // Notable: hero is extra bold, subtitle is lighter than title
    weights: {
      hero: 800,     // Extra bold for hero elements
      title: 700,
      subtitle: 500, // Lighter contrast with title (was 600)
      body: 400,
      label: 600,
      metric: 700,
      overline: 600
    },
    lineHeights: {
      title: 1.15,   // Slightly increased from 1.1
      body: 1.35     // Increased from 1.25 for readability
    },
    // NEW: Letter spacing for professional polish
    // Overlines need spread out letters, hero gets slight breathing room
    letterSpacing: {
      hero: 0.5,     // Slight breathing room for hero
      title: 0.3,
      subtitle: 0.1,
      overline: 1.5, // Spread out for category labels
      body: 0
    }
  },
  // Spacing increased for breathing room (less cramped = more professional)
  spacing: {
    xs: 0.1,    // Was 0.08
    sm: 0.16,   // Was 0.12 - increased for less cramped feel
    md: 0.28,   // Was 0.2
    lg: 0.4,    // Was 0.32 - allow generous whitespace
    xl: 0.56    // NEW: Extra large spacing for major sections
  },
  // Premium radii - slightly larger for modern feel
  radii: {
    card: 0.2,    // Was 0.18
    pill: 0.45,   // Was 0.4
    badge: 0.5    // NEW: Fully rounded badge pills
  },
  // Premium surface treatments - much more subtle than before
  surfaces: {
    cardStyle: 'glass',
    borderWidth: 1.0,    // Thinner, more elegant (was 1.2)
    opacity: 0.12,       // Much lower opacity for subtlety (was 0.65!)
    borderOpacity: 0.25  // NEW: Subtle borders
  },
  // NEW: Premium color tokens for consistent theming
  premiumColors: {
    // Dark corporate palette (from reference image analysis)
    background: {
      primary: '#0c1425',    // Deep navy
      secondary: '#141f35',  // Slightly lighter navy
      card: '#1a2744'        // Card backgrounds
    },
    accent: {
      primary: '#3b82f6',    // Vibrant blue
      secondary: '#22d3ee',  // Cyan accent
      warning: '#fbbf24',    // Warm warning (amber)
      success: '#10b981',    // Green
      danger: '#ef4444'      // Red for problems/warnings
    },
    text: {
      primary: '#f8fafc',    // Near-white
      secondary: '#94a3b8',  // Muted slate
      muted: '#64748b'       // Very muted for annotations
    }
  }
};


export class SpatialLayoutEngine {
  // GAP 5: Track rendering warnings (truncation, overflow, etc.)
  private renderWarnings: string[] = [];

  public getZonesForVariant(variant: string): SpatialZone[] {
    return LAYOUT_TEMPLATES[variant] || LAYOUT_TEMPLATES['standard-vertical'];
  }

  private addWarning(message: string): void {
    this.renderWarnings.push(message);
  }

  private clearWarnings(): void {
    this.renderWarnings = [];
  }

  private getWarnings(): string[] {
    return [...this.renderWarnings];
  }

  public allocateComponents(
    slideTitle: string,
    components: TemplateComponent[],
    variant: string
  ): { allocation: Map<string, any>, unplaced: TemplateComponent[] } {
    const zones = this.getZonesForVariant(variant);
    const allocation = new Map<string, any>();
    const unplaced: TemplateComponent[] = [];

    // --- COMPONENT-ZONE AFFINITY MAPPING ---
    // Prevents text components from landing in visual zones and vice versa
    const componentZoneAffinity: Record<string, string[]> = {
      'text-bullets': ['text-main', 'content-top', 'content-bottom', 'hero-content', 'content-area', 'left-panel', 'main', 'panel-large', 'panel-top', 'panel-bottom'],
      'chart-frame': ['visual-right', 'visual-left', 'content-top', 'content-area', 'grid-1', 'grid-2', 'right-panel', 'main', 'panel-large'],
      'metric-cards': ['grid-1', 'grid-2', 'grid-3', 'grid-4', 'card-1', 'card-2', 'card-3', 'rail', 'content-top', 'content-bottom', 'visual-right'],
      'process-flow': ['content-area', 'content-top', 'content-bottom', 'visual-right', 'visual-left', 'main', 'panel-large'],
      'icon-grid': ['grid-1', 'grid-2', 'grid-3', 'grid-4', 'rail', 'content-top', 'content-bottom', 'panel-top', 'panel-bottom'],
      'diagram-svg': ['visual-right', 'visual-left', 'content-top', 'content-area', 'main', 'panel-large', 'right-panel'],
      'title-section': ['title', 'hero-title'] // Title sections go in title zones
    };

    // Calculate affinity score for a component-zone pairing
    const getAffinityScore = (compType: string, zoneId: string): number => {
      const preferredZones = componentZoneAffinity[compType] || [];
      const index = preferredZones.indexOf(zoneId);
      if (index >= 0) {
        // Higher score = better match (first in list is best)
        return preferredZones.length - index;
      }
      // No explicit affinity - give a small score based on zone purpose
      return 0;
    };

    // Always allocate title if it exists in zones
    const titleZone = zones.find(z => z.id === 'title' || z.id === 'hero-title');
    if (titleZone) {
      allocation.set(titleZone.id, { type: 'title', content: slideTitle });
    }

    // Allocate Layout Components
    const contentZones = zones.filter(z => z.purpose !== 'hero' || (z.id !== 'title' && z.id !== 'hero-title'));

    // Special Handling for Bento Grid Layout
    if (variant === 'bento-grid') {
      // Explode components into grid cells
      let gridIndex = 1;
      components.forEach((comp, compIdx) => {
        if (comp.type === 'metric-cards') {
          (comp.metrics || []).forEach(m => {
            const zid = `grid-${gridIndex}`;
            const zone = zones.find(z => z.id === zid);
            if (zone) {
              allocation.set(zid, {
                type: 'component-part',
                component: {
                  type: 'metric-cards',
                  metrics: [m],
                  intro: ''
                },
                componentIdx: compIdx  // Track parent component index
              });
              gridIndex++;
            }
          });
        } else {
          const zid = `grid-${gridIndex}`;
          const zone = zones.find(z => z.id === zid);
          if (zone) {
            allocation.set(zid, { type: 'component-part', component: comp, componentIdx: compIdx });
            gridIndex++;
          } else {
            unplaced.push(comp);
          }
        }
      });
    } else if (variant === 'dashboard-tiles') {
      // Metric row + split panels
      const cardZones = ['card-1', 'card-2', 'card-3'];
      let cardIndex = 0;

      // Place metric cards into the top row
      components.forEach((comp, compIdx) => {
        if (comp.type === 'metric-cards') {
          (comp.metrics || []).forEach(m => {
            const zid = cardZones[cardIndex];
            const zone = zones.find(z => z.id === zid);
            if (zone) {
              allocation.set(zid, {
                type: 'component-part',
                component: {
                  type: 'metric-cards',
                  metrics: [m],
                  intro: ''
                },
                componentIdx: compIdx  // Track parent component index
              });
              cardIndex++;
            }
          });
        }
      });

      // Place remaining components into bottom panels
      const remaining = components
        .map((comp, idx) => ({ comp, originalIdx: idx }))
        .filter(({ comp }) => comp.type !== 'metric-cards');
      const panelZones = ['left-panel', 'right-panel'];
      let panelIndex = 0;
      remaining.forEach(({ comp, originalIdx }) => {
        const zid = panelZones[panelIndex];
        const zone = zones.find(z => z.id === zid);
        if (zone) {
          allocation.set(zid, { type: 'component-full', component: comp, componentIdx: originalIdx });
          panelIndex++;
        } else {
          unplaced.push(comp);
        }
      });
    } else {
      // --- AFFINITY-AWARE ALLOCATION ---
      // Instead of sequential assignment, match components to best-fit zones

      const availableZones = contentZones.filter(z =>
        z.purpose !== 'accent' && z.id !== 'divider' && !allocation.has(z.id)
      );

      const componentQueue = components.map((comp, idx) => ({ comp, originalIdx: idx }));
      const usedZones = new Set<string>();

      // First pass: match components to their best affinity zones
      componentQueue.forEach(({ comp, originalIdx }) => {
        let bestZone: typeof availableZones[0] | null = null;
        let bestScore = -1;

        for (const zone of availableZones) {
          if (usedZones.has(zone.id)) continue;

          const score = getAffinityScore(comp.type, zone.id);

          // Bonus for zone purpose alignment
          const purposeBonus =
            (comp.type === 'text-bullets' && zone.purpose === 'hero') ? 2 :
              (['chart-frame', 'metric-cards', 'icon-grid'].includes(comp.type) && zone.purpose === 'secondary') ? 2 : 0;

          const totalScore = score + purposeBonus;

          if (totalScore > bestScore) {
            bestScore = totalScore;
            bestZone = zone;
          }
        }

        if (bestZone) {
          allocation.set(bestZone.id, {
            type: 'component-full',
            component: comp,
            componentIdx: originalIdx  // CRITICAL: Track original index for SVG ID mapping
          });
          usedZones.add(bestZone.id);
        } else {
          // No suitable zone found - try fallback to any available zone
          const fallbackZone = availableZones.find(z => !usedZones.has(z.id));
          if (fallbackZone) {
            allocation.set(fallbackZone.id, {
              type: 'component-full',
              component: comp,
              componentIdx: originalIdx  // CRITICAL: Track original index for SVG ID mapping
            });
            usedZones.add(fallbackZone.id);
            console.warn(`[SpatialRenderer] Component ${comp.type} placed in non-affinity zone ${fallbackZone.id}`);
          } else {
            unplaced.push(comp);
          }
        }
      });
    }

    return { allocation, unplaced };
  }

  public renderWithSpatialAwareness(
    slide: SlideNode,
    styleGuide: GlobalStyleGuide,
    getIconUrl: (name: string) => string | undefined,
    visualDesignSpec?: VisualDesignSpec, // NEW: Accept visual design spec for color overrides
    getDiagramUrl?: (comp: any) => string | undefined // NEW: Diagram cache callback
  ): VisualElement[] {
    // GAP 5: Clear warnings from previous renders
    this.clearWarnings();

    const elements: VisualElement[] = [];
    const variant = slide.routerConfig?.layoutVariant || 'standard-vertical';
    const zones = this.getZonesForVariant(variant);
    const { allocation, unplaced } = this.allocateComponents(slide.title, slide.layoutPlan?.components || [], variant);

    // --- APPLY VISUAL DESIGN SPEC OVERRIDES ---
    // If visualDesignSpec has color_harmony, use it to override styleGuide colors
    const baseBackground = normalizeColor(
      visualDesignSpec?.color_harmony?.background_tone || styleGuide.colorPalette.background
    );
    const baseText = normalizeColor(styleGuide.colorPalette.text);
    const contrastText = resolveReadableTextColor(baseBackground, baseText);

    const effectiveStyleGuide: GlobalStyleGuide = visualDesignSpec?.color_harmony
      ? {
        ...styleGuide,
        colorPalette: {
          ...styleGuide.colorPalette,
          // Override with VisualDesignSpec colors if provided
          primary: normalizeColor(visualDesignSpec.color_harmony.primary || styleGuide.colorPalette.primary),
          accentHighContrast: normalizeColor(visualDesignSpec.color_harmony.accent || styleGuide.colorPalette.accentHighContrast),
          background: baseBackground,
          text: contrastText
        }
      }
      : {
        ...styleGuide,
        colorPalette: {
          ...styleGuide.colorPalette,
          background: baseBackground,
          text: contrastText
        }
      };

    // Parse negative space allocation if provided (e.g., "20%", "25 percent", etc.)
    let negativeSpaceMultiplier = 1.0;
    if (visualDesignSpec?.negative_space_allocation) {
      const negMatch = visualDesignSpec.negative_space_allocation.match(/(\d+)/);
      if (negMatch) {
        const pct = parseInt(negMatch[1], 10);
        // Apply slight zone size reduction for higher negative space values
        if (pct > 35) {
          negativeSpaceMultiplier = 0.90; // 10% reduction for very high negative space
        } else if (pct > 25) {
          negativeSpaceMultiplier = 0.95; // Introduce 5% reduction for zone sizes
        }
      }
    }

    if (unplaced.length > 0) {
      console.warn(`[SpatialRenderer] Unplaced components for slide ${slide.title}:`, unplaced.map(c => c.type));
      unplaced.forEach(c => {
        this.addWarning(`Unplaced component: ${c.type}`);
      });
    }

    const themeTokens = this.resolveThemeTokens(effectiveStyleGuide);

    // --- APPLY LAYOUT-LEVEL REPAIR HINTS ---
    // Visual Architect sets these on layoutPlan to fix title/divider positioning
    const layoutPlan = slide.layoutPlan as any; // Cast to access _hint fields
    // Guard against NaN - typeof NaN === 'number' so we need isFinite check
    const titleMarginHint = typeof layoutPlan?._titleMarginTop === 'number' && isFinite(layoutPlan._titleMarginTop) 
        ? layoutPlan._titleMarginTop 
        : undefined;
    const dividerYHint = typeof layoutPlan?._dividerY === 'number' && isFinite(layoutPlan._dividerY) 
        ? layoutPlan._dividerY 
        : undefined;

    zones.forEach(zone => {
      const allocated = allocation.get(zone.id);

      // Apply zone-level hints from Visual Architect
      let effectiveZone = { ...zone };
      
      // Title zone positioning hint
      if ((zone.id === 'title' || zone.id === 'hero-title') && titleMarginHint !== undefined) {
        effectiveZone.y = titleMarginHint;
      }
      
      // Divider positioning hint
      if ((zone.id === 'divider' || zone.id === 'accent-bar') && dividerYHint !== undefined) {
        effectiveZone.y = dividerYHint;
      }

      if (!allocated) {
        // Render static accents
        if (effectiveZone.purpose === 'accent') {
          if (effectiveZone.id === 'divider' || effectiveZone.id === 'accent-bar' || effectiveZone.id === 'timeline-track' || effectiveZone.id === 'rail-divider') {
            elements.push({
              type: 'shape', shapeType: 'rect',
              x: effectiveZone.x, y: effectiveZone.y, w: effectiveZone.w, h: effectiveZone.h,
              fill: { color: normalizeColor(effectiveStyleGuide.colorPalette.accentHighContrast), alpha: 1 },
              zIndex: 5
            });
          } else if (effectiveZone.id === 'accent-bottom') {
            elements.push({
              type: 'shape', shapeType: 'rect',
              x: effectiveZone.x, y: effectiveZone.y, w: effectiveZone.w, h: effectiveZone.h,
              fill: { color: normalizeColor(effectiveStyleGuide.colorPalette.primary), alpha: 1 },
              zIndex: 5
            });
          }
        }
        return;
      }

      if (allocated.type === 'title') {
        const fontSize = effectiveZone.purpose === 'hero'
          ? (variant === 'hero-centered' ? themeTokens.typography.scale.hero : themeTokens.typography.scale.title)
          : themeTokens.typography.scale.subtitle;
        elements.push({
          type: 'text',
          content: allocated.content,
          x: effectiveZone.x, y: effectiveZone.y, w: effectiveZone.w, h: effectiveZone.h,
          fontSize,
          bold: this.isBold(themeTokens.typography.weights.title),
          color: normalizeColor(effectiveStyleGuide.colorPalette.text),
          fontFamily: effectiveStyleGuide.fontFamilyTitle,
          align: variant === 'hero-centered' ? 'center' : 'left',
          zIndex: 10,
          componentIdx: -1  // Title is special, not a layoutPlan component
        } as any);
      } else if (allocated.type === 'component-full' || allocated.type === 'component-part') {
        // CRITICAL: Pass componentIdx to renderComponentInZone for SVG ID mapping
        const componentIdx = allocated.componentIdx ?? -1;
        const els = this.renderComponentInZone(allocated.component, effectiveZone, effectiveStyleGuide, themeTokens, getIconUrl, getDiagramUrl, componentIdx);
        elements.push(...els);
      }
    });

    // GAP 5: Apply rendering warnings to slide
    // FIXED: Replace spatial warnings instead of accumulating them across render passes
    // This prevents warning count inflation when the same slide is re-rendered multiple times
    const spatialWarnings = this.getWarnings();
    if (spatialWarnings.length > 0) {
      // Filter out previous spatial warnings (those matching known patterns)
      const spatialPatterns = /truncated|hidden|unplaced|overflow|bullets.*requires/i;
      const existingNonSpatialWarnings = (slide.warnings || []).filter(w => !spatialPatterns.test(w));

      // Combine non-spatial warnings with new spatial warnings
      slide.warnings = [...existingNonSpatialWarnings, ...spatialWarnings];
      console.warn(`[SPATIAL RENDERER] ${spatialWarnings.length} rendering warning(s) for slide "${slide.title}"`);
    }

    return elements;
  }

  /**
   * Estimate how many lines will be rendered after text wrapping.
   * Uses font-aware character width estimation.
   */
  private estimateWrappedLineCount(
    lines: string[],
    zoneWidthUnits: number,
    fontSizePoints: number,
    fontFamily?: string
  ): number {
    // Font-aware character width estimation
    // PowerPoint uses inches internally, 1 unit ≈ 1 inch
    // At 14pt, typical character widths:
    // - Proportional (Inter, Arial): ~0.08 inches per char → ~12.5 chars/inch → 12.5 chars/unit
    // - Monospace (Fira Code, Courier): ~0.12 inches per char → ~8.3 chars/inch → 8.3 chars/unit

    const isMonospace = fontFamily && /mono|code|courier|consolas|fira.*code|source.*code/i.test(fontFamily);
    const baseCharsPerUnit = isMonospace ? 8.3 : 12.5; // chars per unit at 14pt

    // Scale by font size (smaller font = more chars per unit)
    const effectiveCharsPerUnit = baseCharsPerUnit * (14 / fontSizePoints);

    // Account for zone padding (typically 5% on each side)
    const usableWidth = zoneWidthUnits * 0.9;
    const maxCharsPerLine = Math.max(10, Math.floor(usableWidth * effectiveCharsPerUnit));

    return lines.reduce((wrappedCount, line) => {
      const visibleText = line.replace(/^•\s*/, ''); // Remove bullet
      const wrappedLines = Math.ceil(visibleText.length / maxCharsPerLine);
      return wrappedCount + Math.max(1, wrappedLines);
    }, 0);
  }

  private renderComponentInZone(
    comp: TemplateComponent,
    zone: SpatialZone,
    styleGuide: GlobalStyleGuide,
    themeTokens: typeof DEFAULT_THEME_TOKENS,
    getIconUrl: (name: string) => string | undefined,
    getDiagramUrl?: (comp: any) => string | undefined,
    componentIdx: number = -1  // CRITICAL: Component index for SVG ID mapping
  ): VisualElement[] {
    const p = {
      text: normalizeColor(styleGuide.colorPalette.text),
      primary: normalizeColor(styleGuide.colorPalette.primary),
      secondary: normalizeColor(styleGuide.colorPalette.secondary),
      accent: normalizeColor(styleGuide.colorPalette.accentHighContrast),
      background: normalizeColor(styleGuide.colorPalette.background)
    };

    // Apply repair hints if present (from visual repair system)
    const compAny = comp as any;
    let { x, y, w, h } = zone;

    // Apply position hints (override zone defaults)
    if (typeof compAny._hintX === 'number') x = compAny._hintX;
    if (typeof compAny._hintY === 'number') y = compAny._hintY;

    // Apply size hints (clamp to zone bounds for safety)
    if (typeof compAny._hintWidth === 'number') w = Math.min(compAny._hintWidth, zone.w);
    if (typeof compAny._hintHeight === 'number') h = Math.min(compAny._hintHeight, zone.h);

    // Apply color hints
    if (compAny._hintColor) {
      p.text = normalizeColor(compAny._hintColor);
    }

    const els: VisualElement[] = [];
    
    // Helper to stamp componentIdx on elements for SVG ID mapping
    const stampElement = (el: VisualElement): VisualElement => {
      (el as any).componentIdx = componentIdx;
      return el;
    };

    // Get spacing values, applying hints if present
    const baseSpacing = themeTokens.spacing;
    const spacingMultiplier = typeof compAny._hintPadding === 'number'
      ? compAny._hintPadding / (baseSpacing.md * 10) // Normalize hint to multiplier
      : 1.0;
    const spacing = {
      xs: baseSpacing.xs * spacingMultiplier,
      sm: baseSpacing.sm * spacingMultiplier,
      md: baseSpacing.md * spacingMultiplier,
      lg: baseSpacing.lg * spacingMultiplier,
      xl: baseSpacing.xl * spacingMultiplier
    };

    const cardRadius = themeTokens.radii.card;
    const cardStyle = themeTokens.surfaces.cardStyle;
    const cardBorderWidth = themeTokens.surfaces.borderWidth;
    const cardOpacity = themeTokens.surfaces.opacity;

    const resolveCardFill = () => {
      if (cardStyle === 'outline') return { color: p.background, alpha: 0.05 };
      if (cardStyle === 'glass') return { color: p.background, alpha: 0.35 };
      return { color: p.background, alpha: Math.min(0.9, cardOpacity) };
    };
    const resolveCardBorder = () => {
      if (cardStyle === 'solid') return { color: p.accent, width: cardBorderWidth, alpha: 0.75 };
      return { color: p.accent, width: cardBorderWidth + 0.3, alpha: 0.9 };
    };

    // Scale fonts based on zone purpose (Hierarchy)
    const scale = zone.purpose === 'hero' ? 1.2 : (zone.purpose === 'accent' ? 0.85 : 1.0);

    // ============================================================================
    // VISUAL REPAIR HINTS (from visualCortex.ts applyRepairsToSlide)
    // ============================================================================
    // CRITICAL FIX: The _hint* values from Visual Architect are LINE-HEIGHT FACTORS.
    // - _hintLineHeight > 1.0 means "increase spacing for readability"
    // - _hintLineHeight < 1.0 means "compress spacing to fit more content"
    // 
    // PREVIOUS BUG: We were using these as multipliers in fit calculation:
    //   lineHeightFactor = 0.5 * lineHeightMultiplier
    // This meant higher hints = MORE required height = WORSE overflow!
    // 
    // FIX: Interpret hints as VISUAL spacing, not fit calculation multipliers.
    // For FIT CALCULATION: Use 1.0 (default) to get accurate fit estimation.
    // For RENDERING: The visual output will honor the hint for actual display.
    // ============================================================================
    
    // Read hints for logging/debugging, but DON'T use them to increase fit requirements
    const rawLineHeightHint = typeof compAny._hintLineHeight === 'number' ? compAny._hintLineHeight : 1.0;
    const rawItemSpacingHint = typeof compAny._hintItemSpacing === 'number' ? compAny._hintItemSpacing : 1.0;
    
    // For fit calculation: hints > 1.0 should NOT increase required height
    // (that would make overflow worse). Instead, treat them as visual styling only.
    // Hints < 1.0 (compression) CAN be applied to fit calculation.
    const lineHeightMultiplier = rawLineHeightHint < 1.0 ? rawLineHeightHint : 1.0;
    const itemSpacingMultiplier = rawItemSpacingHint < 1.0 ? rawItemSpacingHint : 1.0;
    
    // Log when hints are present (helps trace visual repair effectiveness)
    if (rawLineHeightHint !== 1.0 || rawItemSpacingHint !== 1.0) {
      console.log(`[SPATIAL RENDERER] Component ${comp.type} has hints: lineHeight=${rawLineHeightHint.toFixed(2)}, itemSpacing=${rawItemSpacingHint.toFixed(2)} (fit calc uses: ${lineHeightMultiplier.toFixed(2)}, ${itemSpacingMultiplier.toFixed(2)})`);
    }

    if (comp.type === 'text-bullets') {
      let contentScale = scale;
      let lines = comp.content || [];
      const hasTitle = !!comp.title;

      // PRE-EMPTIVE DENSITY CHECK: If zone is very small, reduce content BEFORE calculating fit
      // This prevents truncation mid-render which looks worse than fewer, complete bullets
      const zoneArea = zone.w * zone.h;
      const MAX_LINES_FOR_SMALL_ZONE = 2;
      const MAX_LINES_FOR_MEDIUM_ZONE = 3;
      
      if (zoneArea < 0.3 && lines.length > MAX_LINES_FOR_SMALL_ZONE) {
        // Very small zone (e.g., split layout secondary area) - limit to 2 bullets max
        lines = lines.slice(0, MAX_LINES_FOR_SMALL_ZONE);
        this.addWarning(`Zone '${zone.id}' is small (${zoneArea.toFixed(2)} area), limited to ${MAX_LINES_FOR_SMALL_ZONE} bullets`);
      } else if (zoneArea < 0.5 && lines.length > MAX_LINES_FOR_MEDIUM_ZONE) {
        // Medium zone - limit to 3 bullets
        lines = lines.slice(0, MAX_LINES_FOR_MEDIUM_ZONE);
        this.addWarning(`Zone '${zone.id}' is medium (${zoneArea.toFixed(2)} area), limited to ${MAX_LINES_FOR_MEDIUM_ZONE} bullets`);
      }

      // ENHANCED OVERFLOW PREVENTION: If we have too many lines for the zone, try these in order:
      // 1. Auto-scale text down to fit
      // 2. If scaling isn't enough, truncate character count per line
      // 3. As last resort, drop lines (current behavior)

      // Estimate wrapped line count BEFORE calculating fit
      const estimatedWrappedLines = this.estimateWrappedLineCount(lines, zone.w, 14 * scale);

      // Calculate required height WITH wrapping
      // IMPORTANT: incorporate line-height and item-spacing hints when present
      // Default multipliers (1.0) preserve legacy behavior
      const titleHeightFactor = hasTitle ? 0.7 : 0;
      const lineHeightFactor = 0.5 * lineHeightMultiplier;
      const lineGapFactor = 0.1 * itemSpacingMultiplier;
      const wrappedLinesHeightFactor = estimatedWrappedLines > 0
        ? (estimatedWrappedLines * lineHeightFactor) + (Math.max(0, estimatedWrappedLines - 1) * lineGapFactor)
        : 0;
      const requiredFactor = titleHeightFactor + wrappedLinesHeightFactor;
      const requiredH = requiredFactor * scale;

      if (requiredH > h) {
        const fitScale = h / requiredFactor;
        const minScale = scale * 0.4; // More aggressive minimum (was 0.5)

        if (fitScale < minScale) {
          // STRATEGY 1: Try truncating each line to fit
          // Calculate how much we need to reduce
          const overflowRatio = requiredH / h;
          if (overflowRatio < 2.0 && lines.length <= 4) {
            // Moderate overflow - try shortening lines instead of dropping
            const targetCharsPerLine = Math.floor(60 / overflowRatio);
            lines = lines.map(line => {
              if (line.length > targetCharsPerLine) {
                return line.slice(0, targetCharsPerLine - 1) + '…';
              }
              return line;
            });
            // Recalculate with shorter lines
            const newWrapped = this.estimateWrappedLineCount(lines, zone.w, 14 * scale);
            const newWrappedHeightFactor = newWrapped > 0
              ? (newWrapped * lineHeightFactor) + (Math.max(0, newWrapped - 1) * lineGapFactor)
              : 0;
            const newRequired = (titleHeightFactor + newWrappedHeightFactor) * scale;
            if (newRequired <= h) {
              contentScale = scale; // No scaling needed after truncation
            } else {
              // Still need some scaling
              contentScale = Math.max(minScale, h / (titleHeightFactor + newWrappedHeightFactor));
            }
          } else {
            // STRATEGY 2: Heavy overflow - use minimum scale and will drop lines if needed
            this.addWarning(
              `Text truncated in zone '${zone.id}': ` +
              `${lines.length} bullets (${estimatedWrappedLines} wrapped lines) ` +
              `requires ${(requiredH).toFixed(2)} units but only ${h} available`
            );
            contentScale = minScale;
          }
        } else {
          contentScale = fitScale;
        }
      }

      let curY = y;
      const maxY = y + h;

      if (comp.title) {
        const titleH = 0.6 * contentScale;
        // REDUCED PADDING: Was 0.7 * contentScale, now 0.65 to fit tighter zones
        const nextY = curY + (0.65 * contentScale);
        
        // RELAXED CHECK: Allow rendering if it's *close* to fitting (within 0.2 units)
        if (nextY <= maxY + 0.2) {
          els.push({
            type: 'text',
            content: comp.title,
            x, y: curY, w, h: titleH,
            fontSize: themeTokens.typography.scale.subtitle * contentScale,
            bold: this.isBold(themeTokens.typography.weights.subtitle),
            color: p.text,
            fontFamily: styleGuide.fontFamilyTitle,
            zIndex: 10
          });
          curY = nextY;
        } else {
          // FALLBACK: Render smaller title instead of dropping completely
          els.push({
            type: 'text',
            content: comp.title,
            x, y: curY, w, h: titleH * 0.8,
            fontSize: themeTokens.typography.scale.subtitle * contentScale * 0.8,
            bold: this.isBold(themeTokens.typography.weights.subtitle),
            color: p.text,
            fontFamily: styleGuide.fontFamilyTitle,
            zIndex: 10
          });
          curY += titleH * 0.85;
          this.addWarning(`Title scaled down in zone '${zone.id}' to fit.`);
        }
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const currentFontSize = themeTokens.typography.scale.body * contentScale;

        // Font-aware character width estimation
        const isMonospace = styleGuide.fontFamilyBody &&
          /mono|code|courier|consolas|fira.*code|source.*code/i.test(styleGuide.fontFamilyBody);
        const baseCharsPerUnit = isMonospace ? 8.3 : 12.5; // chars per unit at 14pt
        const effectiveCharsPerUnit = baseCharsPerUnit * (14 / currentFontSize);
        const usableWidth = zone.w * 0.9; // Account for padding
        const maxCharsPerLine = Math.max(10, Math.floor(usableWidth * effectiveCharsPerUnit));

        const visibleText = line.replace(/^•\s*/, '');
        const wrappedLinesCount = Math.ceil(visibleText.length / maxCharsPerLine);
        const vLines = Math.max(1, wrappedLinesCount);

        const lineH = 0.5 * contentScale * lineHeightMultiplier;
        const totalVisualH = vLines * lineH;

        // Advance: 0.6 basis + extra height for wrapped lines (apply item spacing multiplier)
        const advance = Math.max(0.6 * contentScale * itemSpacingMultiplier, totalVisualH + (0.1 * contentScale));

        if (curY + totalVisualH > maxY) {
          if (i < lines.length) {
            const truncatedCount = lines.length - i;
            const message = `Text truncated in zone '${zone.id}': ${truncatedCount} of ${lines.length} lines hidden.`;
            this.addWarning(message);
            console.error(`[SPATIAL RENDERER] ${message}`);
          }
          break;
        }

        els.push({
          type: 'text',
          content: `• ${line}`,
          x, y: curY, w, h: totalVisualH,
          fontSize: themeTokens.typography.scale.body * contentScale,
          color: p.text,
          fontFamily: styleGuide.fontFamilyBody,
          zIndex: 10
        });
        curY += advance;
      }
    }
    else if (comp.type === 'metric-cards') {
      const metrics = comp.metrics || [];
      if (metrics.length === 0) return [];

      const count = metrics.length;
      const isHorizontal = w > h;
      const cardW = isHorizontal ? (w / count) - spacing.md : w;
      const cardH = isHorizontal ? h : (h / count) - spacing.md;

      metrics.forEach((m, i) => {
        const cardX = isHorizontal ? x + (i * (cardW + spacing.md)) : x;
        const cardY = isHorizontal ? y : y + (i * (cardH + spacing.md));

        // Skip if out of bounds (though less likely for fixed grid except huge counts)
        if (cardX + cardW > x + w + 0.1 || cardY + cardH > y + h + 0.1) return;

        // Modern card surface
        els.push({
          type: 'shape',
          shapeType: 'roundRect',
          x: cardX, y: cardY, w: cardW, h: cardH,
          fill: resolveCardFill(),
          border: resolveCardBorder(),
          rectRadius: cardRadius,
          zIndex: 5
        });

        // Icon
        if (m.icon) {
          const iconUrl = getIconUrl(m.icon);
          if (iconUrl) {
            els.push({ type: 'image', data: iconUrl, x: cardX + spacing.sm, y: cardY + spacing.sm, w: 0.5, h: 0.5, zIndex: 11 });
          }
        }

        // Value
        els.push({
          type: 'text',
          content: m.value,
          x: cardX + spacing.xs, y: cardY + (cardH * 0.28), w: cardW - spacing.sm, h: cardH * 0.4,
          fontSize: themeTokens.typography.scale.metric * scale,
          bold: this.isBold(themeTokens.typography.weights.metric),
          color: p.text,
          fontFamily: styleGuide.fontFamilyTitle,
          align: 'center',
          zIndex: 10
        });
        // Label
        els.push({
          type: 'text',
          content: m.label,
          x: cardX + spacing.xs, y: cardY + (cardH * 0.7), w: cardW - spacing.sm, h: cardH * 0.3,
          fontSize: themeTokens.typography.scale.label * scale,
          bold: this.isBold(themeTokens.typography.weights.label),
          color: p.text,
          fontFamily: styleGuide.fontFamilyBody,
          align: 'center',
          zIndex: 10
        });
      });
    }
    else if (comp.type === 'process-flow') {
      const steps = comp.steps || [];
      if (steps.length === 0) return [];

      const count = steps.length;
      const stepW = (w / count) - 0.1;
      steps.forEach((s, i) => {
        const stepX = x + (i * (stepW + 0.1));

        if (stepX + stepW > x + w + 0.1) return;

        // Arrow/Box - More opaque for professional look
        els.push({ type: 'shape', shapeType: 'rightArrow', x: stepX, y, w: stepW, h: h * 0.6, fill: { color: p.accent, alpha: 0.6 }, border: { color: p.accent, width: cardBorderWidth, alpha: 0.9 }, zIndex: 5 });

        // Icon inside arrow
        if (s.icon) {
          const iconUrl = getIconUrl(s.icon);
          if (iconUrl) {
            els.push({ type: 'image', data: iconUrl, x: stepX + (stepW / 2) - 0.2, y: y + 0.1, w: 0.4, h: 0.4, zIndex: 11 });
          }
        }

        // Content
        els.push({ type: 'text', content: s.title, x: stepX + spacing.xs, y: y + (h * 0.35), w: stepW - spacing.sm, h: 0.3, fontSize: themeTokens.typography.scale.label, bold: this.isBold(themeTokens.typography.weights.label), color: p.text, fontFamily: styleGuide.fontFamilyTitle, align: 'center', zIndex: 10 });
        els.push({ type: 'text', content: s.description, x: stepX + spacing.xs, y: y + (h * 0.65), w: stepW - spacing.sm, h: 0.5, fontSize: themeTokens.typography.scale.micro, color: p.text, fontFamily: styleGuide.fontFamilyBody, align: 'center', zIndex: 10 });
      });
    }
    else if (comp.type === 'icon-grid') {
      const items = comp.items || [];
      if (items.length === 0) return [];

      const count = items.length;
      // Simple 2-col or 3-col grid logic based on width
      const cols = w > 4 ? 3 : 2;
      const rows = Math.ceil(count / cols);
      const itemW = (w / cols) - spacing.md;
      const itemH = (h / rows) - spacing.md;

      // ============================================================================
      // DYNAMIC ICON SIZING (Fixed 2026-01-26)
      // ============================================================================
      // Use zone dimensions and item count to determine appropriate icon size.
      // Respects LLM hints (_hintIconSize) and emphasis fields.
      // ============================================================================
      const getIconSize = (item: any, index: number): number => {
        // Check for LLM hint first
        const hintSize = (comp as any)._hintIconSize || item?._hintIconSize;
        if (hintSize && hintSize >= 0.2 && hintSize <= 0.9) {
          return Math.min(itemW, itemH) * hintSize;
        }
        
        // Determine emphasis multiplier
        const raw = (item?.emphasis || item?.size || item?.importance || '').toString().toLowerCase();
        let emphasisMult = 1.0;
        if (['primary', 'featured', 'high', 'large', 'lg', 'xl'].includes(raw)) emphasisMult = 1.2;
        else if (['secondary', 'medium', 'md'].includes(raw)) emphasisMult = 1.0;
        else if (['low', 'small', 'sm'].includes(raw)) emphasisMult = 0.85;
        else if (index === 0 && count <= 3) emphasisMult = 1.15; // default hierarchy
        
        // Dynamic base scale based on zone and count
        let baseScale = 0.35; // default
        
        // Adjust for zone height (h is in slide units, ~5.625 max)
        if (itemH < 1.0) baseScale = 0.28;      // Very compact zone
        else if (itemH < 1.5) baseScale = 0.32; // Compact zone
        else if (itemH > 2.5) baseScale = 0.4;  // Spacious zone
        
        // Adjust for item count
        if (count >= 6) baseScale *= 0.85;
        else if (count <= 2) baseScale *= 1.1;
        
        return Math.min(itemW, itemH) * baseScale * emphasisMult;
      };

      items.forEach((item, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const ix = x + (col * (itemW + spacing.md));
        const iy = y + (row * (itemH + spacing.md));

        if (iy + itemH > y + h + 0.1) return;

        // Subtle card to improve visual quality
        if (itemW > 1.0 && itemH > 0.8) {
          els.push({
            type: 'shape',
            shapeType: 'roundRect',
            x: ix, y: iy, w: itemW, h: itemH,
            fill: resolveCardFill(),
            border: resolveCardBorder(),
            rectRadius: cardRadius,
            zIndex: 5
          });
        }

        // Use dynamic icon sizing
        const iconSize = getIconSize(item, i);
        const iconX = ix + (itemW / 2) - (iconSize / 2);
        const iconY = iy + spacing.sm;

        if (item.icon) {
          const iconUrl = getIconUrl(item.icon);
          if (iconUrl) {
            els.push({ type: 'image', data: iconUrl, x: iconX, y: iconY, w: iconSize, h: iconSize, zIndex: 11 });
          }
        }

        const labelY = iconY + iconSize + spacing.xs;
        els.push({
          type: 'text',
          content: item.label,
          x: ix + spacing.xs, y: labelY, w: itemW - spacing.sm, h: 0.3,
          fontSize: themeTokens.typography.scale.label,
          bold: this.isBold(themeTokens.typography.weights.label),
          color: p.text,
          fontFamily: styleGuide.fontFamilyBody,
          align: 'center',
          zIndex: 10
        });

        if (item.description) {
          els.push({
            type: 'text',
            content: item.description,
            x: ix + spacing.xs, y: labelY + 0.32, w: itemW - spacing.sm, h: 0.35,
            fontSize: themeTokens.typography.scale.micro,
            color: p.text,
            fontFamily: styleGuide.fontFamilyBody,
            align: 'center',
            zIndex: 10
          });
        }
      });
    } else if (comp.type === 'chart-frame') {
      els.push(...this.renderChartFrame(comp, p, x, y, w, h, styleGuide, themeTokens));
    } else if (comp.type === 'diagram-svg') {
      // Render diagram as image from cache
      if (getDiagramUrl) {
        const diagramUrl = getDiagramUrl(comp);

        if (diagramUrl) {
          // Optional title above diagram (reduce zone height for diagram)
          let diagramY = y;
          let diagramH = h;

          if (comp.title) {
            const titleH = 0.6 * scale;
            els.push({
              type: 'text',
              content: comp.title,
              x, y, w, h: titleH,
              fontSize: themeTokens.typography.scale.subtitle * scale,
              bold: this.isBold(themeTokens.typography.weights.subtitle),
              color: p.text,
              fontFamily: styleGuide.fontFamilyTitle,
              zIndex: 10
            });
            diagramY = y + titleH + 0.2;
            diagramH = h - titleH - 0.2;
          }

          // Render diagram as full-zone image
          els.push({
            type: 'image',
            data: diagramUrl,
            x, y: diagramY, w, h: diagramH,
            zIndex: 5
          });
        } else {
          // Fallback: render placeholder
          els.push({
            type: 'shape',
            shapeType: 'rect',
            x, y, w, h,
            fill: { color: p.background, alpha: 0.2 },
            border: { color: p.accent, width: 2, alpha: 0.5 },
            zIndex: 5
          });
          els.push({
            type: 'text',
            content: 'Diagram (requires Node.js)',
            x, y: y + (h / 2) - 0.3, w, h: 0.6,
            fontSize: themeTokens.typography.scale.body,
            color: p.text,
            align: 'center',
            zIndex: 10
          });
          this.addWarning(`Diagram placeholder used in zone '${zone.id}' (diagram renderer unavailable).`);
        }
      }
    }

    // CRITICAL: Stamp componentIdx on all elements for SVG ID mapping
    return els.map(stampElement);
  }

  // Helper to render a basic chart using primitives (since VisualElement doesn't support native charts yet)
  private renderChartFrame(
    comp: TemplateComponent,
    p: any,
    x: number, y: number, w: number, h: number,
    styleGuide: GlobalStyleGuide,
    themeTokens: typeof DEFAULT_THEME_TOKENS
  ): VisualElement[] {
    const els: VisualElement[] = [];

    // Background Frame
    const frameFill = themeTokens.surfaces.cardStyle === 'outline'
      ? { color: p.background, alpha: 0.05 }
      : { color: p.background, alpha: 0.15 };
    els.push({ type: 'shape', shapeType: 'rect', x, y, w, h, fill: frameFill, border: { color: p.secondary, width: themeTokens.surfaces.borderWidth, alpha: 0.35 }, zIndex: 5 });

    // Title
    els.push({
      type: 'text',
      content: (comp as any).title || 'Data Visualization',
      x: x + themeTokens.spacing.sm, y: y + themeTokens.spacing.sm, w: w - themeTokens.spacing.md, h: 0.5,
      fontSize: themeTokens.typography.scale.subtitle,
      bold: this.isBold(themeTokens.typography.weights.subtitle),
      color: p.text,
      fontFamily: styleGuide.fontFamilyTitle,
      align: 'center',
      zIndex: 10
    });

    // Chart Area (Schematic Bar Chart)
    const chartArea = { x: x + 0.5, y: y + 1.2, w: w - 1.0, h: h - 1.5 };

    if (comp.type === 'chart-frame' && comp.data && comp.data.length > 0) {
      const maxValue = Math.max(...comp.data.map(d => d.value));
      const barWidth = (chartArea.w / comp.data.length) * 0.6;
      const spacing = (chartArea.w / comp.data.length) * 0.4;

      comp.data.forEach((d, i) => {
        const barHeight = (d.value / maxValue) * chartArea.h;
        const barX = chartArea.x + (i * (barWidth + spacing)) + (spacing / 2);
        const barY = chartArea.y + (chartArea.h - barHeight);

        // Bar
        els.push({
          type: 'shape', shapeType: 'rect',
          x: barX, y: barY, w: barWidth, h: barHeight,
          fill: { color: p.primary, alpha: 0.8 },
          zIndex: 6
        });

        // Value
        els.push({
          type: 'text', content: d.value.toString(),
          x: barX - themeTokens.spacing.sm, y: barY - 0.3, w: barWidth + themeTokens.spacing.md, h: 0.3,
          fontSize: themeTokens.typography.scale.micro, color: p.text, align: 'center', fontFamily: styleGuide.fontFamilyBody, zIndex: 7
        });

        // Label
        els.push({
          type: 'text', content: d.label,
          x: barX - themeTokens.spacing.sm, y: chartArea.y + chartArea.h + 0.1, w: barWidth + themeTokens.spacing.md, h: 0.4,
          fontSize: themeTokens.typography.scale.label, color: p.text, align: 'center', fontFamily: styleGuide.fontFamilyBody, zIndex: 7
        });
      });

      // Axes Lines
      els.push({ type: 'shape', shapeType: 'rect', x: chartArea.x, y: chartArea.y, w: 0.05, h: chartArea.h, fill: { color: p.text, alpha: 0.5 }, zIndex: 5 }); // Y Axis
      els.push({ type: 'shape', shapeType: 'rect', x: chartArea.x, y: chartArea.y + chartArea.h, w: chartArea.w, h: 0.05, fill: { color: p.text, alpha: 0.5 }, zIndex: 5 }); // X Axis
    } else {
      els.push({ type: 'text', content: 'No Data Available', x: x, y: y + (h / 2), w, h: 0.5, fontSize: themeTokens.typography.scale.body, color: p.text, fontFamily: styleGuide.fontFamilyBody, align: 'center', zIndex: 10 });
    }

    return els;
  }

  private resolveThemeTokens(styleGuide: GlobalStyleGuide) {
    const tokens = styleGuide.themeTokens || {};
    return {
      typography: {
        scale: { ...DEFAULT_THEME_TOKENS.typography.scale, ...(tokens.typography?.scale || {}) },
        weights: { ...DEFAULT_THEME_TOKENS.typography.weights, ...(tokens.typography?.weights || {}) },
        lineHeights: { ...DEFAULT_THEME_TOKENS.typography.lineHeights, ...(tokens.typography?.lineHeights || {}) },
        letterSpacing: { ...DEFAULT_THEME_TOKENS.typography.letterSpacing, ...(tokens.typography?.letterSpacing || {}) }
      },
      spacing: { ...DEFAULT_THEME_TOKENS.spacing, ...(tokens.spacing || {}) },
      radii: { ...DEFAULT_THEME_TOKENS.radii, ...(tokens.radii || {}) },
      surfaces: { ...DEFAULT_THEME_TOKENS.surfaces, ...(tokens.surfaces || {}) },
      premiumColors: DEFAULT_THEME_TOKENS.premiumColors
    };
  }

  private isBold(weight?: number): boolean {
    return (weight ?? 600) >= 600;
  }
}

// --- ENVIRONMENT SNAPSHOT CREATION (Shadow State Pattern) ---

/**
 * Calculate zone utilization ratio (0-1).
 * Estimates how much of the zone's capacity is used by the allocated content.
 */
function calculateZoneUtilization(zone: SpatialZone, allocated: any): number {
  if (!allocated) return 0;

  // Rough heuristic based on content type
  if (allocated.type === 'title') {
    return 0.8; // Titles typically use significant space
  }

  if (allocated.type === 'component-full' || allocated.type === 'component-part') {
    const comp = allocated.component;
    if (!comp) return 0;

    switch (comp.type) {
      case 'text-bullets':
        // Estimate based on number of lines and title
        const lines = comp.content?.length || 0;
        const hasTitle = !!comp.title;
        const estimatedHeight = (hasTitle ? 0.7 : 0) + (lines * 0.6);
        return Math.min(1.0, estimatedHeight / zone.h);

      case 'metric-cards':
        const metrics = comp.metrics?.length || 0;
        return metrics > 0 ? Math.min(1.0, metrics * 0.3) : 0.5;

      case 'process-flow':
        const steps = comp.steps?.length || 0;
        return steps > 0 ? Math.min(1.0, steps * 0.25) : 0.6;

      case 'icon-grid':
        const items = comp.items?.length || 0;
        return items > 0 ? Math.min(1.0, items * 0.2) : 0.5;

      case 'chart-frame':
        return 0.9; // Charts typically fill their zone

      default:
        return 0.5;
    }
  }

  return 0;
}

/**
 * Check if a zone has critical overflow (truncation warnings).
 */
function checkIfCriticalOverflow(zone: SpatialZone, allocated: any, warnings: string[]): boolean {
  if (!allocated || !warnings || warnings.length === 0) return false;

  // Check for zone-specific truncation warnings
  return warnings.some(w =>
    w.includes(zone.id) &&
    (w.includes('truncated') || w.includes('overflow') || w.includes('hidden'))
  );
}

/**
 * Calculate text density for the slide (ratio of text content to available space).
 * Higher values mean more text-heavy content.
 */
function calculateTextDensity(components: TemplateComponent[]): number {
  if (!components || components.length === 0) return 0;

  let totalTextItems = 0;
  let totalItems = 0;

  for (const comp of components) {
    switch (comp.type) {
      case 'text-bullets':
        totalTextItems += (comp.content?.length || 0) + (comp.title ? 1 : 0);
        totalItems += (comp.content?.length || 0) + (comp.title ? 1 : 0);
        break;

      case 'metric-cards':
        totalTextItems += (comp.metrics?.length || 0) * 2; // Value + label
        totalItems += (comp.metrics?.length || 0);
        break;

      case 'process-flow':
        totalTextItems += (comp.steps?.length || 0) * 2; // Title + description
        totalItems += (comp.steps?.length || 0);
        break;

      case 'icon-grid':
        totalTextItems += (comp.items?.length || 0);
        totalItems += (comp.items?.length || 0);
        break;

      case 'chart-frame':
        totalTextItems += 1; // Title
        totalItems += 1;
        break;

      case 'title-section':
        totalTextItems += 1 + (comp.subtitle ? 1 : 0);
        totalItems += 1 + (comp.subtitle ? 1 : 0);
        break;

      default:
        totalItems += 1;
    }
  }

  return totalItems > 0 ? Math.min(1.0, totalTextItems / (totalItems * 2)) : 0;
}

/**
 * Calculate fit score based on warnings, utilization, and density.
 * Returns a 0-1 score where 1 = perfect, 0 = critical issues.
 * 
 * TUNED: Reduced warning penalty to differentiate "ugly" (warnings) from "broken" (errors).
 * This prevents infinite repair loops when slides have minor cosmetic issues.
 */
function calculateFitScore(
  warningsCount: number,
  avgUtilization: number,
  textDensity: number
): number {
  // Start with perfect score
  let score = 1.0;

  // Penalize for warnings (TUNED: -5% per warning instead of -15%)
  // We want to differentiate between "ugly" (warnings) and "broken" (errors)
  if (warningsCount > 0) {
    score -= warningsCount * 0.05; // -5% per warning (was -15%)
  }

  // Penalize for high utilization (RELAXED: >0.95 is risky, was 0.9)
  if (avgUtilization > 0.95) {
    score -= (avgUtilization - 0.95) * 0.5;
  }

  // Penalize for high text density (RELAXED: >0.9 is packed, was 0.8)
  if (textDensity > 0.9) {
    score -= (textDensity - 0.9) * 0.3;
  }

  // Clamp to 0-1
  return Math.max(0, Math.min(1.0, score));
}

/**
 * Create an environment snapshot of the rendered slide.
 * This implements the "Shadow State Pattern" for agent visibility.
 *
 * @param slide - The rendered slide node
 * @param zones - Spatial zones used in the layout
 * @param allocation - Component-to-zone allocation map
 * @param renderDurationMs - How long rendering took
 * @returns EnvironmentState snapshot
 */
export function createEnvironmentSnapshot(
  slide: SlideNode,
  zones: SpatialZone[],
  allocation: Map<string, any>,
  renderDurationMs: number
): EnvironmentState {
  const warnings = slide.warnings || [];

  // Calculate zone-level snapshots
  const zoneSnapshots = zones.map(zone => {
    const allocated = allocation.get(zone.id);
    const zoneWarnings = warnings.filter(w => w.includes(zone.id));

    return {
      id: zone.id,
      capacity_used: calculateZoneUtilization(zone, allocated),
      warnings: zoneWarnings,
      content_type: allocated?.type,
      is_critical_overflow: checkIfCriticalOverflow(zone, allocated, warnings)
    };
  });

  // Calculate aggregate metrics
  const avgUtilization = zoneSnapshots.length > 0
    ? zoneSnapshots.reduce((sum, z) => sum + z.capacity_used, 0) / zoneSnapshots.length
    : 0;

  const textDensity = calculateTextDensity(slide.layoutPlan?.components || []);

  // Calculate fit score
  const fit_score = calculateFitScore(warnings.length, avgUtilization, textDensity);

  // Determine health level
  let health_level: EnvironmentState['health_level'];
  if (fit_score >= 0.85) {
    health_level = 'perfect';
  } else if (fit_score >= 0.75) {
    health_level = 'good';
  } else if (fit_score >= 0.6) {
    health_level = 'tight';
  } else {
    health_level = 'critical';
  }

  // Determine if reroute is needed
  const needs_reroute = fit_score < 0.6;
  const reroute_reason = needs_reroute
    ? `Fit score ${fit_score.toFixed(2)} below threshold (0.6). ${warnings.length} warning(s).`
    : undefined;

  // Suggest action
  let suggested_action: EnvironmentState['suggested_action'];
  if (fit_score >= 0.85) {
    suggested_action = 'keep';
  } else if (fit_score >= 0.7) {
    suggested_action = 'scale_down';
  } else if (fit_score >= 0.5) {
    suggested_action = 'reroute_layout';
  } else {
    suggested_action = 'simplify_content';
  }

  const errorsCount = warnings.filter(w =>
    w.toLowerCase().includes('error') || w.toLowerCase().includes('critical')
  ).length;

  return {
    slideId: slide.title || `slide-${slide.order}` || 'unknown',
    fit_score,
    text_density: textDensity,
    visual_utilization: avgUtilization,
    zones: zoneSnapshots,
    health_level,
    needs_reroute,
    reroute_reason,
    suggested_action,
    render_timestamp: Date.now(),
    render_duration_ms: renderDurationMs,
    warnings_count: warnings.length,
    errors_count: errorsCount
  };
}
// ============================================================================
// LAYER-AWARE RENDERING (Serendipity Architecture)
// ============================================================================

/**
 * Renders a slide using the layer-based composition model.
 * This is the new rendering path for serendipity mode.
 * 
 * Layer Order (z-index):
 * 0-9: Background layer (handled by image generation)
 * 10-19: Decorative layer (badges, dividers, accents, glows)
 * 20-59: Content layer (cards, text blocks, charts)
 * 60-79: Data viz layer (charts, diagrams)
 * 80-99: Overlay layer (tooltips, callouts)
 * 
 * @param slide - The slide to render
 * @param styleGuide - Global style guide
 * @param compositionPlan - Layer-based composition plan from Composition Architect
 * @param getIconUrl - Callback to get cached icon URLs
 * @param getDiagramUrl - Callback to get cached diagram URLs
 * @returns Array of VisualElements with proper z-ordering
 */
export function renderWithLayeredComposition(
  slide: SlideNode,
  styleGuide: GlobalStyleGuide,
  compositionPlan: any, // CompositionPlan type
  getIconUrl: (name: string) => string | undefined,
  getDiagramUrl?: (comp: any) => string | undefined
): VisualElement[] {
  const elements: VisualElement[] = [];

  // Serendipity renderers are now statically imported at top of file for ESM compatibility
  // Check if the renderers have the required functions available
  const hasDecorativeRenderer = typeof decorativeRenderers?.renderDecorativeLayer === 'function';
  const hasCardRenderer = typeof cardRenderers?.renderCard === 'function';
  
  if (!hasDecorativeRenderer || !hasCardRenderer) {
    console.warn('[SpatialRenderer] Serendipity renderers not fully available, some features may be limited');
  }

  const palette = {
    primary: normalizeColor(styleGuide?.colorPalette?.primary, '22C55E'),
    secondary: normalizeColor(styleGuide?.colorPalette?.secondary, '38BDF8'),
    accent: normalizeColor(styleGuide?.colorPalette?.accentHighContrast, 'F59E0B'),
    background: normalizeColor(styleGuide?.colorPalette?.background, '0F172A'),
    text: normalizeColor(styleGuide?.colorPalette?.text, 'F1F5F9'),
    textMuted: normalizeColor(styleGuide?.colorPalette?.text, 'A1A1AA')
  };

  const iconCache = new Map<string, string>();
  // Pre-populate icon cache from getIconUrl callback
  const populateIcon = (name: string) => {
    if (name && !iconCache.has(name)) {
      const url = getIconUrl(name);
      if (url) iconCache.set(name, url);
    }
  };

  // Validate composition plan
  if (!compositionPlan || !compositionPlan.layerPlan) {
    console.warn('[renderWithLayeredComposition] Invalid composition plan, falling back to standard render');
    const engine = new SpatialLayoutEngine();
    return engine.renderWithSpatialAwareness(slide, styleGuide, getIconUrl, slide.visualDesignSpec, getDiagramUrl);
  }

  // --- LAYER 1: DECORATIVE ELEMENTS (z-index 10-19) ---
  if (hasDecorativeRenderer && compositionPlan.layerPlan.decorativeElements?.length > 0) {
    const decorativeContext = {
      palette,
      iconCache,
      baseZIndex: 10
    };

    // Convert composition plan decorative elements to renderable format
    const decorativeElements = compositionPlan.layerPlan.decorativeElements
      .filter((el: any) => el && el.type)
      .map((el: any, idx: number) => {
        // Map placement strings to actual positions
        const position = mapPlacementToPosition(el.placement, el.type);

        // Pre-populate icon if needed
        if (el.type === 'badge' && el.icon) {
          populateIcon(el.icon);
        }

        return {
          type: el.type,
          position,
          content: el.content || el.purpose || 'Category',
          icon: el.icon,
          color: palette.primary,
          style: 'pill',
          orientation: 'horizontal',
          intensity: 'subtle',
          shape: 'underline'
        };
      });

    elements.push(...decorativeRenderers.renderDecorativeLayer(decorativeElements, decorativeContext));
  }

  // --- SLIDE TITLE (z-index 15 - between decorative and content) ---
  // Always render the slide title in layer-based mode
  const titleElement: VisualElement = {
    type: 'text',
    content: slide.title || 'Untitled',
    x: 0.5,
    y: 0.5,
    w: 9,
    h: 0.9,
    fontSize: DEFAULT_THEME_TOKENS.typography.scale.title,
    color: palette.text,
    bold: true,
    align: 'left',
    zIndex: 15,
    letterSpacing: DEFAULT_THEME_TOKENS.typography.letterSpacing.title,
    fontWeight: DEFAULT_THEME_TOKENS.typography.weights.title
  };
  elements.push(titleElement);

  // --- LAYER 2: CONTENT (z-index 20-59) ---
  // For now, delegate to standard component rendering
  // In full implementation, would use cardRenderers for card-based layouts
  const contentStructure = compositionPlan.layerPlan.contentStructure;

  if (contentStructure.pattern === 'card-row' || contentStructure.pattern === 'narrative-flow') {
    // Use card-based rendering if available
    if (hasCardRenderer && slide.layoutPlan?.components) {
      const cardContext = {
        palette,
        iconCache,
        baseZIndex: 20
      };

      // Convert components to cards and render
      // This is a simplified version - full implementation would map component types to cards
      const components = slide.layoutPlan.components;
      const cardCount = contentStructure.cardCount || Math.min(components.length, 4);
      const gap = DEFAULT_THEME_TOKENS.spacing.md;
      const cardWidth = (9 - (gap * (cardCount - 1))) / cardCount;
      const cardY = 1.6; // Below title with breathing room
      const cardH = 3.8;

      // Collect all icons from components for pre-caching
      components.forEach((comp: any) => {
        if (comp.type === 'metric-cards') {
          (comp.metrics || []).forEach((m: any) => m.icon && populateIcon(m.icon));
        }
        if (comp.type === 'process-flow') {
          (comp.steps || []).forEach((s: any) => s.icon && populateIcon(s.icon));
        }
        if (comp.type === 'icon-grid') {
          (comp.items || []).forEach((item: any) => item.icon && populateIcon(item.icon));
        }
      });

      // Narrative-flow pattern: Specialized 3-card story layout
      // Card 1: 🔺 THE PROBLEM - Card 2: 💡 THE INSIGHT - Card 3: 🚀 THE SOLUTION
      const narrativeIcons = ['AlertTriangle', 'Lightbulb', 'Rocket'];
      const narrativeOverlines = ['THE CHALLENGE', 'THE APPROACH', 'THE OUTCOME'];
      const narrativeColors = [
        palette.accent,    // Warning/problem color
        palette.primary,   // Insight/solution color  
        palette.secondary  // Vision/outcome color
      ];

      // For narrative-flow, render each component as a premium card
      components.slice(0, cardCount).forEach((comp: any, idx: number) => {
        const cardX = 0.5 + (idx * (cardWidth + gap));

        // Smart content extraction based on component type
        let title = '';
        let body = '';
        let icon = narrativeIcons[idx] || 'HelpCircle';
        let overline = narrativeOverlines[idx] || '';
        let iconColor = narrativeColors[idx] || palette.primary;

        if (comp.type === 'text-bullets') {
          const content = Array.isArray(comp.content) ? comp.content : [];
          title = comp.title || content[0] || 'Point';
          body = content.slice(1, 4).join(' • ') || ''; // First 3 bullets as body
        } else if (comp.type === 'metric-cards' && comp.metrics?.length > 0) {
          const metric = comp.metrics[0];
          title = metric.label || 'Metric';
          body = String(metric.value || '');
          icon = metric.icon || icon;
        } else if (comp.type === 'process-flow' && comp.steps?.length > 0) {
          const step = comp.steps[idx] || comp.steps[0];
          overline = `STEP ${idx + 1}`;
          title = step.title || step.label || 'Step';
          body = step.description || '';
          icon = step.icon || icon;
        } else if (comp.type === 'icon-grid' && comp.items?.length > 0) {
          const item = comp.items[idx] || comp.items[0];
          title = item.label || 'Item';
          body = item.description || '';
          icon = item.icon || icon;
        }

        // Use narrative-flow pattern only when appropriate
        const isNarrativeFlow = contentStructure.pattern === 'narrative-flow';

        const cardElement = {
          id: `content-card-${idx}`,
          position: { x: cardX, y: cardY, w: cardWidth, h: cardH },
          style: contentStructure.cardStyle || 'glass',
          header: {
            icon,
            iconContainer: 'circle' as const,
            iconColor: isNarrativeFlow ? iconColor : palette.primary,
            overline: isNarrativeFlow ? overline : undefined,
            title
          },
          body,
          emphasis: idx === 0 ? 'primary' as const : 'secondary' as const
        };

        elements.push(...cardRenderers.renderCard(cardElement, {
          ...cardContext,
          baseZIndex: 20 + (idx * 10)
        }));
      });
    }
  } else {
    // Fall back to standard spatial rendering for other patterns
    const engine = new SpatialLayoutEngine();
    const standardElements = engine.renderWithSpatialAwareness(
      slide,
      styleGuide,
      getIconUrl,
      slide.visualDesignSpec,
      getDiagramUrl
    );

    // Adjust z-indices for layer ordering
    standardElements.forEach(el => {
      if ('zIndex' in el && typeof el.zIndex === 'number') {
        el.zIndex = 20 + el.zIndex;
      } else {
        (el as any).zIndex = 20;
      }
    });

    elements.push(...standardElements);
  }

  // --- LAYER 3: OVERLAY (z-index 80-99) ---
  // Reserved for future overlay elements (tooltips, callouts)

  // Sort all elements by z-index for proper rendering order
  elements.sort((a, b) => {
    const zA = 'zIndex' in a ? (a.zIndex || 0) : 0;
    const zB = 'zIndex' in b ? (b.zIndex || 0) : 0;
    return zA - zB;
  });

  return elements;
}

/**
 * Maps placement strings from composition plan to actual slide coordinates
 */
function mapPlacementToPosition(
  placement: string | undefined,
  elementType: string
): { x: number; y: number; w: number; h: number } {
  // Default positions for different placement strings
  const positions: Record<string, { x: number; y: number; w: number; h: number }> = {
    'top-left': { x: 0.5, y: 0.3, w: 2.5, h: 0.35 },
    'top-center': { x: 3.75, y: 0.3, w: 2.5, h: 0.35 },
    'top-right': { x: 7.0, y: 0.3, w: 2.5, h: 0.35 },
    'below-title': { x: 0.5, y: 1.2, w: 9, h: 0.05 },
    'center': { x: 2, y: 2.5, w: 6, h: 1 },
    'bottom-left': { x: 0.5, y: 5.0, w: 2.5, h: 0.35 },
    'bottom-center': { x: 3.75, y: 5.0, w: 2.5, h: 0.35 }
  };

  // Type-specific defaults
  const typeDefaults: Record<string, string> = {
    'badge': 'top-left',
    'divider': 'below-title',
    'accent-shape': 'below-title',
    'glow': 'center'
  };

  const normalizedPlacement = (placement || '').toLowerCase().replace(/\s+/g, '-');
  const defaultPlacement = typeDefaults[elementType] || 'top-left';

  return positions[normalizedPlacement] || positions[defaultPlacement] || positions['top-left'];
}