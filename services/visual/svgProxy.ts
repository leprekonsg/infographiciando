import { SlideNode, GlobalStyleGuide } from "../../types/slideTypes";
import { SpatialLayoutEngine } from "../spatialRenderer";

/**
 * Generate content-aware SVG proxy from SlideNode for visual critique.
 * Compiles slide to VisualElements using the same rendering pipeline as PPTX export.
 * SVG viewBox: 1000x563 for 16:9 aspect ratio (0-10 coordinates × 100).
 *
 * @param slide - SlideNode with layoutPlan and visualDesignSpec
 * @param styleGuide - Global style guide for colors and fonts
 * @returns SVG string with actual text content, shapes, and layout (max 15KB)
 */
export function generateSvgProxy(
    slide: SlideNode,
    styleGuide: GlobalStyleGuide
): string {
    const layoutEngine = new SpatialLayoutEngine();

    // Stub icon lookup (icons not rendered in SVG proxy to avoid bloat)
    const getIconUrl = (_name: string) => undefined;

    // Compile slide to VisualElements using the same engine as PPTX export
    const elements = layoutEngine.renderWithSpatialAwareness(
        slide,
        styleGuide,
        getIconUrl,
        slide.visualDesignSpec
    );

    // SVG viewBox: 1000x563 for 16:9 (100x multiplier for 0-10 coordinate system)
    let svg = `<svg viewBox="0 0 1000 563" xmlns="http://www.w3.org/2000/svg">\n`;

    // Background (use visualDesignSpec color if available)
    const bgColor = slide.visualDesignSpec?.color_harmony?.background_tone ||
                    styleGuide.colorPalette.background || '#0f172a';
    const normalizedBg = bgColor.replace('#', '');
    svg += `  <rect x="0" y="0" width="1000" height="563" fill="#${normalizedBg}" id="bg"/>\n`;

    // Metadata: component counts and density
    const componentTypes = (slide.layoutPlan?.components || []).map(c => c.type);
    const totalTextChars = elements
        .filter(el => el.type === 'text')
        .reduce((sum, el) => sum + ((el as any).content?.length || 0), 0);

    svg += `  <!-- Metadata: components=${componentTypes.join(',')} textChars=${totalTextChars} -->\n`;

    // GAP 4: Priority-Based Element Inclusion
    // Sort elements by visual importance to ensure most critical elements are included
    const prioritizedElements = [...elements].sort((a, b) => {
        // Priority scoring (higher = more important)
        const getPriority = (el: any) => {
            let priority = 0;

            // Zone purpose priority
            if (el.zone?.purpose === 'hero') priority += 10;
            else if (el.zone?.purpose === 'secondary') priority += 5;
            else if (el.zone?.purpose === 'accent') priority += 2;

            // Element type priority
            if (el.type === 'text') {
                priority += 8; // Text content is critical for critique
                if (el.bold) priority += 2; // Titles and headers
                if (el.fontSize && el.fontSize > 20) priority += 3; // Large text = important
            } else if (el.type === 'shape') {
                priority += 4; // Shapes help show layout
                if (el.text) priority += 2; // Shapes with text (metrics, etc.)
            }

            // Size priority (larger elements are more impactful)
            const size = (el.w || 0) * (el.h || 0);
            if (size > 2) priority += 3;
            else if (size > 1) priority += 1;

            return priority;
        };

        return getPriority(b) - getPriority(a);
    });

    // Render elements with dynamic size limiting
    const MAX_SVG_SIZE = 12000; // Leave headroom below 15KB limit
    let currentSize = svg.length;
    let renderedCount = 0;

    for (const el of prioritizedElements) {

        // Estimate element SVG size before rendering
        const x = Math.round(el.x * 100);
        const y = Math.round(el.y * 100);
        const w = Math.round(el.w * 100);
        const h = Math.round(el.h * 100);

        let elementSvg = '';

        if (el.type === 'text') {
            const fontSize = el.fontSize || 12;
            const color = el.color?.replace('#', '') || 'F1F5F9';
            const align = el.align || 'left';
            const anchor = align === 'center' ? 'middle' : (align === 'right' ? 'end' : 'start');
            const anchorX = align === 'center' ? x + w / 2 : (align === 'right' ? x + w : x + 5);
            const fontWeight = el.bold ? 'bold' : 'normal';
            const text = (el as any).content || '';

            // Basic text truncation for SVG size control
            const maxChars = Math.floor(w / (fontSize * 0.6));
            const truncatedText = text.length > maxChars ? text.slice(0, maxChars) + '…' : text;

            elementSvg = `  <text x="${anchorX}" y="${y + fontSize}" font-size="${fontSize}" fill="#${color}" text-anchor="${anchor}" font-weight="${fontWeight}">${truncatedText}</text>\n`;
        }
        else if (el.type === 'shape') {
            const fill = el.fill?.color?.replace('#', '') || 'FFFFFF';
            const opacity = el.fill?.alpha ?? 1;
            elementSvg = `  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#${fill}" fill-opacity="${opacity}"/>\n`;
        }

        // Check size limit before adding
        if (currentSize + elementSvg.length > MAX_SVG_SIZE) {
            console.warn(`[SVG PROXY] Size limit reached (${currentSize} bytes), truncating`);
            svg += `  <!-- Truncated after ${renderedCount} elements -->\n`;
            break;
        }

        svg += elementSvg;
        currentSize += elementSvg.length;
        renderedCount++;
    }

    svg += `</svg>`;
    return svg;
}
