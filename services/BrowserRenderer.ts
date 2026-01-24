/**
 * Browser Renderer - Headless Playwright-based Layout Engine
 * 
 * Replaces the hardcoded SpatialLayoutEngine with actual browser-based rendering.
 * 
 * Workflow:
 * 1. Render React slide component in headless Chrome
 * 2. Measure actual DOM element dimensions
 * 3. Detect CSS overflow conditions
 * 4. Return precise pixel metrics for PPTX mapping
 * 
 * Why this works better:
 * - CSS Flexbox/Grid handles layout natively
 * - No "guess if text fits" - browser tells us
 * - Eliminates Qwen-VL critique loop (CSS prevents overlap by definition)
 */

import type { Browser, Page } from 'playwright';

/**
 * Browser metrics returned after rendering
 */
export interface BrowserMetrics {
    elements: Map<string, ElementMetrics>;
    textOverflow: boolean;
    overflowDetails: OverflowInfo[];
    slideWidth: number;
    slideHeight: number;
    renderTimeMs: number;
}

export interface ElementMetrics {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    actualTextHeight?: number;
    fontSize?: number;
    isOverflowing?: boolean;
}

export interface OverflowInfo {
    elementId: string;
    type: 'text' | 'container';
    overflowAmount: number; // Pixels of overflow
    suggestedFontReduction?: number;
}

/**
 * PPTX coordinate mapping (0-10 x 0-5.625 grid)
 */
export interface PptxCoordinates {
    x: number;
    y: number;
    w: number;
    h: number;
}

// Slide dimensions (16:9 aspect ratio)
const SLIDE_WIDTH = 1920;
const SLIDE_HEIGHT = 1080;
const PPTX_WIDTH = 10;
const PPTX_HEIGHT = 5.625;

/**
 * DOM-to-PPTX Safety Buffer Configuration
 * 
 * Browsers (Skia/CoreText) and PowerPoint (DirectWrite/GDI) render text differently.
 * Different slide types need different buffers:
 * - Title slides: minimal text, tight buffer (1.05x)
 * - Dense content: lots of text, higher buffer (1.20x)
 * - Default: balanced (1.15x)
 * 
 * This should be controller-configurable, not hardcoded.
 */
export interface SafetyBufferConfig {
    default: number;
    titleSlide: number;
    denseContent: number;
    serifFont: number; // Times New Roman, etc. have different metrics
}

const DEFAULT_SAFETY_BUFFERS: SafetyBufferConfig = {
    default: 1.15,
    titleSlide: 1.05,
    denseContent: 1.20,
    serifFont: 1.25
};

/**
 * Get appropriate safety buffer for content type
 */
export function getSafetyBuffer(
    slideType?: string,
    fontFamily?: string,
    customConfig?: Partial<SafetyBufferConfig>
): number {
    const config = { ...DEFAULT_SAFETY_BUFFERS, ...customConfig };

    // Serif fonts need more buffer
    if (fontFamily && /times|georgia|serif|palatino/i.test(fontFamily)) {
        return config.serifFont;
    }

    // Title slides need less buffer
    if (slideType === 'title-slide' || slideType === 'hero-centered') {
        return config.titleSlide;
    }

    // Dense layouts need more buffer
    if (slideType === 'bento-grid' || slideType === 'dashboard-tiles') {
        return config.denseContent;
    }

    return config.default;
}

/**
 * Browser Renderer class - manages headless browser lifecycle
 */
export class BrowserRenderer {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private isInitialized: boolean = false;

    /**
     * Initialize the browser instance
     * Call this once at app startup for performance
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) return;

        console.log('[BROWSER_RENDERER] Initializing headless browser...');

        try {
            // Dynamic import to avoid bundling issues in browser context
            const playwright = await import('playwright');

            this.browser = await playwright.chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ]
            });

            this.page = await this.browser.newPage();
            await this.page.setViewportSize({ width: SLIDE_WIDTH, height: SLIDE_HEIGHT });

            this.isInitialized = true;
            console.log('[BROWSER_RENDERER] Browser initialized successfully');
        } catch (error: any) {
            console.error('[BROWSER_RENDERER] Failed to initialize browser:', error.message);
            throw error;
        }
    }

    /**
     * Render HTML content and measure all elements
     */
    async renderAndMeasure(htmlContent: string): Promise<BrowserMetrics> {
        if (!this.isInitialized || !this.page) {
            await this.initialize();
        }

        const startTime = Date.now();

        try {
            // Wrap content with measurement script
            const fullHtml = this.wrapWithMeasurement(htmlContent);

            // Load content into page
            await this.page!.setContent(fullHtml);

            // Wait for fonts to load (with timeout)
            await this.page!.waitForFunction(() =>
                (document as any).fonts?.ready?.then(() => true) ?? true,
                { timeout: 5000 }
            ).catch(() => {
                console.warn('[BROWSER_RENDERER] Font loading timed out, continuing...');
            });

            // Collect measurements via injected script
            const measurements = await this.page!.evaluate(() => {
                const elements = new Map<string, any>();
                const overflowDetails: any[] = [];
                let hasOverflow = false;

                // Measure all elements with data-zone-id attribute
                document.querySelectorAll('[data-zone-id]').forEach((el) => {
                    const element = el as HTMLElement;
                    const id = element.dataset.zoneId;
                    if (!id) return; // Skip elements without zoneId

                    const rect = element.getBoundingClientRect();

                    // Check for text overflow
                    const isOverflowing =
                        element.scrollHeight > element.clientHeight ||
                        element.scrollWidth > element.clientWidth;

                    if (isOverflowing) {
                        hasOverflow = true;
                        const overflowAmount = Math.max(
                            element.scrollHeight - element.clientHeight,
                            element.scrollWidth - element.clientWidth
                        );
                        overflowDetails.push({
                            elementId: id,
                            type: 'text',
                            overflowAmount,
                            suggestedFontReduction: Math.ceil(overflowAmount / 10)
                        });
                    }

                    elements.set(id, {
                        id,
                        x: rect.left,
                        y: rect.top,
                        width: rect.width,
                        height: rect.height,
                        actualTextHeight: element.scrollHeight,
                        fontSize: parseFloat(getComputedStyle(element).fontSize) || 16,
                        isOverflowing
                    });
                });

                return {
                    elements: Object.fromEntries(elements),
                    hasOverflow,
                    overflowDetails
                };
            });

            const renderTimeMs = Date.now() - startTime;

            return {
                elements: new Map(Object.entries(measurements.elements)),
                textOverflow: measurements.hasOverflow,
                overflowDetails: measurements.overflowDetails,
                slideWidth: SLIDE_WIDTH,
                slideHeight: SLIDE_HEIGHT,
                renderTimeMs
            };
        } catch (error: any) {
            console.error('[BROWSER_RENDERER] Render failed:', error.message);
            // Return empty metrics on error
            return {
                elements: new Map(),
                textOverflow: false,
                overflowDetails: [],
                slideWidth: SLIDE_WIDTH,
                slideHeight: SLIDE_HEIGHT,
                renderTimeMs: Date.now() - startTime
            };
        }
    }

    /**
     * Convert browser pixel coordinates to PPTX coordinates
     * Applies configurable safety buffer to height based on slide/font type
     */
    static toPptxCoordinates(
        element: ElementMetrics,
        slideType?: string,
        fontFamily?: string
    ): PptxCoordinates {
        const safetyBuffer = getSafetyBuffer(slideType, fontFamily);
        return {
            x: (element.x / SLIDE_WIDTH) * PPTX_WIDTH,
            y: (element.y / SLIDE_HEIGHT) * PPTX_HEIGHT,
            w: (element.width / SLIDE_WIDTH) * PPTX_WIDTH,
            // Apply safety buffer to height only (text wrapping is vertical)
            h: (element.height / SLIDE_HEIGHT) * PPTX_HEIGHT * safetyBuffer
        };
    }

    /**
     * Wrap content with CSS reset and measurement utilities
     */
    private wrapWithMeasurement(content: string): string {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        /* CSS Reset */
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        /* Slide container */
        .slide-container {
            width: ${SLIDE_WIDTH}px;
            height: ${SLIDE_HEIGHT}px;
            position: relative;
            overflow: hidden;
            font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
        }

        /* Zone styling */
        .zone {
            position: absolute;
            overflow: hidden;
        }

        /* Premium typography */
        h1, .hero-text {
            font-size: 48px;
            font-weight: 700;
            letter-spacing: 0.5px;
        }

        h2, .title-text {
            font-size: 36px;
            font-weight: 600;
            letter-spacing: 0.3px;
        }

        .body-text {
            font-size: 20px;
            font-weight: 400;
            line-height: 1.5;
        }

        .metric-value {
            font-size: 42px;
            font-weight: 700;
        }

        .metric-label {
            font-size: 14px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 1.5px;
        }

        /* Flexbox layouts */
        .flex-row { display: flex; flex-direction: row; }
        .flex-col { display: flex; flex-direction: column; }
        .flex-wrap { flex-wrap: wrap; }
        .justify-center { justify-content: center; }
        .justify-between { justify-content: space-between; }
        .items-center { align-items: center; }
        .gap-sm { gap: 8px; }
        .gap-md { gap: 16px; }
        .gap-lg { gap: 24px; }

        /* Grid layouts */
        .grid-2x2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .grid-3x1 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
        .grid-bento { display: grid; grid-template-columns: 2fr 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 16px; }

        /* Cards */
        .card {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 12px;
            padding: 20px;
            backdrop-filter: blur(10px);
        }

        /* Import Inter font */
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    </style>
</head>
<body>
    <div class="slide-container">
        ${content}
    </div>
</body>
</html>`;
    }

    /**
     * Capture screenshot of rendered slide
     */
    async captureScreenshot(): Promise<Buffer> {
        if (!this.page) throw new Error('Browser not initialized');
        return await this.page.screenshot({ type: 'png' });
    }

    /**
     * Cleanup browser resources
     */
    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
            this.isInitialized = false;
            console.log('[BROWSER_RENDERER] Browser closed');
        }
    }
}

// Singleton instance
let _rendererInstance: BrowserRenderer | null = null;

/**
 * Get or create shared browser renderer instance
 */
export function getBrowserRenderer(): BrowserRenderer {
    if (!_rendererInstance) {
        _rendererInstance = new BrowserRenderer();
    }
    return _rendererInstance;
}

/**
 * Generate HTML for a slide from SlideBlueprint
 */
export function generateSlideHtml(
    slideBlueprint: any,
    styleGuide: any
): string {
    const { layoutId, title, components } = slideBlueprint;
    const { colorPalette } = styleGuide;

    const bgColor = colorPalette?.background || '#0f172a';
    const textColor = colorPalette?.text || '#f8fafc';
    const primaryColor = colorPalette?.primary || '#10b981';

    let html = `<div data-zone-id="slide" style="background: ${bgColor}; color: ${textColor}; width: 100%; height: 100%; padding: 40px;">`;

    // Add title
    html += `<h2 data-zone-id="title" style="color: ${textColor}; margin-bottom: 24px;">${escapeHtml(title)}</h2>`;

    // Render components based on layout
    html += `<div class="content-area" data-zone-id="content" style="flex: 1;">`;

    for (const component of components) {
        html += renderComponent(component, { primaryColor, textColor });
    }

    html += `</div></div>`;

    return html;
}

/**
 * Render a single component to HTML
 */
function renderComponent(component: any, colors: { primaryColor: string; textColor: string }): string {
    const { type, zoneId, content } = component;

    switch (type) {
        case 'title-section':
            return `
                <div data-zone-id="${zoneId}" class="flex-col gap-sm">
                    <h1 class="hero-text">${escapeHtml(content?.title || '')}</h1>
                    ${content?.subtitle ? `<p class="body-text" style="opacity: 0.8;">${escapeHtml(content.subtitle)}</p>` : ''}
                </div>`;

        case 'text-bullets':
            const items = content?.items || [];
            return `
                <ul data-zone-id="${zoneId}" style="list-style: none; padding-left: 0;">
                    ${items.map((item: string) => `
                        <li class="body-text flex-row gap-sm items-center" style="margin-bottom: 12px;">
                            <span style="color: ${colors.primaryColor};">•</span>
                            <span>${escapeHtml(item)}</span>
                        </li>
                    `).join('')}
                </ul>`;

        case 'metric-cards':
            const metrics = content?.metrics || [];
            return `
                <div data-zone-id="${zoneId}" class="grid-3x1">
                    ${metrics.slice(0, 4).map((m: any) => `
                        <div class="card flex-col gap-sm">
                            <span class="metric-value" style="color: ${colors.primaryColor};">${escapeHtml(m.value || '')}</span>
                            <span class="metric-label" style="opacity: 0.6;">${escapeHtml(m.label || '')}</span>
                        </div>
                    `).join('')}
                </div>`;

        case 'process-flow':
            const steps = content?.steps || [];
            return `
                <div data-zone-id="${zoneId}" class="flex-row justify-between gap-lg">
                    ${steps.map((s: any, i: number) => `
                        <div class="flex-col items-center gap-sm" style="flex: 1;">
                            <div style="width: 48px; height: 48px; border-radius: 50%; background: ${colors.primaryColor}; display: flex; align-items: center; justify-content: center; font-weight: 700;">${i + 1}</div>
                            <h3 style="font-size: 18px; font-weight: 600;">${escapeHtml(s.title || '')}</h3>
                            <p class="body-text" style="opacity: 0.7; text-align: center;">${escapeHtml(s.description || '')}</p>
                        </div>
                    `).join('')}
                </div>`;

        default:
            return `<div data-zone-id="${zoneId}" class="body-text">Content placeholder</div>`;
    }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
