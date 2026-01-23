

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as LucideIcons from 'lucide-react';
import pptxgen from 'pptxgenjs';
import { SlideNode, GlobalStyleGuide, TemplateComponent, VisualElement, LayoutVariant } from '../types/slideTypes';
import { SpatialLayoutEngine, renderWithLayeredComposition } from './spatialRenderer';
import { buildDiagramSVG, DiagramPalette } from './diagramBuilder';
import { svgToPngBase64 } from './visualCortex';

const DEFAULT_COLORS = { background: "0F172A", text: "F1F5F9", primary: "22C55E", secondary: "38BDF8", accent: "F59E0B" };

/**
 * ROBUST COLOR NORMALIZATION
 * Handles LLM-generated creative color formats like:
 * - "Slate Grey (708090)" → "708090"
 * - "Electric Violet" → mapped to "8B00FF"
 * - "#10B981" → "10B981"
 * - "10b981" → "10B981"
 * Always returns valid 6-digit RGB hex for pptxgenjs
 */
const COLOR_NAME_MAP: Record<string, string> = {
  // Basic colors
  'white': 'FFFFFF', 'black': '000000', 'red': 'FF0000', 'green': '00FF00',
  'blue': '0000FF', 'yellow': 'FFFF00', 'cyan': '00FFFF', 'magenta': 'FF00FF',
  'purple': '800080', 'orange': 'FFA500', 'pink': 'FFC0CB', 'brown': 'A52A2A',

  // Grey variants
  'grey': '808080', 'gray': '808080', 'darkgrey': 'A9A9A9', 'darkgray': 'A9A9A9',
  'lightgrey': 'D3D3D3', 'lightgray': 'D3D3D3', 'silver': 'C0C0C0',
  'slategrey': '708090', 'slategray': '708090', 'slate': '708090',

  // Creative/Modern colors (LLM favorites)
  'electricviolet': '8B00FF', 'electricpurple': '8B00FF', 'violet': 'EE82EE',
  'electriccyan': '00FFFF', 'neoncyan': '00FFFF', 'neonblue': '1B03A3',
  'neonamber': 'FF7E00', 'amber': 'FFBF00', 'gold': 'FFD700', 'ambergold': 'FFD700',
  'neongreen': '39FF14', 'limegreen': '32CD32', 'emerald': '50C878',

  // Tailwind-like colors (note: 'slate' already defined above as slategrey 708090)
  'zinc': '71717A', 'neutral': '737373', 'stone': '78716C',
  'teal': '14B8A6', 'indigo': '6366F1', 'sky': '0EA5E9', 'rose': 'F43F5E',

  // Professional/Corporate
  'navy': '000080', 'midnight': '191970', 'charcoal': '36454F', 'graphite': '383838',
  'steel': '71797E', 'ash': 'B2BEB5', 'platinum': 'E5E4E2', 'ivory': 'FFFFF0',

  // Miscellaneous
  'coral': 'FF7F50', 'salmon': 'FA8072', 'crimson': 'DC143C', 'maroon': '800000',
  'olive': '808000', 'lime': '00FF00', 'aqua': '00FFFF', 'turquoise': '40E0D0',
  'lavender': 'E6E6FA', 'plum': 'DDA0DD', 'orchid': 'DA70D6', 'hotpink': 'FF69B4'
};

export function normalizeColor(input?: string, fallback: string = "000000"): string {
  if (!input || typeof input !== 'string') {
    return fallback.replace('#', '').toUpperCase();
  }

  const original = input.trim();

  // 1. Try to extract hex from parentheses: "Slate Grey (708090)" → "708090"
  const parenMatch = original.match(/\(([0-9A-Fa-f]{6})\)/);
  if (parenMatch) {
    return parenMatch[1].toUpperCase();
  }

  // 2. Try to find any 6-digit hex in the string: "color #10B981 here" → "10B981"
  const hexMatch = original.match(/#?([0-9A-Fa-f]{6})\b/);
  if (hexMatch) {
    return hexMatch[1].toUpperCase();
  }

  // 3. Handle short 3-digit hex: "#FFF" → "FFFFFF"
  const shortHexMatch = original.match(/#?([0-9A-Fa-f]{3})\b/);
  if (shortHexMatch && shortHexMatch[1].length === 3) {
    const short = shortHexMatch[1];
    return (short[0] + short[0] + short[1] + short[1] + short[2] + short[2]).toUpperCase();
  }

  // 4. Try color name lookup (normalize: lowercase, remove spaces/hyphens)
  const normalized = original.toLowerCase().replace(/[\s\-_]/g, '');

  // Direct lookup
  if (COLOR_NAME_MAP[normalized]) {
    return COLOR_NAME_MAP[normalized];
  }

  // Partial match: "electric cyan and amber" → check first word
  const words = normalized.split(/and|,/);
  for (const word of words) {
    const cleanWord = word.trim();
    if (COLOR_NAME_MAP[cleanWord]) {
      console.warn(`[COLOR NORMALIZE] Extracted "${cleanWord}" from "${original}" → ${COLOR_NAME_MAP[cleanWord]}`);
      return COLOR_NAME_MAP[cleanWord];
    }
  }

  // Check if any key is contained in the input
  for (const [name, hex] of Object.entries(COLOR_NAME_MAP)) {
    if (normalized.includes(name)) {
      console.warn(`[COLOR NORMALIZE] Matched "${name}" in "${original}" → ${hex}`);
      return hex;
    }
  }

  // 5. Fallback - log and return default
  console.warn(`[COLOR NORMALIZE] Could not parse color "${original}", using fallback "${fallback}"`);
  return fallback.replace('#', '').toUpperCase();
}

// Backward-compatible alias
const cleanHex = normalizeColor;

const resolvePalette = (style?: GlobalStyleGuide) => ({
  background: normalizeColor(style?.colorPalette?.background, DEFAULT_COLORS.background),
  text: normalizeColor(style?.colorPalette?.text, DEFAULT_COLORS.text),
  primary: normalizeColor(style?.colorPalette?.primary, DEFAULT_COLORS.primary),
  secondary: normalizeColor(style?.colorPalette?.secondary, DEFAULT_COLORS.secondary),
  accent: normalizeColor(style?.colorPalette?.accentHighContrast, DEFAULT_COLORS.accent)
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
  } catch (e: any) {
    console.warn(`[ICON RENDER] Failed to render icon ${normalizedName}: ${e?.message || e}`);
    return "";
  }
};

export class InfographicRenderer {
  private iconCache = new Map<string, string>();
  private diagramCache = new Map<string, string>();
  private layoutEngine = new SpatialLayoutEngine();

  async prepareIconsForDeck(slides: SlideNode[], palette: any) {
    const allIcons = new Set<string>();
    slides.forEach(s => s.layoutPlan?.components?.forEach(c => {
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

  async prepareDiagramsForDeck(slides: SlideNode[], styleGuide: GlobalStyleGuide) {
    const palette = resolvePalette(styleGuide);
    const diagramPalette: DiagramPalette = {
      primary: palette.primary,
      accent: palette.accent,
      background: palette.background,
      text: palette.text
    };

    for (const slide of slides) {
      const components = slide.layoutPlan?.components || [];
      for (let i = 0; i < components.length; i++) {
        const comp = components[i];
        if (comp.type === 'diagram-svg') {
          // Use content-based cache key (stable across renders)
          const cacheKey = this.generateDiagramCacheKey(comp);
          if (!this.diagramCache.has(cacheKey)) {
            try {
              // Check if we're in Node.js environment
              if (typeof window !== 'undefined') {
                console.warn('[InfographicRenderer] Diagram rendering requires Node.js environment, skipping');
                continue;
              }

              const svgString = buildDiagramSVG(
                comp.diagramType,
                (comp.elements || []) as any,
                comp.centralTheme,
                diagramPalette
              );

              // Rasterize to PNG (1920x1080 for high quality)
              const pngBase64 = await svgToPngBase64(svgString, 1920, 1080);

              this.diagramCache.set(cacheKey, pngBase64);
            } catch (error: any) {
              console.error(`[InfographicRenderer] Failed to generate diagram for slide ${slide.order}:`, error.message);
            }
          }
        }
      }
    }
  }

  private generateDiagramCacheKey(comp: any): string {
    // Generate stable key from diagram content
    const elements = comp.elements || [];
    const elementKeys = elements.map((e: any) => `${e.id}:${e.label}`).join('|');
    return `${comp.diagramType}:${comp.centralTheme || 'no-theme'}:${elementKeys}`;
  }

  private buildDiagramSvgDataUrl(comp: any, styleGuide: GlobalStyleGuide): string | undefined {
    try {
      const palette = resolvePalette(styleGuide);
      const diagramPalette: DiagramPalette = {
        primary: palette.primary,
        accent: palette.accent,
        background: palette.background,
        text: palette.text
      };
      const svgString = buildDiagramSVG(
        comp.diagramType,
        comp.elements,
        comp.centralTheme,
        diagramPalette
      );
      const encoded = encodeURIComponent(svgString)
        .replace(/'/g, '%27')
        .replace(/"/g, '%22');
      return `data:image/svg+xml;charset=utf-8,${encoded}`;
    } catch (error: any) {
      console.warn('[InfographicRenderer] Failed to build SVG diagram data URL:', error.message);
      return undefined;
    }
  }

  public getDiagramFromCache(comp: any, styleGuide: GlobalStyleGuide): string | undefined {
    const cacheKey = this.generateDiagramCacheKey(comp);
    const cached = this.diagramCache.get(cacheKey);

    if (cached) return cached;

    // Browser fallback: generate SVG data URL for preview rendering
    if (typeof window !== 'undefined') {
      const svgDataUrl = this.buildDiagramSvgDataUrl(comp, styleGuide);
      if (svgDataUrl) {
        this.diagramCache.set(cacheKey, svgDataUrl);
        return svgDataUrl;
      }
    }

    return undefined;
  }

  // --- COMPILER: THE RENDERING ENVIRONMENT ---
  public compileSlide(slide: SlideNode, styleGuide: GlobalStyleGuide): VisualElement[] {
    // Use layer-aware rendering when composition plan is available (Serendipity mode)
    if (slide.compositionPlan) {
      return renderWithLayeredComposition(
        slide,
        styleGuide,
        slide.compositionPlan,
        (name: string) => this.iconCache.get(name),
        (comp: any) => this.getDiagramFromCache(comp, styleGuide)
      );
    }
    
    // Standard rendering: Use the Spatial Layout Engine with VisualDesignSpec for color overrides
    return this.layoutEngine.renderWithSpatialAwareness(
      slide,
      styleGuide,
      (name: string) => this.iconCache.get(name),
      slide.visualDesignSpec, // Pass through the visual design spec for color harmony
      (comp: any) => this.getDiagramFromCache(comp, styleGuide)
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
        if (el.fill) opts.fill = { color: el.fill.color, transparency: (1 - el.fill.alpha) * 100 };
        if (el.border) opts.line = { color: el.border.color, width: el.border.width };
        if (el.shapeType === 'rect') opts.rectRadius = 0;
        if (el.shapeType === 'roundRect') opts.rectRadius = el.rectRadius || 0.1;

        // Map generic shapes to PPTX
        const shapeType = (pres.ShapeType as any)[el.shapeType] || pres.ShapeType.rect;
        pptSlide.addShape(shapeType, opts);
      } else if (el.type === 'text') {
        // Build text options with premium typography support
        const textOpts: any = {
          x: el.x, y: el.y, w: el.w, h: el.h,
          fontSize: el.fontSize,
          color: el.color,
          bold: el.bold || (el.fontWeight && el.fontWeight >= 700),
          fontFace: el.fontFamily,
          align: el.align,
          rotate: el.rotation
        };
        
        // Note: PptxGenJS doesn't natively support letterSpacing
        // For premium typography, we apply font weight mapping
        // letterSpacing and lineHeight are visual-only (used in preview renderer)
        if (el.fontWeight) {
          // Map fontWeight to bold (700+) or regular
          textOpts.bold = el.fontWeight >= 700;
        }
        
        // Transform content if textTransform is specified
        let content = el.content;
        if ((el as any).textTransform === 'uppercase') {
          content = content.toUpperCase();
        } else if ((el as any).textTransform === 'lowercase') {
          content = content.toLowerCase();
        }
        
        pptSlide.addText(content, textOpts);
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
