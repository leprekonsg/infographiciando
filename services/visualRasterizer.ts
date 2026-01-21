/**
 * Visual Rasterizer - Node.js Only Module
 *
 * This module uses @resvg/resvg-js which has native dependencies and CANNOT
 * run in the browser. It must only be dynamically imported in Node.js contexts.
 *
 * Architecture:
 * - Browser: Never imports this file (Vite will fail to bundle)
 * - Node/Server: Dynamically imports when needed for SVG → PNG conversion
 *
 * Usage:
 * ```typescript
 * // Dynamic import (only in Node context)
 * if (typeof window === 'undefined') {
 *   const { svgToPngBase64 } = await import('./visualRasterizer');
 *   const png = svgToPngBase64(svgString);
 * }
 * ```
 */

import { Resvg } from '@resvg/resvg-js';

/**
 * Convert SVG string to PNG buffer using resvg-js.
 *
 * IMPORTANT: This function ONLY works in Node.js environments.
 * It will fail in browser contexts due to native module dependencies.
 *
 * @param svgString - SVG markup (should have viewBox="0 0 1000 563")
 * @param width - Output width in pixels (default 1920 for high quality)
 * @param height - Output height in pixels (default 1080)
 * @returns PNG buffer as Base64 string
 * @throws Error if not running in Node.js or if rasterization fails
 */
export function svgToPngBase64(
    svgString: string,
    width: number = 1920,
    height: number = 1080
): string {
    // Runtime guard: ensure we're in Node.js
    if (typeof window !== 'undefined') {
        throw new Error(
            '[Visual Rasterizer] Cannot run in browser context. ' +
            'This module requires Node.js native modules (@resvg/resvg-js). ' +
            'Ensure this code only runs server-side.'
        );
    }

    try {
        const resvg = new Resvg(svgString, {
            fitTo: {
                mode: 'width',
                value: width
            }
        });

        const pngData = resvg.render();
        const pngBuffer = pngData.asPng();

        // Convert buffer to base64
        const base64 = pngBuffer.toString('base64');

        console.log(`[SVG→PNG] Rasterized SVG to PNG (${width}x${height}), size: ${Math.round(pngBuffer.length / 1024)}KB`);

        return base64;
    } catch (error: any) {
        console.error('[SVG→PNG] Rasterization failed:', error.message);
        throw new Error(`Failed to convert SVG to PNG: ${error.message}`);
    }
}

/**
 * Check if visual rasterizer is available in current environment
 */
export function isRasterizerAvailable(): boolean {
    return typeof window === 'undefined';
}
