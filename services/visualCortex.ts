/**
 * Visual Cortex Service - Qwen-VL Integration
 *
 * Implements external visual validation using Qwen3-VL-Plus for:
 * - Bounding box detection
 * - Spatial issue identification
 * - Contrast analysis
 * - Empty region detection
 *
 * Based on Alibaba Cloud's DashScope API (OpenAI-compatible)
 * Model: qwen3-vl-plus-2025-12-19
 * Pricing: Input $0.2/1M tokens, Output $1.6/1M tokens
 *
 * ============================================================================
 * TWO-TIER RENDERING PIPELINE (Render Fidelity Contract)
 * ============================================================================
 *
 * TIER 1: Fast Path (Default) - SVG Proxy Rendering
 * ------------------------------------------------
 * Pipeline: SVG proxy → PNG (resvg-js) → Qwen-VL
 * Speed: ~200-500ms per critique
 * Use for: Iterative refinement in System 2 loop
 * Pros:
 *   - Deterministic and fast
 *   - No Chromium/browser dependency
 *   - Works server-side in Node.js
 *   - Perfectly aligned with existing SVG proxy architecture
 * Cons:
 *   - SVG rendering may differ slightly from PPTX text wrapping
 *   - Font metrics approximated
 * Render Fidelity: "svg-proxy"
 *
 * TIER 2: Slow Path (Escalation) - PPTX Rendering
 * ------------------------------------------------
 * Pipeline: PPTX → LibreOffice → PDF → PNG → Qwen-VL
 * Speed: ~2-5s per critique
 * Use for:
 *   - Persistent issues after 2+ SVG-based repairs
 *   - Final quality gate before delivery
 *   - When exact PPTX fidelity is critical
 * Pros:
 *   - Validates actual PPTX rendering
 *   - Catches PPTX-specific text wrapping/font issues
 * Cons:
 *   - Requires LibreOffice + Ghostscript pipeline
 *   - Slower (2-5s vs 200-500ms)
 *   - More ops complexity
 * Render Fidelity: "pptx-render"
 *
 * ESCALATION TRIGGER:
 * Use Tier 2 when:
 * - Same issue category appears 2+ times in System 2 loop
 * - fit_score < 0.5 after max reroutes
 * - User explicitly requests PPTX-fidelity validation
 *
 * ============================================================================
 */

import { CostTracker } from './interactionsClient';

// Qwen-VL Model Configuration
const QWEN_VL_MODEL = 'qwen3-vl-plus-2025-12-19';
const QWEN_API_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const QWEN_VL_PROXY_URL = process.env.QWEN_VL_PROXY_URL || '';

// Note: Pricing ($0.2/$1.6 per 1M tokens) is handled by CostTracker.addQwenVLCost()

// Render fidelity contract
export type RenderFidelity = 'svg-proxy' | 'pptx-render';

/**
 * Convert SVG string to PNG buffer using Node-only rasterizer.
 *
 * IMPORTANT: This function dynamically imports visualRasterizer.ts which uses
 * @resvg/resvg-js (a Node.js native module). It will fail in browser contexts.
 *
 * Architecture:
 * - Node.js: Works correctly, fast rasterization
 * - Browser: Throws error (native modules not available)
 *
 * @param svgString - SVG markup (should have viewBox="0 0 1000 563")
 * @param width - Output width in pixels (default 1920 for high quality)
 * @param height - Output height in pixels (default 1080)
 * @returns PNG buffer as Base64 string
 * @throws Error if not in Node.js environment
 */
export async function svgToPngBase64(
    svgString: string,
    width: number = 1920,
    height: number = 1080
): Promise<string> {
    // Runtime guard: ensure we're in Node.js
    if (typeof window !== 'undefined') {
        throw new Error(
            '[Visual Cortex] SVG rasterization requires Node.js environment. ' +
            'This operation cannot run in the browser due to native module dependencies.'
        );
    }

    try {
        // Dynamic import: only loads visualRasterizer in Node.js context
        // This prevents Vite from trying to bundle @resvg/resvg-js
        const { svgToPngBase64: rasterize } = await import('./visualRasterizer');
        return rasterize(svgString, width, height);
    } catch (error: any) {
        console.error('[Visual Cortex] Failed to load rasterizer:', error.message);
        throw new Error(`SVG rasterization failed: ${error.message}`);
    }
}

/**
 * Visual critique result from Qwen-VL
 */
export interface VisualCritiqueResult {
    overall_score: number; // 0-100
    issues: Array<{
        category: 'text_overlap' | 'contrast' | 'alignment' | 'spacing' | 'density';
        severity: 'critical' | 'warning' | 'info';
        location?: { x: number; y: number; w: number; h: number }; // Normalized 0-1
        description: string;
        suggested_fix?: string;
    }>;
    empty_regions: Array<{
        bbox: { x: number; y: number; w: number; h: number }; // Normalized 0-1
        label: 'safe_for_text' | 'safe_for_image' | 'marginal';
        area_percentage: number;
    }>;
    color_analysis?: {
        primary_color: string; // Hex
        secondary_colors: string[];
        contrast_ratio: number; // WCAG ratio
    };
    overall_verdict: 'accept' | 'flag_for_review' | 'requires_repair';
}

/**
 * Qwen-VL Client for visual analysis
 */
class QwenVLClient {
    private apiKey: string;

    constructor() {
        this.apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '';
        if (!this.apiKey) {
            console.warn('[QWEN-VL] API key not configured. Set DASHSCOPE_API_KEY environment variable.');
            console.warn('[QWEN-VL] Visual cortex features will be disabled.');
        }
    }

    /**
     * Check if Qwen-VL is configured and available
     */
    isAvailable(): boolean {
        return !!this.apiKey;
    }

    /**
     * Get visual critique from Qwen-VL
     */
    async getVisualCritique(
        slideImageBase64: string,
        slideWidth: number = 960,
        slideHeight: number = 540,
        costTracker?: CostTracker
    ): Promise<VisualCritiqueResult> {
        if (!this.isAvailable()) {
            throw new Error('Qwen-VL API key not configured');
        }

        console.log(`[QWEN-VL] Starting visual critique (dimensions: ${slideWidth}x${slideHeight})`);
        const startTime = Date.now();

        const critiquePrompt = `Analyze this slide image and provide detailed visual feedback.

ANALYZE FOR:
1. Text Overlap - Any text that overlaps elements or runs off screen?
2. Contrast - Is text readable against background (WCAG AA: 4.5:1)?
3. Alignment - Are elements properly aligned? Consistent spacing?
4. Spacing - Is there too much / too little whitespace?
5. Density - Is content packed too tightly or spread out?

OUTPUT JSON with structure:
{
  "overall_score": <0-100>,
  "issues": [
    {
      "category": "text_overlap" | "contrast" | "alignment" | "spacing" | "density",
      "severity": "critical" | "warning" | "info",
      "location": { "x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1> },
      "description": "...",
      "suggested_fix": "..."
    }
  ],
  "empty_regions": [
    {
      "bbox": { "x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1> },
      "label": "safe_for_text" | "safe_for_image" | "marginal",
      "area_percentage": <0-100>
    }
  ],
  "color_analysis": {
    "primary_color": "#XXXXXX",
    "secondary_colors": ["#XXXXXX"],
    "contrast_ratio": <number>
  },
  "overall_verdict": "accept" | "flag_for_review" | "requires_repair"
}

IMPORTANT:
- Coordinates are normalized 0-1 (not pixels)
- Focus on actionable issues
- Be concise in descriptions
- Output ONLY valid JSON`;

        try {
            const response = await fetch(`${QWEN_API_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: QWEN_VL_MODEL,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'image_url',
                                    image_url: {
                                        url: `data:image/jpeg;base64,${slideImageBase64}`
                                    }
                                },
                                {
                                    type: 'text',
                                    text: critiquePrompt
                                }
                            ]
                        }
                    ],
                    max_tokens: 2048,
                    temperature: 0.1
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Qwen-VL API error (${response.status}): ${errorText}`);
            }

            const data = await response.json();

            // Track costs using proper type-safe method
            if (costTracker && data.usage) {
                const inputTokens = data.usage.prompt_tokens || 0;
                const outputTokens = data.usage.completion_tokens || 0;

                costTracker.addQwenVLCost(inputTokens, outputTokens);

                const duration = Date.now() - startTime;
                console.log(`[QWEN-VL] Critique complete in ${duration}ms (tokens: ${inputTokens} in / ${outputTokens} out)`);
            }

            const responseText = data.choices?.[0]?.message?.content || '';

            // Parse JSON response
            const parsed = this.parseJsonResponse(responseText);

            // Log critique summary
            const result = parsed as VisualCritiqueResult;
            console.log(`[QWEN-VL] Critique result: score=${result.overall_score}, verdict=${result.overall_verdict}, issues=${result.issues?.length || 0}`);

            return result;
        } catch (error: any) {
            console.error('[QWEN-VL] Visual critique error:', error.message);
            throw error;
        }
    }

    /**
     * Get visual critique with structured repair instructions (Visual Architect mode)
     */
    async getVisualCritiqueWithRepairs(
        slideImageBase64: string,
        slideWidth: number = 960,
        slideHeight: number = 540,
        currentComponents: any[], // For component ID mapping
        costTracker?: CostTracker
    ): Promise<any> {
        if (!this.isAvailable()) {
            throw new Error('Qwen-VL API key not configured');
        }

        console.log(`[QWEN-VL ARCHITECT] Starting critique with repair output (${slideWidth}x${slideHeight})`);
        const startTime = Date.now();

        const architectPrompt = `ANALYZE this slide for visual quality and output STRUCTURED REPAIRS.

ANALYZE FOR:
1. Spatial Issues - Overlap, out-of-bounds content, zone violations
2. Contrast - WCAG AA compliance (4.5:1 for text)
3. Alignment - Grid adherence, consistent margins
4. Spacing - Crowding, negative space balance
5. Hierarchy - Visual weight matches importance

OUTPUT JSON:
{
  "overall_score": <0-100>,
  "repairs": [
    {
      "component_id": "<component-type>-<index>",
      "action": "resize" | "reposition" | "adjust_color" | "adjust_spacing" | "simplify_content",
      "params": { <action-specific params> },
      "reason": "<why this repair is needed>"
    }
  ],
  "issues": [
    {
      "category": "text_overlap" | "contrast" | "alignment" | "spacing" | "density",
      "severity": "critical" | "warning" | "info",
      "description": "...",
      "suggested_fix": "..."
    }
  ],
  "empty_regions": [
    {
      "bbox": { "x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1> },
      "label": "safe_for_text" | "safe_for_image" | "marginal",
      "area_percentage": <0-100>
    }
  ],
  "verdict": "accept" | "requires_repair" | "flag_for_review"
}

IMPORTANT:
- Component IDs format: "{type}-{index}" (e.g., "text-bullets-0", "metric-cards-1")
- Coordinates normalized 0-1 (not pixels) → will be converted to slide units
- Only suggest repairs that improve score by ≥5 points
- Preserve ALL text content (spatial changes only)
- Output ONLY valid JSON`;

        try {
            const response = await fetch(`${QWEN_API_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: QWEN_VL_MODEL,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'image_url',
                                    image_url: {
                                        url: `data:image/jpeg;base64,${slideImageBase64}`
                                    }
                                },
                                {
                                    type: 'text',
                                    text: architectPrompt
                                }
                            ]
                        }
                    ],
                    max_tokens: 2048,
                    temperature: 0.1
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Qwen-VL API error (${response.status}): ${errorText}`);
            }

            const data = await response.json();

            // Track costs
            if (costTracker && data.usage) {
                const inputTokens = data.usage.prompt_tokens || 0;
                const outputTokens = data.usage.completion_tokens || 0;
                costTracker.addQwenVLCost(inputTokens, outputTokens);

                const duration = Date.now() - startTime;
                console.log(`[QWEN-VL ARCHITECT] Critique complete in ${duration}ms (tokens: ${inputTokens} in / ${outputTokens} out)`);
            }

            const responseText = data.choices?.[0]?.message?.content || '';
            const parsed = this.parseJsonResponse(responseText);

            console.log(`[QWEN-VL ARCHITECT] Result: score=${parsed.overall_score}, verdict=${parsed.verdict}, repairs=${parsed.repairs?.length || 0}`);

            return parsed;
        } catch (error: any) {
            console.error('[QWEN-VL ARCHITECT] Critique error:', error.message);
            throw error;
        }
    }

    /**
     * Parse JSON response from Qwen-VL (handles code blocks and malformed JSON)
     */
    private parseJsonResponse(text: string): any {
        // Strategy 1: Direct parse
        try {
            return JSON.parse(text.trim());
        } catch {
            // Continue to extraction strategies
        }

        // Strategy 2: Extract from ```json blocks
        if (text.includes('```json')) {
            try {
                const extracted = text.split('```json')[1].split('```')[0].trim();
                return JSON.parse(extracted);
            } catch {
                // Continue
            }
        }

        // Strategy 3: Extract from ``` blocks
        if (text.includes('```')) {
            try {
                const parts = text.split('```');
                if (parts.length >= 2) {
                    let extracted = parts[1];
                    if (extracted.startsWith('json')) {
                        extracted = extracted.substring(4);
                    }
                    return JSON.parse(extracted.trim());
                }
            } catch {
                // Continue
            }
        }

        // Strategy 4: Regex extraction
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch {
                // Continue
            }
        }

        console.error('[QWEN-VL] Failed to parse JSON response:', text.substring(0, 200));
        throw new Error('Failed to parse Qwen-VL response');
    }
}

async function callQwenProxy<T = any>(
    endpoint: string,
    payload: any,
    costTracker?: CostTracker
): Promise<T> {
    if (!QWEN_VL_PROXY_URL) {
        throw new Error('QWEN_VL_PROXY_URL is not configured');
    }

    const response = await fetch(`${QWEN_VL_PROXY_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Qwen-VL proxy error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (costTracker && data?.usage) {
        costTracker.addQwenVLCost(data.usage.inputTokens || 0, data.usage.outputTokens || 0);
    }

    return data?.result as T;
}

// Singleton instance
const qwenVLClient = new QwenVLClient();

/**
 * Get visual critique for a slide from SVG proxy (RECOMMENDED - Fast Path)
 *
 * This is the default critique pipeline:
 * SVG proxy → PNG (resvg) → Qwen-VL critique
 *
 * @param svgString - SVG markup from generateSvgProxy()
 * @param costTracker - Optional cost tracker
 * @returns Visual critique result with render fidelity metadata
 */
export async function getVisualCritiqueFromSvg(
    svgString: string,
    costTracker?: CostTracker
): Promise<(VisualCritiqueResult & { renderFidelity: RenderFidelity }) | null> {
    const sanitizeSvg = (input: string) =>
        input.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[a-fA-F0-9]+;)/g, '&amp;');

    const safeSvg = sanitizeSvg(svgString);

    if (!qwenVLClient.isAvailable()) {
        if (!QWEN_VL_PROXY_URL) {
            console.warn('[QWEN-VL] Skipping visual critique - API not configured');
            return null;
        }
    }

    if (typeof window !== 'undefined') {
        if (!QWEN_VL_PROXY_URL) {
            console.warn('[QWEN-VL] Skipping SVG proxy critique in browser (requires Node.js rasterizer).');
            return null;
        }

        try {
            console.log('[QWEN-VL] Proxy path: SVG → Qwen-VL via backend');
            const critique = await callQwenProxy<VisualCritiqueResult>(
                '/api/qwen/critique',
                { svgString: safeSvg, slideWidth: 1920, slideHeight: 1080 },
                costTracker
            );

            return { ...critique, renderFidelity: 'svg-proxy' as RenderFidelity };
        } catch (error: any) {
            console.error('[QWEN-VL] Proxy SVG critique failed:', error.message);
            return null;
        }
    }

    try {
        console.log('[QWEN-VL] Fast path: SVG proxy → PNG → Qwen-VL');
        const svgRasterizeStart = Date.now();

        // Step 1: Rasterize SVG to PNG using Node-only rasterizer (dynamic import)
        const pngBase64 = await svgToPngBase64(safeSvg, 1920, 1080);
        const svgRasterizeDuration = Date.now() - svgRasterizeStart;
        console.log(`[QWEN-VL] SVG rasterization complete in ${svgRasterizeDuration}ms`);

        // Step 2: Send to Qwen-VL
        const critique = await qwenVLClient.getVisualCritique(pngBase64, 1920, 1080, costTracker);

        // Step 3: Add render fidelity contract
        console.log('[QWEN-VL] Fast path complete, returning critique with svg-proxy fidelity');
        return {
            ...critique,
            renderFidelity: 'svg-proxy' as RenderFidelity
        };
    } catch (error: any) {
        console.error('[QWEN-VL] SVG critique failed:', error.message);
        return null;
    }
}

/**
 * Get visual critique for a slide image (Direct Base64 - for PPTX escalation path)
 *
 * This is the escalation critique pipeline (slow but accurate):
 * PPTX → LibreOffice → PDF → PNG → Qwen-VL critique
 *
 * Use this when:
 * - Persistent issues after multiple SVG-based repairs
 * - Need to validate real PPTX rendering fidelity
 * - Final quality gate before delivery
 *
 * @param slideImageBase64 - Base64-encoded slide image (from PPTX render)
 * @param slideWidth - Slide width in pixels
 * @param slideHeight - Slide height in pixels
 * @param costTracker - Optional cost tracker
 * @returns Visual critique result with render fidelity metadata
 */
export async function getVisualCritiqueFromImage(
    slideImageBase64: string,
    slideWidth: number = 1920,
    slideHeight: number = 1080,
    costTracker?: CostTracker
): Promise<(VisualCritiqueResult & { renderFidelity: RenderFidelity }) | null> {
    if (!qwenVLClient.isAvailable()) {
        if (!QWEN_VL_PROXY_URL) {
            console.warn('[QWEN-VL] Skipping visual critique - API not configured');
            return null;
        }
    }

    try {
        if (typeof window !== 'undefined') {
            if (!QWEN_VL_PROXY_URL) {
                console.warn('[QWEN-VL] Skipping image critique in browser (requires proxy).');
                return null;
            }

            console.log(`[QWEN-VL] Proxy path: PPTX render → Qwen-VL (dimensions: ${slideWidth}x${slideHeight})`);
            const critique = await callQwenProxy<VisualCritiqueResult>(
                '/api/qwen/critique',
                { imageBase64: slideImageBase64, slideWidth, slideHeight },
                costTracker
            );

            return { ...critique, renderFidelity: 'pptx-render' as RenderFidelity };
        }

        console.log(`[QWEN-VL] Slow path: PPTX render → Qwen-VL (dimensions: ${slideWidth}x${slideHeight})`);

        const critique = await qwenVLClient.getVisualCritique(slideImageBase64, slideWidth, slideHeight, costTracker);

        console.log('[QWEN-VL] Slow path complete, returning critique with pptx-render fidelity');
        return {
            ...critique,
            renderFidelity: 'pptx-render' as RenderFidelity
        };
    } catch (error: any) {
        console.error('[QWEN-VL] Image critique failed:', error.message);
        return null;
    }
}

/**
 * Legacy wrapper for backward compatibility
 * @deprecated Use getVisualCritiqueFromSvg() or getVisualCritiqueFromImage() instead
 */
export async function getVisualCritiqueFromQwen(
    slideImageBase64: string,
    slideWidth: number = 960,
    slideHeight: number = 540,
    costTracker?: CostTracker
): Promise<VisualCritiqueResult | null> {
    console.warn('[QWEN-VL] Using deprecated getVisualCritiqueFromQwen(). Prefer getVisualCritiqueFromSvg() for SVG proxy path.');
    return getVisualCritiqueFromImage(slideImageBase64, slideWidth, slideHeight, costTracker);
}

/**
 * Check if Qwen-VL visual cortex is available
 */
export function isQwenVLAvailable(): boolean {
    const isNode = typeof window === 'undefined';

    if (isNode) {
        return qwenVLClient.isAvailable();
    }

    if (QWEN_VL_PROXY_URL) return true;

    console.warn('[QWEN-VL] Visual critique unavailable in browser. Configure QWEN_VL_PROXY_URL for backend proxy.');
    return false;
}

// --- VISUAL ARCHITECT IMPLEMENTATION ---

import type {
    SlideNode,
    GlobalStyleGuide,
    RouterDecision,
    RepairAction,
    VisualArchitectResult
} from '../types/slideTypes';

/**
 * Apply structured repairs to a slide
 * Modifies component positions, sizes, colors based on Qwen-VL repair instructions
 */
function applyRepairsToSlide(
    slide: SlideNode,
    repairs: RepairAction[],
    styleGuide: GlobalStyleGuide
): SlideNode {
    const updatedSlide = JSON.parse(JSON.stringify(slide)); // Deep clone

    for (const repair of repairs) {
        const { component_id, action, params, reason } = repair;

        // Parse component ID: "text-bullets-0" → type="text-bullets", index=0
        const parts = component_id.split('-');
        const indexStr = parts[parts.length - 1];
        const componentType = parts.slice(0, -1).join('-');
        const componentIndex = parseInt(indexStr || '0');

        // Find component in layoutPlan
        if (!updatedSlide.layoutPlan?.components) {
            console.warn(`[REPAIR] No layout plan found in slide`);
            continue;
        }

        const component = updatedSlide.layoutPlan.components[componentIndex];
        if (!component) {
            console.warn(`[REPAIR] Component not found: ${component_id}`);
            continue;
        }

        // Apply action
        switch (action) {
            case 'resize':
                console.log(`[REPAIR] Resizing ${component_id}: ${params.width}x${params.height} (${reason})`);
                // Note: Resizing would require spatial metadata - for now, log only
                // Future: Add spatial hints to components for zone reallocation
                break;

            case 'reposition':
                console.log(`[REPAIR] Repositioning ${component_id}: (${params.x}, ${params.y}) (${reason})`);
                // Note: Repositioning would require zone coordinate system - for now, log only
                // Future: Update zone coordinates in spatial renderer
                break;

            case 'adjust_color':
                console.log(`[REPAIR] Adjusting color ${component_id}: ${params.color} (${reason})`);
                // Apply color changes to component data
                if (component.type === 'text-bullets' && 'textColor' in component) {
                    (component as any).textColor = params.color;
                } else if (component.type === 'metric-cards' && 'metrics' in component) {
                    const metrics = (component as any).metrics;
                    if (Array.isArray(metrics)) {
                        metrics.forEach((m: any) => m.color = params.color);
                    }
                }
                break;

            case 'adjust_spacing':
                console.log(`[REPAIR] Adjusting spacing ${component_id}: padding=${params.padding} (${reason})`);
                // Note: Spacing would require spatial metadata - for now, log only
                // Future: Update padding/margin metadata
                break;

            case 'simplify_content':
                console.log(`[REPAIR] Simplifying ${component_id}: remove ${params.removeCount} items (${reason})`);
                // Truncate arrays (bullets, metrics, etc.)
                if (component.type === 'text-bullets' && 'content' in component) {
                    const content = (component as any).content;
                    if (Array.isArray(content)) {
                        (component as any).content = content.slice(0, -params.removeCount);
                    }
                } else if (component.type === 'metric-cards' && 'metrics' in component) {
                    const metrics = (component as any).metrics;
                    if (Array.isArray(metrics)) {
                        (component as any).metrics = metrics.slice(0, -params.removeCount);
                    }
                } else if (component.type === 'process-flow' && 'steps' in component) {
                    const steps = (component as any).steps;
                    if (Array.isArray(steps)) {
                        (component as any).steps = steps.slice(0, -params.removeCount);
                    }
                } else if (component.type === 'icon-grid' && 'items' in component) {
                    const items = (component as any).items;
                    if (Array.isArray(items)) {
                        (component as any).items = items.slice(0, -params.removeCount);
                    }
                }
                break;
        }
    }

    return updatedSlide;
}

/**
 * Run Qwen-VL3 Visual Architect iterative loop
 * Generates SVG proxy, critiques with Qwen-VL, applies repairs, repeats until convergence
 */
export async function runQwenVisualArchitectLoop(
    slide: SlideNode,
    styleGuide: GlobalStyleGuide,
    routerConfig: RouterDecision,
    costTracker: CostTracker,
    maxRounds: number = 3
): Promise<VisualArchitectResult> {
    console.log('✨ [VISUAL ARCHITECT] Starting vision-first critique loop');

    const isBrowser = typeof window !== 'undefined';
    if (isBrowser && !QWEN_VL_PROXY_URL) {
        console.warn('[VISUAL ARCHITECT] Skipping Qwen-VL loop in browser (requires QWEN_VL_PROXY_URL).');
        return {
            slide,
            rounds: 0,
            finalScore: 0,
            repairs: [],
            converged: false,
            totalCost: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0
        };
    }

    const MIN_IMPROVEMENT_DELTA = 3; // Minimum score improvement to continue
    const TARGET_SCORE = 85;

    let currentSlide = slide;
    let allRepairs: RepairAction[] = [];
    let previousScore = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    const preSummary = costTracker.getSummary();
    const preQwen = preSummary.qwenVL || { cost: 0, inputTokens: 0, outputTokens: 0, calls: 0 };

    for (let round = 1; round <= maxRounds; round++) {
        console.log(`\n[VISUAL ARCHITECT] Round ${round}/${maxRounds}`);

        try {
            // Step 1: Generate SVG proxy from current slide state
            console.log('[VISUAL ARCHITECT] Generating SVG proxy...');
            const { generateSvgProxy } = await import('./slideAgentService');
            const svgString = await generateSvgProxy(currentSlide, styleGuide);

            const components = currentSlide.layoutPlan?.components || [];

            let critiqueResult: any;
            if (isBrowser) {
                // Proxy path: send SVG to backend for rasterization + Qwen-VL
                console.log('[VISUAL ARCHITECT] Proxy path: SVG → Qwen-VL (repairs)');
                critiqueResult = await callQwenProxy<any>(
                    '/api/qwen/critique-repairs',
                    { svgString, slideWidth: 1920, slideHeight: 1080, components },
                    costTracker
                );
            } else {
                // Node path: rasterize SVG → PNG locally
                console.log('[VISUAL ARCHITECT] Rasterizing SVG to PNG...');
                const pngBase64 = await svgToPngBase64(svgString, 1920, 1080);

                // Call Qwen-VL with repair-enabled critique
                console.log('[VISUAL ARCHITECT] Sending to Qwen-VL for critique...');
                critiqueResult = await qwenVLClient.getVisualCritiqueWithRepairs(
                    pngBase64,
                    1920,
                    1080,
                    components,
                    costTracker
                );
            }

            // Update cumulative Qwen-VL usage totals after each critique call
            const postSummary = costTracker.getSummary();
            const postQwen = postSummary.qwenVL || { cost: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
            totalCost = Math.max(0, postQwen.cost - preQwen.cost);
            totalInputTokens = Math.max(0, postQwen.inputTokens - preQwen.inputTokens);
            totalOutputTokens = Math.max(0, postQwen.outputTokens - preQwen.outputTokens);

            const currentScore = critiqueResult.overall_score || 0;
            const repairs = critiqueResult.repairs || [];
            const verdict = critiqueResult.verdict || 'flag_for_review';

            console.log(`[VISUAL ARCHITECT] Score: ${currentScore}/100, Verdict: ${verdict}, Repairs: ${repairs.length}`);

            // Check convergence conditions
            if (verdict === 'accept' || currentScore >= TARGET_SCORE) {
                console.log(`✅ [VISUAL ARCHITECT] Converged! Final score: ${currentScore}`);
                return {
                    slide: currentSlide,
                    rounds: round,
                    finalScore: currentScore,
                    repairs: allRepairs,
                    converged: true,
                    totalCost,
                    totalInputTokens,
                    totalOutputTokens
                };
            }

            // Check for improvement
            if (round > 1 && currentScore <= previousScore + MIN_IMPROVEMENT_DELTA) {
                console.warn(`[VISUAL ARCHITECT] No improvement detected (${previousScore} → ${currentScore}), exiting early`);
                return {
                    slide: currentSlide,
                    rounds: round,
                    finalScore: currentScore,
                    repairs: allRepairs,
                    converged: false,
                    totalCost,
                    totalInputTokens,
                    totalOutputTokens
                };
            }

            // Step 4: Apply repairs
            if (repairs.length > 0) {
                console.log(`[VISUAL ARCHITECT] Applying ${repairs.length} repairs...`);
                currentSlide = applyRepairsToSlide(currentSlide, repairs, styleGuide);
                allRepairs = [...allRepairs, ...repairs];
            } else {
                console.warn('[VISUAL ARCHITECT] No repairs suggested, exiting');
                return {
                    slide: currentSlide,
                    rounds: round,
                    finalScore: currentScore,
                    repairs: allRepairs,
                    converged: false,
                    totalCost,
                    totalInputTokens,
                    totalOutputTokens
                };
            }

            previousScore = currentScore;

        } catch (error: any) {
            console.error(`[VISUAL ARCHITECT] Error in round ${round}:`, error.message);

            // On error, return current state
            return {
                slide: currentSlide,
                rounds: round,
                finalScore: previousScore,
                repairs: allRepairs,
                converged: false,
                totalCost,
                totalInputTokens,
                totalOutputTokens
            };
        }
    }

    // Max rounds reached without convergence
    console.warn(`[VISUAL ARCHITECT] Max rounds (${maxRounds}) reached without full convergence`);
    return {
        slide: currentSlide,
        rounds: maxRounds,
        finalScore: previousScore,
        repairs: allRepairs,
        converged: false,
        totalCost,
        totalInputTokens,
        totalOutputTokens
    };
}
