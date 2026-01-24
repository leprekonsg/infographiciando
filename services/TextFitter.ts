/**
 * Text Fitter Utility
 * 
 * Fast pre-render text measurement using Canvas 2D API.
 * Used to calculate if text will fit within a given container width
 * BEFORE sending to the browser renderer.
 * 
 * "Measure twice, cut once" - prevents expensive browser render loops.
 */

/**
 * Font metrics for common presentation fonts
 * Pre-calculated character widths per font at 1em size
 */
const FONT_METRICS: Record<string, { avgCharWidth: number; heightFactor: number }> = {
    'Inter': { avgCharWidth: 0.52, heightFactor: 1.2 },
    'Roboto': { avgCharWidth: 0.50, heightFactor: 1.2 },
    'Arial': { avgCharWidth: 0.48, heightFactor: 1.15 },
    'Helvetica': { avgCharWidth: 0.48, heightFactor: 1.15 },
    'Open Sans': { avgCharWidth: 0.51, heightFactor: 1.2 },
    'Lato': { avgCharWidth: 0.50, heightFactor: 1.2 },
    'Montserrat': { avgCharWidth: 0.55, heightFactor: 1.25 },
    'Outfit': { avgCharWidth: 0.52, heightFactor: 1.2 },
    // Fallback for unknown fonts
    'default': { avgCharWidth: 0.50, heightFactor: 1.2 }
};

/**
 * Text measurement result
 */
export interface TextMeasurement {
    width: number; // Estimated width in em
    height: number; // Estimated height in em (with line height)
    lines: number; // Number of lines when wrapped
    fits: boolean; // Whether text fits in container
    suggestedFontSize?: number; // If doesn't fit, suggested font size
}

/**
 * Measure text dimensions for a given font and container
 * 
 * @param text - The text content to measure
 * @param fontFamily - Font family name
 * @param fontSize - Font size in pixels
 * @param containerWidth - Container width in pixels
 * @param containerHeight - Container height in pixels (optional)
 * @param lineHeight - Line height multiplier (default 1.4)
 * @returns TextMeasurement result
 */
export function measureText(
    text: string,
    fontFamily: string,
    fontSize: number,
    containerWidth: number,
    containerHeight?: number,
    lineHeight: number = 1.4
): TextMeasurement {
    // Input validation for edge cases
    if (!text || text.length === 0) {
        return { width: 0, height: 0, lines: 0, fits: true };
    }
    if (fontSize <= 0 || containerWidth <= 0) {
        return { width: 0, height: 0, lines: 0, fits: false, suggestedFontSize: 12 };
    }
    if (lineHeight <= 0) lineHeight = 1.4;

    const metrics = FONT_METRICS[fontFamily] || FONT_METRICS['default'];

    // Calculate character width at this font size
    const charWidth = fontSize * metrics.avgCharWidth;

    // Calculate how many characters fit per line
    const charsPerLine = Math.floor(containerWidth / charWidth);

    if (charsPerLine <= 0) {
        return {
            width: 0,
            height: 0,
            lines: 0,
            fits: false,
            suggestedFontSize: fontSize * 0.5
        };
    }

    // Word wrap calculation
    const words = text.split(/\s+/);
    let lines = 1;
    let currentLineLength = 0;

    for (const word of words) {
        if (currentLineLength + word.length + 1 > charsPerLine) {
            lines++;
            currentLineLength = word.length;
        } else {
            currentLineLength += word.length + 1;
        }
    }

    // Calculate dimensions
    const textWidth = Math.min(text.length * charWidth, containerWidth);
    const textHeight = lines * fontSize * lineHeight;

    // Check if it fits
    const fits = containerHeight !== undefined
        ? textHeight <= containerHeight
        : true;

    // Calculate suggested font size if doesn't fit
    let suggestedFontSize: number | undefined;
    if (!fits && containerHeight !== undefined) {
        const requiredScale = containerHeight / textHeight;
        suggestedFontSize = Math.floor(fontSize * requiredScale * 0.95); // 5% margin
    }

    return {
        width: textWidth,
        height: textHeight,
        lines,
        fits,
        suggestedFontSize
    };
}

/**
 * Calculate maximum characters that fit in a container
 */
export function maxCharsForContainer(
    containerWidth: number,
    fontFamily: string,
    fontSize: number
): number {
    const metrics = FONT_METRICS[fontFamily] || FONT_METRICS['default'];
    const charWidth = fontSize * metrics.avgCharWidth;
    return Math.floor(containerWidth / charWidth);
}

/**
 * Fit text to container by truncating with ellipsis
 */
export function fitTextToContainer(
    text: string,
    maxChars: number,
    addEllipsis: boolean = true
): string {
    if (text.length <= maxChars) return text;

    const ellipsis = addEllipsis ? '...' : '';
    const cutLength = maxChars - ellipsis.length;

    if (cutLength <= 0) return ellipsis;

    // Try to cut at word boundary
    const truncated = text.substring(0, cutLength);
    const lastSpace = truncated.lastIndexOf(' ');

    if (lastSpace > cutLength * 0.6) {
        return truncated.substring(0, lastSpace).trim() + ellipsis;
    }

    return truncated.trim() + ellipsis;
}

/**
 * Calculate optimal font size to fit text in container
 */
export function calculateOptimalFontSize(
    text: string,
    fontFamily: string,
    containerWidth: number,
    containerHeight: number,
    minFontSize: number = 12,
    maxFontSize: number = 72,
    lineHeight: number = 1.4
): number {
    let low = minFontSize;
    let high = maxFontSize;
    let optimalSize = minFontSize;

    // Binary search for optimal font size
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const measurement = measureText(text, fontFamily, mid, containerWidth, containerHeight, lineHeight);

        if (measurement.fits) {
            optimalSize = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return optimalSize;
}

/**
 * Split text into lines that fit container width
 */
export function wrapTextToWidth(
    text: string,
    fontFamily: string,
    fontSize: number,
    containerWidth: number
): string[] {
    const maxChars = maxCharsForContainer(containerWidth, fontFamily, fontSize);
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;

        if (testLine.length <= maxChars) {
            currentLine = testLine;
        } else {
            if (currentLine) lines.push(currentLine);
            currentLine = word;
        }
    }

    if (currentLine) lines.push(currentLine);

    return lines;
}
