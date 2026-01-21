/**
 * Diagram Builder Service
 *
 * Algorithmic SVG generation for custom infographic diagrams.
 * MVP: Circular ecosystem diagrams only.
 *
 * Architecture: Deterministic (no LLM), cost-free, <50ms generation.
 */

export interface DiagramElement {
  id: string;
  label: string;
  icon?: string;
}

export interface DiagramPalette {
  primary: string;
  accent: string;
  background: string;
  text?: string;
}

/**
 * Build a circular ecosystem diagram (MVP implementation)
 *
 * Layout:
 * - Center circle with optional theme label
 * - Outer ring of elements (3-8 items) evenly spaced at radius
 * - Radial lines connecting center to each element
 * - Element circles with labels below
 *
 * @param elements - Array of 3-8 diagram elements
 * @param centralTheme - Optional center label
 * @param palette - Color scheme (hex colors)
 * @param width - SVG viewport width (default 512)
 * @param height - SVG viewport height (default 512)
 * @returns SVG string
 */
export function buildCircularEcosystemDiagram(
  elements: DiagramElement[],
  centralTheme: string | undefined,
  palette: DiagramPalette,
  width: number = 512,
  height: number = 512
): string {
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.35; // 35% of viewport
  const centerRadius = 40;
  const elementRadius = 30;

  const angleStep = (2 * Math.PI) / elements.length;

  // SVG preamble
  let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;

  // Background
  svg += `<rect width="${width}" height="${height}" fill="#${palette.background}"/>`;

  // Radial lines (draw first so they appear behind circles)
  elements.forEach((el, i) => {
    const angle = i * angleStep - Math.PI / 2; // Start from top
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);

    svg += `<line x1="${centerX}" y1="${centerY}" x2="${x}" y2="${y}" ` +
           `stroke="#${palette.primary}" stroke-width="2" stroke-opacity="0.4"/>`;
  });

  // Center circle
  svg += `<circle cx="${centerX}" cy="${centerY}" r="${centerRadius}" fill="#${palette.primary}"/>`;

  // Center label (if provided)
  if (centralTheme) {
    const maxChars = 12; // Fit within circle
    const displayText = centralTheme.length > maxChars
      ? centralTheme.substring(0, maxChars - 2) + '…'
      : centralTheme;

    svg += `<text x="${centerX}" y="${centerY}" ` +
           `text-anchor="middle" dominant-baseline="middle" ` +
           `font-size="14" font-weight="bold" fill="#${palette.text || 'FFFFFF'}">` +
           escapeXml(displayText) +
           `</text>`;
  }

  // Element nodes
  elements.forEach((el, i) => {
    const angle = i * angleStep - Math.PI / 2; // Start from top
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);

    // Element circle
    svg += `<circle cx="${x}" cy="${y}" r="${elementRadius}" fill="#${palette.accent}" stroke="#${palette.primary}" stroke-width="2"/>`;

    // Element label (below circle)
    const maxLabelChars = 20;
    const displayLabel = el.label.length > maxLabelChars
      ? el.label.substring(0, maxLabelChars - 2) + '…'
      : el.label;

    // Calculate label position (below circle, with offset for readability)
    const labelY = y + elementRadius + 20;

    svg += `<text x="${x}" y="${labelY}" ` +
           `text-anchor="middle" dominant-baseline="hanging" ` +
           `font-size="12" font-weight="600" fill="#${palette.text || 'F1F5F9'}">` +
           escapeXml(displayLabel) +
           `</text>`;

    // Icon placeholder (future: embed Lucide SVG)
    // For now, use a simple circle indicator
    if (el.icon) {
      svg += `<circle cx="${x}" cy="${y}" r="8" fill="#${palette.background}" opacity="0.8"/>`;
    }
  });

  svg += `</svg>`;
  return svg;
}

/**
 * Escape XML special characters for safe embedding in SVG
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Main entry point for diagram generation
 * Dispatches to specific diagram type builders
 *
 * @param diagramType - Type of diagram (currently only 'circular-ecosystem')
 * @param elements - Diagram elements
 * @param centralTheme - Optional center label
 * @param palette - Color palette
 * @returns SVG string
 */
export function buildDiagramSVG(
  diagramType: 'circular-ecosystem',
  elements: DiagramElement[],
  centralTheme: string | undefined,
  palette: DiagramPalette
): string {
  if (diagramType === 'circular-ecosystem') {
    return buildCircularEcosystemDiagram(elements, centralTheme, palette);
  }

  // Future: Add other diagram types here
  throw new Error(`Unsupported diagram type: ${diagramType}`);
}
