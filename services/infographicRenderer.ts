

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as LucideIcons from 'lucide-react';
import pptxgen from 'pptxgenjs';
import { SlideNode, GlobalStyleGuide, TemplateComponent, VisualElement, LayoutVariant } from '../types/slideTypes';
import { SpatialLayoutEngine } from './spatialRenderer';

const DEFAULT_COLORS = { background: "0F172A", text: "F1F5F9", primary: "22C55E", secondary: "38BDF8", accent: "F59E0B" };

const cleanHex = (hex?: string, fallback: string = "000000") => hex ? hex.replace('#', '') : fallback.replace('#', '');
const resolvePalette = (style?: GlobalStyleGuide) => ({
  background: cleanHex(style?.colorPalette?.background, DEFAULT_COLORS.background),
  text: cleanHex(style?.colorPalette?.text, DEFAULT_COLORS.text),
  primary: cleanHex(style?.colorPalette?.primary, DEFAULT_COLORS.primary),
  secondary: cleanHex(style?.colorPalette?.secondary, DEFAULT_COLORS.secondary),
  accent: cleanHex(style?.colorPalette?.accentHighContrast, DEFAULT_COLORS.accent)
});

function normalizeIconName(name: string): string {
  if (!name) return 'HelpCircle';
  const clean = name.replace(/[^a-zA-Z0-9-]/g, '');
  const pascal = clean.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
  return (LucideIcons as any)[pascal] ? pascal : 'HelpCircle';
}

export const convertIconToPng = async (iconName: string, color: string, pixelSize: number): Promise<string> => {
   const normalizedName = normalizeIconName(iconName);
   try {
     const IconComponent = (LucideIcons as any)[normalizedName] || (LucideIcons as any)['HelpCircle'];
     const svgString = renderToStaticMarkup(React.createElement(IconComponent, { size: pixelSize, color: `#${cleanHex(color)}`, strokeWidth: 2 }));
     const url = URL.createObjectURL(new Blob([svgString], { type: "image/svg+xml;charset=utf-8" }));
     const img = new Image(); img.src = url;
     await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
     const canvas = document.createElement("canvas");
     canvas.width = pixelSize * 2; canvas.height = pixelSize * 2;
     const ctx = canvas.getContext("2d");
     if (ctx) { ctx.scale(2, 2); ctx.drawImage(img, 0, 0, pixelSize, pixelSize); }
     URL.revokeObjectURL(url);
     return canvas.toDataURL("image/png");
   } catch { return ""; }
};

export class InfographicRenderer {
  private iconCache = new Map<string, string>();
  private layoutEngine = new SpatialLayoutEngine();

  async prepareIconsForDeck(slides: SlideNode[], palette: any) {
    const allIcons = new Set<string>();
    slides.forEach(s => s.layoutPlan?.components.forEach(c => {
       if (c.type === 'metric-cards') (c.metrics || []).forEach(m => m.icon && allIcons.add(m.icon));
       if (c.type === 'process-flow') (c.steps || []).forEach(st => st.icon && allIcons.add(st.icon));
       if (c.type === 'icon-grid') (c.items || []).forEach(i => i.icon && allIcons.add(i.icon));
    }));

    for (const name of allIcons) {
        if (!this.iconCache.has(name)) {
            const png = await convertIconToPng(name, palette.primary, 64);
            if (png) this.iconCache.set(name, png);
        }
    }
  }

  // --- COMPILER: THE RENDERING ENVIRONMENT ---
  public compileSlide(slide: SlideNode, styleGuide: GlobalStyleGuide): VisualElement[] {
      // Use the new Spatial Layout Engine
      return this.layoutEngine.renderWithSpatialAwareness(
          slide, 
          styleGuide,
          (name: string) => this.iconCache.get(name) 
      );
  }

  // --- EXPORTER: PPTX GEN ---
  public async renderSlideFromPlan({ slide, styleGuide, pptSlide, pres }: any) {
      // Use the Compiler to get flat elements, then render to PPTX
      // This ensures 1:1 fidelity between Preview and Export
      const elements = this.compileSlide(slide, styleGuide);
      
      elements.forEach(el => {
          if (el.type === 'shape') {
               const opts: any = { x: el.x, y: el.y, w: el.w, h: el.h, rotate: el.rotation };
               if (el.fill) opts.fill = { color: el.fill.color, transparency: (1-el.fill.alpha)*100 };
               if (el.border) opts.line = { color: el.border.color, width: el.border.width };
               if (el.shapeType === 'rect') opts.rectRadius = 0;
               if (el.shapeType === 'roundRect') opts.rectRadius = el.rectRadius || 0.1;
               
               // Map generic shapes to PPTX
               const shapeType = (pres.ShapeType as any)[el.shapeType] || pres.ShapeType.rect;
               pptSlide.addShape(shapeType, opts);
          } else if (el.type === 'text') {
               pptSlide.addText(el.content, { 
                   x: el.x, y: el.y, w: el.w, h: el.h, 
                   fontSize: el.fontSize, 
                   color: el.color, 
                   bold: el.bold, 
                   fontFace: el.fontFamily, 
                   align: el.align, 
                   rotate: el.rotation 
               });
          } else if (el.type === 'image') {
               // Render icons/images
               pptSlide.addImage({
                   data: el.data,
                   x: el.x, y: el.y, w: el.w, h: el.h,
                   transparency: el.transparency || 0
               });
          }
      });
      
      // Notes: Join the new array format into a single string for PPTX
      if (slide.speakerNotesLines && Array.isArray(slide.speakerNotesLines)) {
          pptSlide.addNotes(slide.speakerNotesLines.join('\n'));
      }
  }
}
