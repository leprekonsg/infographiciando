

import { TemplateComponent, VisualElement, GlobalStyleGuide, SpatialZone, LayoutVariant, SpatialStrategy, SlideNode, VisualDesignSpec } from '../types/slideTypes';
import { InfographicRenderer, normalizeColor } from './infographicRenderer';

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
  ]
};

export class SpatialLayoutEngine {

  public getZonesForVariant(variant: string): SpatialZone[] {
    return LAYOUT_TEMPLATES[variant] || LAYOUT_TEMPLATES['standard-vertical'];
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
      'text-bullets': ['text-main', 'content-top', 'content-bottom', 'hero-content', 'content-area'],
      'chart-frame': ['visual-right', 'visual-left', 'content-top', 'content-area', 'grid-1', 'grid-2'],
      'metric-cards': ['grid-1', 'grid-2', 'grid-3', 'grid-4', 'content-top', 'content-bottom', 'visual-right'],
      'process-flow': ['content-area', 'content-top', 'content-bottom', 'visual-right', 'visual-left'],
      'icon-grid': ['grid-1', 'grid-2', 'grid-3', 'grid-4', 'content-top', 'content-bottom'],
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
    visualDesignSpec?: VisualDesignSpec // NEW: Accept visual design spec for color overrides
  ): VisualElement[] {
    const elements: VisualElement[] = [];
    const variant = slide.routerConfig?.layoutVariant || 'standard-vertical';
    const zones = this.getZonesForVariant(variant);
    const { allocation, unplaced } = this.allocateComponents(slide.title, slide.layoutPlan?.components || [], variant);

    // --- APPLY VISUAL DESIGN SPEC OVERRIDES ---
    // If visualDesignSpec has color_harmony, use it to override styleGuide colors
    const effectiveStyleGuide: GlobalStyleGuide = visualDesignSpec?.color_harmony
      ? {
        ...styleGuide,
        colorPalette: {
          ...styleGuide.colorPalette,
          // Override with VisualDesignSpec colors if provided
          primary: normalizeColor(visualDesignSpec.color_harmony.primary || styleGuide.colorPalette.primary),
          accentHighContrast: normalizeColor(visualDesignSpec.color_harmony.accent || styleGuide.colorPalette.accentHighContrast),
          background: normalizeColor(visualDesignSpec.color_harmony.background_tone || styleGuide.colorPalette.background)
        }
      }
      : styleGuide;

    // Parse negative space allocation if provided (e.g., "20%", "25 percent", etc.)
    let negativeSpaceMultiplier = 1.0;
    if (visualDesignSpec?.negative_space_allocation) {
      const negMatch = visualDesignSpec.negative_space_allocation.match(/(\d+)/);
      if (negMatch) {
        const pct = parseInt(negMatch[1], 10);
        // Apply slight zone size reduction for higher negative space values
        if (pct > 25) {
          negativeSpaceMultiplier = 0.95; // Introduce 5% reduction for zone sizes
        } else if (pct > 35) {
          negativeSpaceMultiplier = 0.90; // 10% reduction for very high negative space
        }
      }
    }

    if (unplaced.length > 0) {
      console.warn(`[SpatialRenderer] Unplaced components for slide ${slide.title}:`, unplaced.map(c => c.type));
    }

    zones.forEach(zone => {
      const allocated = allocation.get(zone.id);

      if (!allocated) {
        // Render static accents
        if (zone.purpose === 'accent') {
          if (zone.id === 'divider' || zone.id === 'accent-bar' || zone.id === 'timeline-track') {
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
        const fontSize = zone.purpose === 'hero' ? (variant === 'hero-centered' ? 42 : 32) : 24;
        elements.push({
          type: 'text',
          content: allocated.content,
          x: zone.x, y: zone.y, w: zone.w, h: zone.h,
          fontSize,
          bold: true,
          color: normalizeColor(effectiveStyleGuide.colorPalette.text),
          fontFamily: effectiveStyleGuide.fontFamilyTitle,
          align: variant === 'hero-centered' ? 'center' : 'left',
          zIndex: 10
        });
      } else if (allocated.type === 'component-full' || allocated.type === 'component-part') {
        const els = this.renderComponentInZone(allocated.component, zone, effectiveStyleGuide, getIconUrl);
        elements.push(...els);
      }
    });

    return elements;
  }

  private renderComponentInZone(
    comp: TemplateComponent,
    zone: SpatialZone,
    styleGuide: GlobalStyleGuide,
    getIconUrl: (name: string) => string | undefined
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

    // Scale fonts based on zone purpose (Hierarchy)
    const scale = zone.purpose === 'hero' ? 1.4 : (zone.purpose === 'accent' ? 0.8 : 1.0);

    if (comp.type === 'text-bullets') {
      let curY = y;
      const maxY = y + h;

      if (comp.title) {
        const titleH = 0.6 * scale;
        if (curY + titleH <= maxY) {
          els.push({ type: 'text', content: comp.title, x, y: curY, w, h: titleH, fontSize: 18 * scale, bold: true, color: p.text, zIndex: 10 });
          curY += (0.7 * scale);
        }
      }

      const lines = comp.content || [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineH = 0.5 * scale;
        const spacing = 0.6 * scale;

        if (curY + lineH > maxY) {
          // Check if we can fit "..."
          if (i < lines.length && els.length > 0) {
            // Maybe add "..." to previous element or just stop? 
            // Simple truncation: stop.
            console.warn(`[SpatialRenderer] Text overflow in zone ${zone.id}`);
          }
          break;
        }

        els.push({ type: 'text', content: `• ${line}`, x, y: curY, w, h: lineH, fontSize: 14 * scale, color: p.text, zIndex: 10 });
        curY += spacing;
      }
    }
    else if (comp.type === 'metric-cards') {
      const metrics = comp.metrics || [];
      if (metrics.length === 0) return [];

      const count = metrics.length;
      const isHorizontal = w > h;
      const cardW = isHorizontal ? (w / count) - 0.2 : w;
      const cardH = isHorizontal ? h : (h / count) - 0.2;

      metrics.forEach((m, i) => {
        const cardX = isHorizontal ? x + (i * (cardW + 0.2)) : x;
        const cardY = isHorizontal ? y : y + (i * (cardH + 0.2));

        // Skip if out of bounds (though less likely for fixed grid except huge counts)
        if (cardX + cardW > x + w + 0.1 || cardY + cardH > y + h + 0.1) return;

        els.push({ type: 'shape', shapeType: 'roundRect', x: cardX, y: cardY, w: cardW, h: cardH, fill: { color: p.secondary, alpha: 0.1 }, border: { color: p.secondary, width: 1, alpha: 0.5 }, rectRadius: 0.2, zIndex: 5 });

        // Icon
        if (m.icon) {
          const iconUrl = getIconUrl(m.icon);
          if (iconUrl) {
            els.push({ type: 'image', data: iconUrl, x: cardX + 0.2, y: cardY + 0.2, w: 0.5, h: 0.5, zIndex: 11 });
          }
        }

        // Value
        els.push({ type: 'text', content: m.value, x: cardX + 0.1, y: cardY + (cardH * 0.3), w: cardW - 0.2, h: cardH * 0.4, fontSize: 24 * scale, bold: true, color: p.text, align: 'center', zIndex: 10 });
        // Label
        els.push({ type: 'text', content: m.label, x: cardX + 0.1, y: cardY + (cardH * 0.7), w: cardW - 0.2, h: cardH * 0.3, fontSize: 10 * scale, color: p.text, align: 'center', zIndex: 10 });
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

        // Arrow/Box
        els.push({ type: 'shape', shapeType: 'rightArrow', x: stepX, y, w: stepW, h: h * 0.6, fill: { color: p.accent, alpha: 0.2 }, border: { color: p.accent, width: 1, alpha: 0.6 }, zIndex: 5 });

        // Icon inside arrow
        if (s.icon) {
          const iconUrl = getIconUrl(s.icon);
          if (iconUrl) {
            els.push({ type: 'image', data: iconUrl, x: stepX + (stepW / 2) - 0.2, y: y + 0.1, w: 0.4, h: 0.4, zIndex: 11 });
          }
        }

        // Content
        els.push({ type: 'text', content: s.title, x: stepX + 0.1, y: y + (h * 0.35), w: stepW - 0.2, h: 0.3, fontSize: 10, bold: true, color: p.text, align: 'center', zIndex: 10 });
        els.push({ type: 'text', content: s.description, x: stepX + 0.1, y: y + (h * 0.65), w: stepW - 0.2, h: 0.5, fontSize: 8, color: p.text, align: 'center', zIndex: 10 });
      });
    }
    else if (comp.type === 'icon-grid') {
      const items = comp.items || [];
      if (items.length === 0) return [];

      const count = items.length;
      // Simple 2-col or 3-col grid logic based on width
      const cols = w > 4 ? 3 : 2;
      const rows = Math.ceil(count / cols);
      const itemW = (w / cols) - 0.2;
      const itemH = (h / rows) - 0.2;

      items.forEach((item, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const ix = x + (col * (itemW + 0.2));
        const iy = y + (row * (itemH + 0.2));

        if (iy + itemH > y + h + 0.1) return;

        if (item.icon) {
          const iconUrl = getIconUrl(item.icon);
          if (iconUrl) {
            els.push({ type: 'image', data: iconUrl, x: ix + (itemW / 2) - 0.3, y: iy, w: 0.6, h: 0.6, zIndex: 11 });
          }
        }
        els.push({ type: 'text', content: item.label, x: ix, y: iy + 0.7, w: itemW, h: 0.3, fontSize: 10, bold: true, color: p.text, align: 'center', zIndex: 10 });
      });
    } else if (comp.type === 'chart-frame') {
      els.push(...this.renderChartFrame(comp, p, x, y, w, h));
    }

    return els;
  }

  // Helper to render a basic chart using primitives (since VisualElement doesn't support native charts yet)
  private renderChartFrame(
    comp: TemplateComponent,
    p: any,
    x: number, y: number, w: number, h: number
  ): VisualElement[] {
    const els: VisualElement[] = [];

    // Background Frame
    els.push({ type: 'shape', shapeType: 'rect', x, y, w, h, fill: { color: p.background, alpha: 0.1 }, border: { color: p.secondary, width: 1, alpha: 0.3 }, zIndex: 5 });

    // Title
    els.push({ type: 'text', content: (comp as any).title || 'Data Visualization', x: x + 0.2, y: y + 0.2, w: w - 0.4, h: 0.5, fontSize: 14, bold: true, color: p.text, align: 'center', zIndex: 10 });

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
          x: barX - 0.2, y: barY - 0.3, w: barWidth + 0.4, h: 0.3,
          fontSize: 10, color: p.text, align: 'center', zIndex: 7
        });

        // Label
        els.push({
          type: 'text', content: d.label,
          x: barX - 0.2, y: chartArea.y + chartArea.h + 0.1, w: barWidth + 0.4, h: 0.4,
          fontSize: 10, color: p.text, align: 'center', zIndex: 7
        });
      });

      // Axes Lines
      els.push({ type: 'shape', shapeType: 'rect', x: chartArea.x, y: chartArea.y, w: 0.05, h: chartArea.h, fill: { color: p.text, alpha: 0.5 }, zIndex: 5 }); // Y Axis
      els.push({ type: 'shape', shapeType: 'rect', x: chartArea.x, y: chartArea.y + chartArea.h, w: chartArea.w, h: 0.05, fill: { color: p.text, alpha: 0.5 }, zIndex: 5 }); // X Axis
    } else {
      els.push({ type: 'text', content: 'No Data Available', x: x, y: y + (h / 2), w, h: 0.5, fontSize: 12, color: p.text, align: 'center', zIndex: 10 });
    }

    return els;
  }
}
