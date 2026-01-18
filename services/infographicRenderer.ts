
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as LucideIcons from 'lucide-react';
import pptxgen from 'pptxgenjs';
import { SlideNode, GlobalStyleGuide, TemplateComponent, VisualElement, LayoutVariant } from '../types/slideTypes';

const SLIDE_WIDTH = 10;
const SLIDE_HEIGHT = 5.625;
const BASE_WIDTH = 960;
const BASE_HEIGHT = 540;
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
      const elements: VisualElement[] = [];
      const p = resolvePalette(styleGuide);
      
      const layoutVariant = slide.routerConfig?.layoutVariant || 'standard-vertical';
      const components = slide.layoutPlan?.components || [];

      // HELPER: Render a specific component into a bounded box
      const renderComponent = (comp: TemplateComponent, x: number, y: number, w: number, h: number): VisualElement[] => {
          const els: VisualElement[] = [];
          
          if (comp.type === 'text-bullets') {
              if (comp.title) els.push({ type: 'text', content: comp.title, x, y, w, h: 0.5, fontSize: 18, bold: true, color: p.text, zIndex: 10 });
              let curY = comp.title ? y + 0.6 : y;
              (comp.content || []).forEach(line => {
                  els.push({ type: 'text', content: `• ${line}`, x, y: curY, w, h: 0.5, fontSize: 14, color: p.text, zIndex: 10 });
                  curY += 0.5;
              });
          } else if (comp.type === 'metric-cards') {
              const count = (comp.metrics || []).length;
              const cardW = w / Math.min(count, 3) - 0.2;
              const cardH = 1.4;
              (comp.metrics || []).forEach((m, i) => {
                  const cardX = x + (i * (cardW + 0.2));
                  const cardY = y + (Math.floor(i / 3) * (cardH + 0.2));
                  els.push({ type: 'shape', shapeType: 'roundRect', x: cardX, y: cardY, w: cardW, h: cardH, fill: { color: p.secondary, alpha: 0.1 }, border: { color: p.secondary, width: 1, alpha: 0.5 }, rectRadius: 0.2, zIndex: 5 });
                  els.push({ type: 'text', content: m.value, x: cardX+0.1, y: cardY+0.1, w: cardW-0.2, h: 0.6, fontSize: 24, bold: true, color: p.text, align: 'center', zIndex: 10 });
                  els.push({ type: 'text', content: m.label, x: cardX+0.1, y: cardY+0.7, w: cardW-0.2, h: 0.4, fontSize: 10, color: p.text, align: 'center', zIndex: 10 });
              });
          } else if (comp.type === 'process-flow') {
               const count = (comp.steps || []).length;
               const stepW = w / count - 0.1;
               (comp.steps || []).forEach((s, i) => {
                  const stepX = x + (i * (stepW + 0.1));
                  els.push({ type: 'shape', shapeType: 'rightArrow', x: stepX, y, w: stepW, h: 1.0, fill: { color: p.accent, alpha: 0.2 }, border: { color: p.accent, width: 1, alpha: 0.6 }, zIndex: 5 });
                  els.push({ type: 'text', content: s.title, x: stepX+0.1, y: y+0.1, w: stepW-0.2, h: 0.4, fontSize: 10, bold: true, color: p.text, align: 'center', zIndex: 10 });
                  els.push({ type: 'text', content: s.description, x: stepX+0.1, y: y+0.5, w: stepW-0.2, h: 0.4, fontSize: 8, color: p.text, align: 'center', zIndex: 10 });
               });
          }
          return els;
      };

      // --- LAYOUT ENGINE: SWITCH ON VARIANT ---
      
      // 1. SPLIT LEFT: Text Left, Visual/Data Right
      if (layoutVariant === 'split-left-text') {
           // Title
           elements.push({ type: 'text', content: slide.title, x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 28, bold: true, color: p.text, fontFamily: styleGuide.fontFamilyTitle, zIndex: 10 });
           
           // Divider
           elements.push({ type: 'shape', shapeType: 'line', x: 5, y: 1.5, w: 0, h: 3.5, border: { color: p.primary, width: 2, alpha: 0.3 }, zIndex: 5 });
           
           // Content Left
           if (components[0]) {
               elements.push(...renderComponent(components[0], 0.5, 1.5, 4.2, 3.5));
           }
           // Content Right (or Placeholder Visual)
           if (components[1]) {
               elements.push(...renderComponent(components[1], 5.3, 1.5, 4.2, 3.5));
           } else if (slide.backgroundImageUrl) {
               // If no 2nd component, assume background image is the visual and frame it
               elements.push({ type: 'shape', shapeType: 'roundRect', x: 5.3, y: 1.5, w: 4.2, h: 3.5, fill: { color: p.background, alpha: 0.1 }, border: { color: p.text, width: 1, alpha: 0.2 }, zIndex: 5 });
               elements.push({ type: 'text', content: "Visual Focus", x: 5.3, y: 3.1, w: 4.2, h: 0.5, align: 'center', color: p.text, fontSize: 12, zIndex: 10 });
           }
      } 
      
      // 2. HERO CENTERED: Big impact
      else if (layoutVariant === 'hero-centered') {
           elements.push({ type: 'text', content: slide.title, x: 1, y: 1.5, w: 8, h: 1.5, fontSize: 42, bold: true, align: 'center', color: p.text, fontFamily: styleGuide.fontFamilyTitle, zIndex: 10 });
           if (components[0] && components[0].type === 'text-bullets') {
               const lines = components[0].content || [];
               let y = 3.2;
               lines.forEach(l => {
                   elements.push({ type: 'text', content: l, x: 2, y, w: 6, h: 0.6, fontSize: 18, align: 'center', color: p.text, zIndex: 10 });
                   y += 0.7;
               });
           }
      }
      
      // 3. BENTO GRID: 2x2 cards
      else if (layoutVariant === 'bento-grid') {
           elements.push({ type: 'text', content: slide.title, x: 0.5, y: 0.5, w: 9, h: 0.6, fontSize: 24, bold: true, color: p.text, fontFamily: styleGuide.fontFamilyTitle, zIndex: 10 });
           
           const cards: TemplateComponent[] = [];
           components.forEach(c => {
               if (c.type === 'metric-cards') {
                    // Explode metric cards into individual bento items
                   (c.metrics || []).forEach(m => cards.push({ type: 'text-bullets', title: m.value, content: [m.label], style: 'standard' }));
               } else if (c.type === 'text-bullets') {
                   // Treat bullet lists as a single card for now, or could explode
                   cards.push(c);
               } else {
                   cards.push(c);
               }
           });
           
           // Render into 2x2 grid
           cards.slice(0, 4).forEach((c, i) => {
               const col = i % 2;
               const row = Math.floor(i / 2);
               const x = 0.5 + (col * 4.6);
               const y = 1.3 + (row * 2.1);
               
               // Card Background
               elements.push({ type: 'shape', shapeType: 'roundRect', x, y, w: 4.4, h: 1.9, fill: { color: p.background, alpha: 0.5 }, border: { color: p.secondary, width: 1, alpha: 0.3 }, rectRadius: 0.2, zIndex: 4 });
               elements.push(...renderComponent(c, x + 0.2, y + 0.2, 4.0, 1.5));
           });
      }
      
      // 4. STANDARD VERTICAL (Fallback)
      else {
          elements.push({ type: 'text', content: slide.title, x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 32, color: p.text, fontFamily: styleGuide.fontFamilyTitle, bold: true, zIndex: 10 });
          elements.push({ type: 'shape', shapeType: 'rect', x: 0.5, y: 1.4, w: 1.5, h: 0.05, fill: { color: p.primary, alpha: 1 }, zIndex: 5 });
          
          let y = 1.8;
          components.forEach(comp => {
              elements.push(...renderComponent(comp, 0.5, y, 9, 3.5));
              y += 2.0;
          });
      }

      return elements;
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
          }
      });
      
      // Notes
      if (slide.speakerNotes) pptSlide.addNotes(slide.speakerNotes);
  }
}
