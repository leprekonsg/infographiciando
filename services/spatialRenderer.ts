

import { TemplateComponent, VisualElement, GlobalStyleGuide, SpatialZone, LayoutVariant, SpatialStrategy, SlideNode } from '../types/slideTypes';
import { InfographicRenderer } from './infographicRenderer';

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
  ): Map<string, any> {
    const zones = this.getZonesForVariant(variant);
    const allocation = new Map<string, any>();
    
    // Always allocate title if it exists in zones
    const titleZone = zones.find(z => z.id === 'title' || z.id === 'hero-title');
    if (titleZone) {
      allocation.set(titleZone.id, { type: 'title', content: slideTitle });
    }

    // Allocate Layout Components
    const contentZones = zones.filter(z => z.purpose !== 'hero' || (z.id !== 'title' && z.id !== 'hero-title'));
    
    // Sort components by "weight" (visual vs text)
    // Heuristic: Visuals (charts, grids) prefer larger/secondary zones
    const sortedComponents = [...components].sort((a, b) => {
        const isVisualA = ['chart-frame', 'icon-grid', 'process-flow', 'metric-cards'].includes(a.type);
        const isVisualB = ['chart-frame', 'icon-grid', 'process-flow', 'metric-cards'].includes(b.type);
        return (isVisualA === isVisualB) ? 0 : isVisualA ? -1 : 1; 
    });

    // Special Handling for Layouts
    if (variant === 'bento-grid') {
         // Explode components into grid cells
         let gridIndex = 1;
         sortedComponents.forEach(comp => {
             if (comp.type === 'metric-cards') {
                 (comp.metrics || []).forEach(m => {
                     const zid = `grid-${gridIndex}`;
                     const zone = zones.find(z => z.id === zid);
                     if (zone) {
                         // Create a mini metric card component for this cell
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
                 }
             }
         });
    } else {
        // Sequential allocation
        let compIndex = 0;
        contentZones.forEach(zone => {
           if (compIndex < sortedComponents.length) {
               // Skip specialized zones if mismatch? For now, simple fill.
               if (zone.purpose === 'accent' || zone.id === 'divider') return;
               
               allocation.set(zone.id, { 
                   type: 'component-full', 
                   component: sortedComponents[compIndex] 
               });
               compIndex++;
           }
        });
    }

    return allocation;
  }

  public renderWithSpatialAwareness(
    slide: SlideNode,
    styleGuide: GlobalStyleGuide,
    getIconUrl: (name: string) => string | undefined
  ): VisualElement[] {
    const elements: VisualElement[] = [];
    const variant = slide.routerConfig?.layoutVariant || 'standard-vertical';
    const zones = this.getZonesForVariant(variant);
    const allocation = this.allocateComponents(slide.title, slide.layoutPlan?.components || [], variant);
    
    zones.forEach(zone => {
       const allocated = allocation.get(zone.id);
       
       if (!allocated) {
           // Render static accents
           if (zone.purpose === 'accent') {
               if (zone.id === 'divider' || zone.id === 'accent-bar' || zone.id === 'timeline-track') {
                   elements.push({ 
                       type: 'shape', shapeType: 'rect', 
                       x: zone.x, y: zone.y, w: zone.w, h: zone.h, 
                       fill: { color: styleGuide.colorPalette.accentHighContrast.replace('#',''), alpha: 1 },
                       zIndex: 5
                   });
               } else if (zone.id === 'accent-bottom') {
                   elements.push({ 
                       type: 'shape', shapeType: 'rect', 
                       x: zone.x, y: zone.y, w: zone.w, h: zone.h, 
                       fill: { color: styleGuide.colorPalette.primary.replace('#',''), alpha: 1 },
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
               color: styleGuide.colorPalette.text.replace('#',''),
               fontFamily: styleGuide.fontFamilyTitle,
               align: variant === 'hero-centered' ? 'center' : 'left',
               zIndex: 10
           });
       } else if (allocated.type === 'component-full' || allocated.type === 'component-part') {
           const els = this.renderComponentInZone(allocated.component, zone, styleGuide, getIconUrl);
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
        text: styleGuide.colorPalette.text.replace('#',''),
        primary: styleGuide.colorPalette.primary.replace('#',''),
        secondary: styleGuide.colorPalette.secondary.replace('#',''),
        accent: styleGuide.colorPalette.accentHighContrast.replace('#',''),
        background: styleGuide.colorPalette.background.replace('#','')
      };
      const { x, y, w, h } = zone;
      const els: VisualElement[] = [];

      if (comp.type === 'text-bullets') {
          let curY = y;
          if (comp.title) {
              els.push({ type: 'text', content: comp.title, x, y: curY, w, h: 0.6, fontSize: 18, bold: true, color: p.text, zIndex: 10 });
              curY += 0.7;
          }
          (comp.content || []).forEach(line => {
              els.push({ type: 'text', content: `• ${line}`, x, y: curY, w, h: 0.5, fontSize: 14, color: p.text, zIndex: 10 });
              curY += 0.6;
          });
      } 
      else if (comp.type === 'metric-cards') {
        const count = (comp.metrics || []).length;
        const isHorizontal = w > h;
        const cardW = isHorizontal ? (w / count) - 0.2 : w;
        const cardH = isHorizontal ? h : (h / count) - 0.2;
        
        (comp.metrics || []).forEach((m, i) => {
            const cardX = isHorizontal ? x + (i * (cardW + 0.2)) : x;
            const cardY = isHorizontal ? y : y + (i * (cardH + 0.2));
            
            els.push({ type: 'shape', shapeType: 'roundRect', x: cardX, y: cardY, w: cardW, h: cardH, fill: { color: p.secondary, alpha: 0.1 }, border: { color: p.secondary, width: 1, alpha: 0.5 }, rectRadius: 0.2, zIndex: 5 });
            
            // Icon
            if (m.icon) {
                const iconUrl = getIconUrl(m.icon);
                if (iconUrl) {
                    els.push({ type: 'image', data: iconUrl, x: cardX + 0.2, y: cardY + 0.2, w: 0.5, h: 0.5, zIndex: 11 });
                }
            }

            // Value
            els.push({ type: 'text', content: m.value, x: cardX+0.1, y: cardY + (cardH * 0.3), w: cardW-0.2, h: cardH*0.4, fontSize: 24, bold: true, color: p.text, align: 'center', zIndex: 10 });
            // Label
            els.push({ type: 'text', content: m.label, x: cardX+0.1, y: cardY + (cardH * 0.7), w: cardW-0.2, h: cardH*0.3, fontSize: 10, color: p.text, align: 'center', zIndex: 10 });
        });
      }
      else if (comp.type === 'process-flow') {
        const count = (comp.steps || []).length;
        const stepW = (w / count) - 0.1;
        (comp.steps || []).forEach((s, i) => {
             const stepX = x + (i * (stepW + 0.1));
             // Arrow/Box
             els.push({ type: 'shape', shapeType: 'rightArrow', x: stepX, y, w: stepW, h: h * 0.6, fill: { color: p.accent, alpha: 0.2 }, border: { color: p.accent, width: 1, alpha: 0.6 }, zIndex: 5 });
             
             // Icon inside arrow
             if (s.icon) {
                 const iconUrl = getIconUrl(s.icon);
                 if (iconUrl) {
                     els.push({ type: 'image', data: iconUrl, x: stepX + (stepW/2) - 0.2, y: y + 0.1, w: 0.4, h: 0.4, zIndex: 11 });
                 }
             }

             // Content
             els.push({ type: 'text', content: s.title, x: stepX+0.1, y: y+(h*0.35), w: stepW-0.2, h: 0.3, fontSize: 10, bold: true, color: p.text, align: 'center', zIndex: 10 });
             els.push({ type: 'text', content: s.description, x: stepX+0.1, y: y+(h*0.65), w: stepW-0.2, h: 0.5, fontSize: 8, color: p.text, align: 'center', zIndex: 10 });
        });
      }
      else if (comp.type === 'icon-grid') {
          const count = (comp.items || []).length;
          // Simple 2-col or 3-col grid logic based on width
          const cols = w > 4 ? 3 : 2;
          const rows = Math.ceil(count / cols);
          const itemW = (w / cols) - 0.2;
          const itemH = (h / rows) - 0.2;

          (comp.items || []).forEach((item, i) => {
              const col = i % cols;
              const row = Math.floor(i / cols);
              const ix = x + (col * (itemW + 0.2));
              const iy = y + (row * (itemH + 0.2));

              if (item.icon) {
                 const iconUrl = getIconUrl(item.icon);
                 if (iconUrl) {
                    els.push({ type: 'image', data: iconUrl, x: ix + (itemW/2) - 0.3, y: iy, w: 0.6, h: 0.6, zIndex: 11 });
                 }
              }
              els.push({ type: 'text', content: item.label, x: ix, y: iy + 0.7, w: itemW, h: 0.3, fontSize: 10, bold: true, color: p.text, align: 'center', zIndex: 10 });
          });
      }

      return els;
  }
}
