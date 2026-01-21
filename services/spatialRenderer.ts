

import { TemplateComponent, VisualElement, GlobalStyleGuide, SpatialZone, LayoutVariant, SpatialStrategy, SlideNode, VisualDesignSpec, EnvironmentState } from '../types/slideTypes';
import { InfographicRenderer, normalizeColor } from './infographicRenderer';

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

const DEFAULT_THEME_TOKENS = {
  typography: {
    scale: { hero: 42, title: 32, subtitle: 20, body: 14, label: 10, metric: 24, micro: 9 },
    weights: { hero: 700, title: 700, subtitle: 600, body: 400, label: 600, metric: 700 },
    lineHeights: { title: 1.1, body: 1.25 },
    letterSpacing: { title: 0.2, body: 0 }
  },
  spacing: { xs: 0.08, sm: 0.12, md: 0.2, lg: 0.32 },
  radii: { card: 0.18, pill: 0.4 },
  surfaces: { cardStyle: 'glass', borderWidth: 1.2, opacity: 0.65 }
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
      components.forEach(comp => {
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
                }
              });
              gridIndex++;
            }
          });
        } else {
          const zid = `grid-${gridIndex}`;
          const zone = zones.find(z => z.id === zid);
          if (zone) {
            allocation.set(zid, { type: 'component-part', component: comp });
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
      components.forEach(comp => {
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
                }
              });
              cardIndex++;
            }
          });
        }
      });

      // Place remaining components into bottom panels
      const remaining = components.filter(c => c.type !== 'metric-cards');
      const panelZones = ['left-panel', 'right-panel'];
      let panelIndex = 0;
      remaining.forEach(comp => {
        const zid = panelZones[panelIndex];
        const zone = zones.find(z => z.id === zid);
        if (zone) {
          allocation.set(zid, { type: 'component-full', component: comp });
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

      const componentQueue = [...components];
      const usedZones = new Set<string>();

      // First pass: match components to their best affinity zones
      componentQueue.forEach((comp, compIdx) => {
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
            component: comp
          });
          usedZones.add(bestZone.id);
        } else {
          // No suitable zone found - try fallback to any available zone
          const fallbackZone = availableZones.find(z => !usedZones.has(z.id));
          if (fallbackZone) {
            allocation.set(fallbackZone.id, {
              type: 'component-full',
              component: comp
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
    }

    const themeTokens = this.resolveThemeTokens(effectiveStyleGuide);

    zones.forEach(zone => {
      const allocated = allocation.get(zone.id);

      if (!allocated) {
        // Render static accents
        if (zone.purpose === 'accent') {
          if (zone.id === 'divider' || zone.id === 'accent-bar' || zone.id === 'timeline-track' || zone.id === 'rail-divider') {
            elements.push({
              type: 'shape', shapeType: 'rect',
              x: zone.x, y: zone.y, w: zone.w, h: zone.h,
              fill: { color: normalizeColor(effectiveStyleGuide.colorPalette.accentHighContrast), alpha: 1 },
              zIndex: 5
            });
          } else if (zone.id === 'accent-bottom') {
            elements.push({
              type: 'shape', shapeType: 'rect',
              x: zone.x, y: zone.y, w: zone.w, h: zone.h,
              fill: { color: normalizeColor(effectiveStyleGuide.colorPalette.primary), alpha: 1 },
              zIndex: 5
            });
          }
        }
        return;
      }

      if (allocated.type === 'title') {
        const fontSize = zone.purpose === 'hero'
          ? (variant === 'hero-centered' ? themeTokens.typography.scale.hero : themeTokens.typography.scale.title)
          : themeTokens.typography.scale.subtitle;
        elements.push({
          type: 'text',
          content: allocated.content,
          x: zone.x, y: zone.y, w: zone.w, h: zone.h,
          fontSize,
          bold: this.isBold(themeTokens.typography.weights.title),
          color: normalizeColor(effectiveStyleGuide.colorPalette.text),
          fontFamily: effectiveStyleGuide.fontFamilyTitle,
          align: variant === 'hero-centered' ? 'center' : 'left',
          zIndex: 10
        });
      } else if (allocated.type === 'component-full' || allocated.type === 'component-part') {
        const els = this.renderComponentInZone(allocated.component, zone, effectiveStyleGuide, themeTokens, getIconUrl, getDiagramUrl);
        elements.push(...els);
      }
    });

    // GAP 5: Apply rendering warnings to slide
    const warnings = this.getWarnings();
    if (warnings.length > 0) {
      slide.warnings = [...(slide.warnings || []), ...warnings];
      console.warn(`[SPATIAL RENDERER] ${warnings.length} rendering warning(s) for slide "${slide.title}"`);
    }

    return elements;
  }

  /**
   * Estimate how many lines will be rendered after text wrapping.
   * Rough heuristic based on zone width and font size.
   */
  private estimateWrappedLineCount(
    lines: string[],
    zoneWidthUnits: number,
    fontSizePoints: number
  ): number {
    // Empirical: ~2.5 characters per unit width at default font size
    // At 14pt (standard bullet), ~3.5 chars per unit
    // Adjust avgCharsPerUnitWidth based on the actual fontSizePoints relative to 14pt
    const baseCharsPerUnitWidth = 3.5; // For 14pt font
    const effectiveCharsPerUnitWidth = baseCharsPerUnitWidth * (14 / fontSizePoints);

    const maxCharsPerLine = Math.max(10, Math.floor(zoneWidthUnits * effectiveCharsPerUnitWidth));

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
    getDiagramUrl?: (comp: any) => string | undefined
  ): VisualElement[] {
    const p = {
      text: normalizeColor(styleGuide.colorPalette.text),
      primary: normalizeColor(styleGuide.colorPalette.primary),
      secondary: normalizeColor(styleGuide.colorPalette.secondary),
      accent: normalizeColor(styleGuide.colorPalette.accentHighContrast),
      background: normalizeColor(styleGuide.colorPalette.background)
    };
    const { x, y, w, h } = zone;
    const els: VisualElement[] = [];

    const spacing = themeTokens.spacing;
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

    if (comp.type === 'text-bullets') {
      let contentScale = scale;
      const lines = comp.content || [];
      const hasTitle = !!comp.title;

      // Estimate wrapped line count BEFORE calculating fit
      // Note: We use 14 * scale as approximate point size reference for wrapping
      const estimatedWrappedLines = this.estimateWrappedLineCount(lines, zone.w, 14 * scale);

      // Calculate required height WITH wrapping
      const titleHeightFactor = hasTitle ? 0.7 : 0;
      // Each wrapped line takes space. 
      // Logic: (TotalWrappedLines - 1) * spacing + height.
      // Or simply: Sum of lines * height? 
      // render loop uses: spacing (0.6) for each bullet item start, plus extra for wrapped lines.
      // Let's approximate: 1 unit per bullet? No, spacing is 0.6.
      // If 4 lines, 4 * 0.6 + 0.5 (last line height) = 2.9?
      // With wrapping: 
      // If we have 'estimatedWrappedLines' total visual lines.
      // The spacing logic in loop is: curY += advance. 
      // advance = 0.6 + (extra_wrapped_lines * 0.5).
      // So total height ~= sum(advance).
      // If N bullets, K total wrapped lines (where K >= N).
      // (K - N) extra wrapped lines.
      // Height = (N * 0.6) + ((K - N) * 0.5) roughly? Plus slight buffer.

      // User's formula: (estimatedWrappedLines - 1) * 0.6 + 0.5
      // This assumes uniform spacing 0.6 for ALL lines? 
      // Actually standard spacing for wrapped lines might be tighter than between bullets.
      // But let's stick to the user's requested formula structure if possible, 
      // OR use a safe approximation.
      // User provided: "wrappedLinesHeightFactor = (estimatedWrappedLines - 1) * 0.6 + 0.5"
      // This is a safe upper bound assuming every line (bullet or wrapped) takes 0.6 spacing.
      const wrappedLinesHeightFactor = estimatedWrappedLines > 0 ? ((estimatedWrappedLines - 1) * 0.6) + 0.5 : 0;

      const requiredFactor = titleHeightFactor + wrappedLinesHeightFactor;

      const requiredH = requiredFactor * scale;
      if (requiredH > h) {
        const fitScale = h / requiredFactor;
        const minScale = scale * 0.5;

        if (fitScale < minScale) {
          this.addWarning(
            `Text truncated in zone '${zone.id}': ` +
            `${lines.length} bullets (${estimatedWrappedLines} wrapped lines) ` +
            `requires ${(requiredH).toFixed(2)} units but only ${h} available`
          );
          contentScale = minScale;
        } else {
          contentScale = fitScale;
          // console.debug(`[SpatialRenderer] Auto-scaled text in '${zone.id}' from ${scale} to ${contentScale.toFixed(2)}`);
        }
      }

      let curY = y;
      const maxY = y + h;

      if (comp.title) {
        const titleH = 0.6 * contentScale;
        const nextY = curY + (0.7 * contentScale);
        if (nextY <= maxY) {
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
          this.addWarning(`Title dropped in zone '${zone.id}' due to space constraints.`);
        }
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const currentFontSize = themeTokens.typography.scale.body * contentScale;
        // Improve heuristic: 3.5 is for 14pt.
        const baseCharsPerUnitWidth = 3.5; // For 14pt font
        const effectiveCharsPerUnitWidth = baseCharsPerUnitWidth * (14 / currentFontSize);
        const maxCharsPerLine = Math.max(10, Math.floor(zone.w * effectiveCharsPerUnitWidth));

        const visibleText = line.replace(/^•\s*/, '');
        const wrappedLinesCount = Math.ceil(visibleText.length / maxCharsPerLine);
        const vLines = Math.max(1, wrappedLinesCount);

        const lineH = 0.5 * contentScale;
        const totalVisualH = vLines * lineH;

        // Advance: 0.6 basis + extra height for wrapped lines
        const advance = Math.max(0.6 * contentScale, totalVisualH + (0.1 * contentScale));

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

      const baseIconScale = count <= 3 ? 0.38 : 0.32;
      const getEmphasisScale = (item: any, index: number) => {
        const raw = (item?.emphasis || item?.size || item?.importance || '').toString().toLowerCase();
        if (['primary', 'featured', 'high', 'large', 'lg', 'xl'].includes(raw)) return 1.2;
        if (['secondary', 'medium', 'md'].includes(raw)) return 1.0;
        if (['low', 'small', 'sm'].includes(raw)) return 0.85;
        if (index === 0 && count <= 3) return 1.15; // default hierarchy
        return 1.0;
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

        const iconScale = getEmphasisScale(item, i);
        const iconSize = Math.min(itemW, itemH) * baseIconScale * iconScale;
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
        }
      }
    }

    return els;
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
      surfaces: { ...DEFAULT_THEME_TOKENS.surfaces, ...(tokens.surfaces || {}) }
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

      default:
        totalItems += 1;
    }
  }

  return totalItems > 0 ? Math.min(1.0, totalTextItems / (totalItems * 2)) : 0;
}

/**
 * Calculate fit score based on warnings, utilization, and density.
 * Returns a 0-1 score where 1 = perfect, 0 = critical issues.
 */
function calculateFitScore(
  warningsCount: number,
  avgUtilization: number,
  textDensity: number
): number {
  // Start with perfect score
  let score = 1.0;

  // Penalize for warnings (each warning reduces score)
  if (warningsCount > 0) {
    score -= warningsCount * 0.15; // -15% per warning
  }

  // Penalize for high utilization (>0.9 is risky)
  if (avgUtilization > 0.9) {
    score -= (avgUtilization - 0.9) * 0.5; // -50% for full utilization
  }

  // Penalize for high text density (>0.8 is packed)
  if (textDensity > 0.8) {
    score -= (textDensity - 0.8) * 0.3; // -30% for dense text
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
    slideId: slide.id || slide.title || 'unknown',
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
