import { SlideNode, GlobalStyleGuide, TemplateComponent } from "../../types/slideTypes";
import { SpatialLayoutEngine } from "../spatialRenderer";

/**
 * Escape XML entities and sanitize text for SVG inclusion.
 * Prevents "invalid element" and "invalid name token" errors.
 */
function escapeXml(text: string): string {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        // Remove control characters that are invalid in XML
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Replace problematic Unicode characters
        .replace(/[\uFFFE\uFFFF]/g, '');
}

/**
 * Sanitize ID/class names for SVG elements (alphanumeric + hyphen/underscore only).
 */
function sanitizeId(id: string): string {
    if (!id || typeof id !== 'string') return 'el';
    return id
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .replace(/^[^a-zA-Z]/, 'el-')
        .replace(/-+/g, '-')
        .slice(0, 50); // Limit ID length
}

/**
 * Generate component ID that matches what Visual Architect expects.
 * Format: "{type}-{index}" e.g., "text-bullets-0", "metric-cards-1"
 * This bridges the gap between SlideNode component indices and Qwen-VL repair IDs.
 */
function generateComponentId(component: TemplateComponent, index: number): string {
    return `${component.type}-${index}`;
}

/**
 * Build a component manifest for the SVG that Qwen-VL can reference.
 * This maps visual regions to actual component indices for repair application.
 */
function buildComponentManifest(components: TemplateComponent[]): string {
    if (!components || components.length === 0) return '';
    
    const manifest = components.map((c, i) => `${c.type}-${i}`).join(',');
    return `  <!-- ComponentManifest: ${manifest} -->\n`;
}

/**
 * Generate content-aware SVG proxy from SlideNode for visual critique.
 * Compiles slide to VisualElements using the same rendering pipeline as PPTX export.
 * SVG viewBox: 1000x563 for 16:9 aspect ratio (0-10 coordinates × 100).
 * 
 * CRITICAL: SVG elements include data-component-id attributes that map back to
 * actual SlideNode component indices for Visual Architect repair application.
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
    const components = slide.layoutPlan?.components || [];

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
    const componentTypes = components.map(c => c.type);
    const totalTextChars = elements
        .filter(el => el.type === 'text')
        .reduce((sum, el) => sum + ((el as any).content?.length || 0), 0);

    svg += `  <!-- Metadata: components=${componentTypes.join(',')} textChars=${totalTextChars} -->\n`;
    
    // CRITICAL: Add component manifest for Visual Architect repair mapping
    // This tells Qwen-VL exactly which component IDs are valid
    svg += buildComponentManifest(components);

    // Track which component each element belongs to (for ID assignment)
    // Build a map of element positions to likely component indices
    const elementToComponentMap = new Map<number, number>();
    
    // Simple heuristic: match elements to components by type and order
    let typeCounters: Record<string, number> = {};
    elements.forEach((el, elIdx) => {
        const elType = (el as any).componentType || el.type;
        // Match text elements to text-bullets, shapes to metric-cards, etc.
        const componentIdx = components.findIndex((c, cIdx) => {
            const cType = c.type;
            const expectedElType = cType === 'text-bullets' ? 'text' :
                                   cType === 'metric-cards' ? 'shape' :
                                   cType === 'chart-frame' ? 'shape' :
                                   cType === 'process-flow' ? 'shape' :
                                   cType === 'icon-grid' ? 'shape' : 'text';
            return el.type === expectedElType && !elementToComponentMap.has(cIdx);
        });
        if (componentIdx >= 0) {
            elementToComponentMap.set(elIdx, componentIdx);
        }
    });

    // GAP 4: Priority-Based Element Inclusion
    // Sort elements by visual importance to ensure most critical elements are included
    const prioritizedElements = [...elements].map((el, idx) => ({ el, originalIdx: idx })).sort((a, b) => {
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

        return getPriority(b.el) - getPriority(a.el);
    });

    // Render elements with dynamic size limiting
    const MAX_SVG_SIZE = 12000; // Leave headroom below 15KB limit
    let currentSize = svg.length;
    let renderedCount = 0;
    
    // Track rendered elements by type for generating sequential IDs
    const renderedTypeCounters: Record<string, number> = {};

    for (const { el, originalIdx } of prioritizedElements) {

        // Estimate element SVG size before rendering
        const x = Math.round(el.x * 100);
        const y = Math.round(el.y * 100);
        const w = Math.round(el.w * 100);
        const h = Math.round(el.h * 100);

        let elementSvg = '';
        
        // Generate a stable ID that Visual Architect can reference
        // Format: "{element-type}-{sequential-index}" e.g., "text-title-0", "text-bullets-0"
        const elTypeKey = el.type === 'text' && el.bold ? 'text-title' :
                          el.type === 'text' ? 'text-bullets' :
                          el.type === 'shape' ? 'shape-card' : 'element';
        renderedTypeCounters[elTypeKey] = (renderedTypeCounters[elTypeKey] || 0);
        const elementId = `${elTypeKey}-${renderedTypeCounters[elTypeKey]}`;
        renderedTypeCounters[elTypeKey]++;
        
        // Map this element back to a component index if possible
        const componentIdx = elementToComponentMap.get(originalIdx);
        const componentIdAttr = componentIdx !== undefined 
            ? ` data-component-idx="${componentIdx}" data-component-id="${components[componentIdx]?.type}-${componentIdx}"`
            : '';

        if (el.type === 'text') {
            const fontSize = el.fontSize || 12;
            const color = el.color?.replace('#', '') || 'F1F5F9';
            const align = el.align || 'left';
            const anchor = align === 'center' ? 'middle' : (align === 'right' ? 'end' : 'start');
            const anchorX = align === 'center' ? x + w / 2 : (align === 'right' ? x + w : x + 5);
            const fontWeight = el.bold ? 'bold' : 'normal';
            const rawText = (el as any).content || '';

            // Basic text truncation for SVG size control
            const maxChars = Math.floor(w / (fontSize * 0.6));
            const truncatedText = rawText.length > maxChars ? rawText.slice(0, maxChars) + '…' : rawText;
            
            // CRITICAL: Escape XML entities to prevent "invalid element" errors
            const safeText = escapeXml(truncatedText);

            // Include id and data-component-id for Visual Architect repair mapping
            elementSvg = `  <text id="${elementId}"${componentIdAttr} x="${anchorX}" y="${y + fontSize}" font-size="${fontSize}" fill="#${color}" text-anchor="${anchor}" font-weight="${fontWeight}">${safeText}</text>\n`;
        }
        else if (el.type === 'shape') {
            const fill = el.fill?.color?.replace('#', '') || 'FFFFFF';
            const opacity = el.fill?.alpha ?? 1;
            // Include id and data-component-id for Visual Architect repair mapping
            elementSvg = `  <rect id="${elementId}"${componentIdAttr} x="${x}" y="${y}" width="${w}" height="${h}" fill="#${fill}" fill-opacity="${opacity}"/>\n`;
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
