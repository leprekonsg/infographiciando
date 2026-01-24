/**
 * Visual Cortex Service - Qwen3-VL Integration
 *
 * Implements external visual validation using Qwen3-VL-Plus for:
 * - Bounding box detection with 0-1000 normalized coordinates
 * - Spatial issue identification
 * - Contrast analysis
 * - Empty region detection
 *
 * Based on Alibaba Cloud's DashScope API (OpenAI-compatible)
 * Model: qwen3-vl-plus-2025-12-19
 * Pricing: Input $0.2/1M tokens, Output $1.6/1M tokens
 *
 * ============================================================================
 * QWEN3-VL ARCHITECTURAL OPTIMIZATIONS (2026-01)
 * ============================================================================
 * 
 * 1. DeepStack Architecture Integration:
 *    - Multi-layer visual feature preservation enables fine-grained texture analysis
 *    - Prompts explicitly handle rasterization noise/artifacts
 *    - Texture-aware critique for glass cards, gradients, subtle effects
 * 
 * 2. Coordinate System (0-1000 Standard):
 *    - All coordinates normalized to 0-1000 range regardless of image resolution
 *    - (0,0) = top-left, (1000,1000) = bottom-right
 *    - Post-processing converts to 0-1 for internal use: val / 1000
 *    - NEVER prompt for pixel coordinates (causes hallucination)
 * 
 * 3. Thinking Mode Controls:
 *    - /no_think for perception tasks (layout selection, quick scoring)
 *    - /think for complex reasoning (repair planning, full critique)
 *    - Avoids redundant "step by step" prompting (model already trained for CoT)
 * 
 * 4. Persona-Based System Prompts:
 *    - VISUAL_ARCHITECT for spatial repair loops
 *    - ART_DIRECTOR for aesthetic scoring
 *    - LAYOUT_SELECTOR for fast template comparison
 *    - Role definition sets boundary conditions for output quality
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
import {
    QWEN_PERSONAS,
    VISUAL_CRITIQUE_PROMPT,
    VISUAL_ARCHITECT_REPAIR_PROMPT,
    LAYOUT_SELECTOR_PROMPT,
    buildQwenMessage,
    getQwenRequestConfig,
    parseQwenResponse,
    getThinkingMode,
    COORDINATE_SYSTEM,
    // Style-aware rubric functions
    QwenStyleMode,
    getStyleRubric,
    buildStyleAwareCritiquePrompt,
    buildStyleAwareRepairPrompt,
    passesStyleQualityGate,
    getStyleAwareThinkingMode
} from './visual/qwenPromptConfig';

// Qwen-VL Model Configuration
const QWEN_VL_MODEL = 'qwen3-vl-plus-2025-12-19';
const QWEN_API_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const QWEN_VL_PROXY_URL = process.env.QWEN_VL_PROXY_URL || '';
const QWEN_PROXY_COOLDOWN_MS = 60_000;
let qwenProxyCooldownUntil = 0;
let qwenProxyLastLog = 0;

function markQwenProxyFailure(reason?: string) {
    qwenProxyCooldownUntil = Date.now() + QWEN_PROXY_COOLDOWN_MS;
    const now = Date.now();
    if (now - qwenProxyLastLog > 5000) {
        const detail = reason ? ` (${reason})` : '';
        console.warn(`[QWEN-VL] Proxy failure detected. Cooling down for ${Math.round(QWEN_PROXY_COOLDOWN_MS / 1000)}s${detail}`);
        qwenProxyLastLog = now;
    }
}

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
    edit_instructions?: Array<{
        action: 'move' | 'resize' | 'trim_text' | 'simplify_content' | 'increase_negative_space' | 'swap_zones';
        target_region: string; // e.g., "top-left", "center", or "x:0.1,y:0.2,w:0.3,h:0.2"
        detail: string;
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
     * 
     * Uses optimized prompts with:
     * - Art Director persona for aesthetic evaluation
     * - 0-1000 coordinate system for precise grounding
     * - Explicit artifact noise handling (DeepStack awareness)
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

        // Build message with Art Director persona for aesthetic critique
        const messages = buildQwenMessage(
            QWEN_PERSONAS.ART_DIRECTOR,
            `${getThinkingMode('critique')}\n\n${VISUAL_CRITIQUE_PROMPT}`,
            slideImageBase64
        );

        const requestConfig = getQwenRequestConfig('critique');

        try {
            const response = await fetch(`${QWEN_API_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    ...requestConfig,
                    messages
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

            // Parse JSON response and normalize coordinates from 0-1000 to 0-1
            const parsed = this.parseJsonResponse(responseText);
            const normalized = parseQwenResponse(parsed);

            // Log critique summary
            const result = normalized as VisualCritiqueResult;
            console.log(`[QWEN-VL] Critique result: score=${result.overall_score}, verdict=${result.overall_verdict}, issues=${result.issues?.length || 0}`);

            return result;
        } catch (error: any) {
            console.error('[QWEN-VL] Visual critique error:', error.message);
            throw error;
        }
    }

    /**
     * Get visual critique with structured repair instructions (Visual Architect mode)
     * 
     * Uses optimized prompts with:
     * - Visual Architect persona for spatial repair planning
     * - 0-1000 coordinate system with automatic normalization
     * - /think mode for complex reasoning tasks
     * - Component ID mapping for precise repair targeting
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

        // Build component manifest for the prompt
        const componentManifest = currentComponents
            .map((c, i) => `${c.type}-${i}`)
            .join(', ');

        // Build message with Visual Architect persona
        const messages = buildQwenMessage(
            QWEN_PERSONAS.VISUAL_ARCHITECT,
            `${getThinkingMode('repair')}\n\nAVAILABLE COMPONENTS: ${componentManifest || 'none'}\n\n${VISUAL_ARCHITECT_REPAIR_PROMPT}`,
            slideImageBase64
        );

        const requestConfig = getQwenRequestConfig('repair');

        try {
            const response = await fetch(`${QWEN_API_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    ...requestConfig,
                    messages
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
            
            // Normalize coordinates from 0-1000 to 0-1
            const normalized = parseQwenResponse(parsed);

            console.log(`[QWEN-VL ARCHITECT] Result: score=${normalized.overall_score}, verdict=${normalized.verdict}, repairs=${normalized.repairs?.length || 0}`);

            return normalized;
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
        markQwenProxyFailure(`HTTP ${response.status}`);
        throw new Error(`Qwen-VL proxy error (${response.status}): ${errorText}`);
    }

    let data: any;
    try {
        data = await response.json();
    } catch (parseErr: any) {
        markQwenProxyFailure('Invalid JSON');
        const fallbackText = await response.text().catch(() => '');
        throw new Error(`Qwen-VL proxy JSON parse error: ${parseErr.message}. Body: ${fallbackText}`);
    }

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
            markQwenProxyFailure(error.message);
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
        markQwenProxyFailure(error.message);
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

// ============================================================================
// STYLE-AWARE VISUAL CRITIQUE (StyleMode Integration)
// ============================================================================

/**
 * Extended critique result with style-specific evaluation
 */
export interface StyleAwareCritiqueResult extends VisualCritiqueResult {
    /** The style mode used for evaluation */
    styleMode: QwenStyleMode;
    /** Whether the slide passes the style-specific quality gate */
    passesStyleGate: boolean;
    /** Style-specific score adjustments */
    styleAdjustments?: {
        reason: string;
        adjustment: number;
    }[];
}

/**
 * Get style-aware visual critique from SVG proxy
 * 
 * This extends the standard critique with style-specific rubrics:
 * - Corporate: Strict grid alignment, WCAG AAA contrast, zero tolerance for chaos
 * - Professional: Balanced readability + visual interest, WCAG AA
 * - Serendipitous: Impact-focused, boldness rewarded, template-y penalized
 * 
 * @param svgString - SVG markup from generateSvgProxy()
 * @param styleMode - The style mode to evaluate against
 * @param costTracker - Optional cost tracker
 * @returns Style-aware critique result with quality gate status
 */
export async function getStyleAwareCritiqueFromSvg(
    svgString: string,
    styleMode: QwenStyleMode = 'professional',
    costTracker?: CostTracker
): Promise<(StyleAwareCritiqueResult & { renderFidelity: RenderFidelity }) | null> {
    const sanitizeSvg = (input: string) =>
        input.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[a-fA-F0-9]+;)/g, '&amp;');

    const safeSvg = sanitizeSvg(svgString);

    if (!qwenVLClient.isAvailable()) {
        if (!QWEN_VL_PROXY_URL) {
            console.warn('[QWEN-VL] Skipping style-aware critique - API not configured');
            return null;
        }
    }

    // Browser path: use proxy with style mode
    if (typeof window !== 'undefined') {
        if (!QWEN_VL_PROXY_URL) {
            console.warn('[QWEN-VL] Skipping style critique in browser (requires proxy).');
            return null;
        }

        try {
            console.log(`[QWEN-VL] Style-aware proxy path: SVG → Qwen-VL (mode: ${styleMode})`);
            const critique = await callQwenProxy<VisualCritiqueResult>(
                '/api/qwen/critique',
                { svgString: safeSvg, slideWidth: 1920, slideHeight: 1080, styleMode },
                costTracker
            );

            const hasCritical = critique.issues?.some(i => i.severity === 'critical') ?? false;
            const passesGate = passesStyleQualityGate(critique.overall_score, styleMode, hasCritical);

            return {
                ...critique,
                styleMode,
                passesStyleGate: passesGate,
                renderFidelity: 'svg-proxy' as RenderFidelity
            };
        } catch (error: any) {
            console.error('[QWEN-VL] Style-aware proxy critique failed:', error.message);
            markQwenProxyFailure(error.message);
            return null;
        }
    }

    // Node path: use style-aware prompt
    try {
        console.log(`[QWEN-VL] Style-aware fast path: SVG → PNG → Qwen-VL (mode: ${styleMode})`);
        const svgRasterizeStart = Date.now();

        // Step 1: Rasterize SVG to PNG
        const pngBase64 = await svgToPngBase64(safeSvg, 1920, 1080);
        const svgRasterizeDuration = Date.now() - svgRasterizeStart;
        console.log(`[QWEN-VL] SVG rasterization complete in ${svgRasterizeDuration}ms`);

        // Step 2: Build style-aware prompt
        const styleAwarePrompt = buildStyleAwareCritiquePrompt(styleMode);
        const thinkingMode = getStyleAwareThinkingMode(styleMode, 'critique');

        // Use appropriate persona based on style
        const persona = styleMode === 'serendipitous' 
            ? QWEN_PERSONAS.ART_DIRECTOR  // Aesthetic focus for serendipitous
            : QWEN_PERSONAS.VISUAL_ARCHITECT;  // Spatial focus for corporate/professional

        const messages = buildQwenMessage(
            persona,
            `${thinkingMode}\n\n${styleAwarePrompt}`,
            pngBase64
        );

        const requestConfig = getQwenRequestConfig('critique');

        // Step 3: Call Qwen-VL with style-aware prompt
        const response = await fetch(`${QWEN_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${qwenVLClient['apiKey']}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ...requestConfig,
                messages
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

            const duration = Date.now() - svgRasterizeStart;
            console.log(`[QWEN-VL] Style-aware critique complete in ${duration}ms (mode: ${styleMode}, tokens: ${inputTokens}/${outputTokens})`);
        }

        const responseText = data.choices?.[0]?.message?.content || '';

        // Parse and normalize response
        const parsed = qwenVLClient['parseJsonResponse'](responseText);
        const normalized = parseQwenResponse(parsed) as VisualCritiqueResult;

        // Evaluate against style-specific quality gate
        const hasCritical = normalized.issues?.some(i => i.severity === 'critical') ?? false;
        const passesGate = passesStyleQualityGate(normalized.overall_score, styleMode, hasCritical);

        console.log(`[QWEN-VL] Style critique result: score=${normalized.overall_score}, mode=${styleMode}, passes_gate=${passesGate}, verdict=${normalized.overall_verdict}`);

        return {
            ...normalized,
            styleMode,
            passesStyleGate: passesGate,
            renderFidelity: 'svg-proxy' as RenderFidelity
        };
    } catch (error: any) {
        console.error('[QWEN-VL] Style-aware SVG critique failed:', error.message);
        return null;
    }
}

/**
 * Get style-aware repair instructions
 * 
 * Uses style-specific repair priorities:
 * - Corporate: Grid alignment first, truncation never allowed
 * - Professional: Balance readability fixes with visual interest
 * - Serendipitous: Preserve drama, avoid "normalizing" bold choices
 * 
 * @param svgString - SVG markup
 * @param styleMode - Style mode for repair prioritization
 * @param currentComponents - Current component list for ID mapping
 * @param costTracker - Optional cost tracker
 */
export async function getStyleAwareRepairsFromSvg(
    svgString: string,
    styleMode: QwenStyleMode = 'professional',
    currentComponents: any[] = [],
    costTracker?: CostTracker
): Promise<any | null> {
    const sanitizeSvg = (input: string) =>
        input.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[a-fA-F0-9]+;)/g, '&amp;');

    const safeSvg = sanitizeSvg(svgString);

    if (!qwenVLClient.isAvailable() && !QWEN_VL_PROXY_URL) {
        console.warn('[QWEN-VL] Skipping style-aware repairs - API not configured');
        return null;
    }

    const isBrowser = typeof window !== 'undefined';

    if (isBrowser && QWEN_VL_PROXY_URL) {
        try {
            console.log(`[QWEN-VL] Style-aware repair via proxy (mode: ${styleMode})`);
            return await callQwenProxy(
                '/api/qwen/repair',
                { svgString: safeSvg, styleMode, components: currentComponents },
                costTracker
            );
        } catch (error: any) {
            console.error('[QWEN-VL] Style-aware proxy repair failed:', error.message);
            markQwenProxyFailure(error.message);
            return null;
        }
    }

    if (isBrowser) {
        console.warn('[QWEN-VL] Style-aware repairs unavailable in browser without proxy');
        return null;
    }

    // Node path
    try {
        console.log(`[QWEN-VL] Style-aware repair: SVG → PNG → Qwen-VL (mode: ${styleMode})`);

        const pngBase64 = await svgToPngBase64(safeSvg, 1920, 1080);
        const styleAwareRepairPrompt = buildStyleAwareRepairPrompt(styleMode);
        const thinkingMode = getStyleAwareThinkingMode(styleMode, 'repair');

        const componentManifest = currentComponents
            .map((c, i) => `${c.type}-${i}`)
            .join(', ');

        const messages = buildQwenMessage(
            QWEN_PERSONAS.REPAIR_SURGEON,
            `${thinkingMode}\n\nAVAILABLE COMPONENTS: ${componentManifest || 'none'}\n\n${styleAwareRepairPrompt}`,
            pngBase64
        );

        const requestConfig = getQwenRequestConfig('repair');

        const response = await fetch(`${QWEN_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${qwenVLClient['apiKey']}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ...requestConfig,
                messages
            })
        });

        if (!response.ok) {
            throw new Error(`Qwen-VL API error: ${response.status}`);
        }

        const data = await response.json();

        if (costTracker && data.usage) {
            costTracker.addQwenVLCost(
                data.usage.prompt_tokens || 0,
                data.usage.completion_tokens || 0
            );
        }

        const responseText = data.choices?.[0]?.message?.content || '';
        const parsed = qwenVLClient['parseJsonResponse'](responseText);
        const normalized = parseQwenResponse(parsed);

        console.log(`[QWEN-VL] Style-aware repair result: score=${normalized.overall_score}, repairs=${normalized.repairs?.length || 0}, mode=${styleMode}`);

        return {
            ...normalized,
            styleMode
        };
    } catch (error: any) {
        console.error('[QWEN-VL] Style-aware repair failed:', error.message);
        return null;
    }
}

/**
 * Check if Qwen-VL visual cortex is available
 */
export function isQwenVLAvailable(): boolean {
    const isNode = typeof window === 'undefined';

    if (isNode) {
        return qwenVLClient.isAvailable();
    }

    if (QWEN_VL_PROXY_URL) {
        if (Date.now() < qwenProxyCooldownUntil) {
            const remaining = Math.max(0, Math.ceil((qwenProxyCooldownUntil - Date.now()) / 1000));
            console.warn(`[QWEN-VL] Proxy in cooldown (${remaining}s remaining). Skipping visual critique.`);
            return false;
        }
        return true;
    }

    console.warn('[QWEN-VL] Visual critique unavailable in browser. Configure QWEN_VL_PROXY_URL for backend proxy.');
    return false;
}

// --- FAST-PATH LAYOUT SCORING ---

/**
 * Layout score result from fast-path evaluation
 */
export interface LayoutScoreResult {
    overall_score: number;
    content_fit?: number;
    visual_balance?: number;
    readability?: number;
    primary_issue?: 'none' | 'overflow' | 'sparse' | 'misaligned' | 'cramped';
    recommendation?: string;
}

/**
 * Fast-path layout scoring using /no_think mode
 * 
 * Optimized for rapid iteration during layout selection:
 * - Uses /no_think mode (perception-only, no reasoning chain)
 * - Layout Selector persona for focused evaluation
 * - Minimal token output (~256 tokens max)
 * - ~100-200ms latency vs ~500ms for full critique
 * 
 * @param svgString - SVG proxy string
 * @param costTracker - Optional cost tracker
 * @returns Layout score result with breakdown
 */
export async function getLayoutScoreFast(
    svgString: string,
    costTracker?: CostTracker
): Promise<LayoutScoreResult | null> {
    if (!qwenVLClient.isAvailable() && !QWEN_VL_PROXY_URL) {
        console.warn('[QWEN-VL] Fast scoring unavailable - API not configured');
        return null;
    }

    const sanitizeSvg = (input: string) =>
        input.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[a-fA-F0-9]+;)/g, '&amp;');

    const safeSvg = sanitizeSvg(svgString);
    const isBrowser = typeof window !== 'undefined';

    try {
        if (isBrowser) {
            if (!QWEN_VL_PROXY_URL) {
                return null;
            }

            console.log('[QWEN-VL] Fast score: SVG → Qwen-VL via proxy');
            const result = await callQwenProxy<LayoutScoreResult>(
                '/api/qwen/layout-score',
                { svgString: safeSvg },
                costTracker
            );
            return result;
        }

        // Node path: rasterize and score
        console.log('[QWEN-VL] Fast score: SVG → PNG → Qwen-VL');
        const pngBase64 = await svgToPngBase64(safeSvg, 1920, 1080);
        
        const messages = buildQwenMessage(
            QWEN_PERSONAS.LAYOUT_SELECTOR,
            LAYOUT_SELECTOR_PROMPT,
            pngBase64
        );

        const requestConfig = getQwenRequestConfig('layout_select');

        const response = await fetch(`${QWEN_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${qwenVLClient['apiKey']}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ...requestConfig,
                messages
            })
        });

        if (!response.ok) {
            throw new Error(`Qwen-VL API error: ${response.status}`);
        }

        const data = await response.json();

        if (costTracker && data.usage) {
            costTracker.addQwenVLCost(
                data.usage.prompt_tokens || 0,
                data.usage.completion_tokens || 0
            );
        }

        const responseText = data.choices?.[0]?.message?.content || '';
        
        // Parse JSON response
        let parsed: any;
        try {
            parsed = JSON.parse(responseText.trim());
        } catch {
            // Try extracting from code blocks
            const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[1].trim());
            } else {
                const rawMatch = responseText.match(/\{[\s\S]*\}/);
                if (rawMatch) {
                    parsed = JSON.parse(rawMatch[0]);
                } else {
                    throw new Error('Failed to parse layout score response');
                }
            }
        }

        console.log(`[QWEN-VL] Fast score: ${parsed.overall_score}/100`);
        return parsed as LayoutScoreResult;

    } catch (error: any) {
        console.error('[QWEN-VL] Fast score failed:', error.message);
        return null;
    }
}

// --- REPAIR NORMALIZATION ---

/**
 * Extract numeric values from repair reason text when params are missing.
 * Qwen-VL often describes values in natural language instead of providing them in params.
 * 
 * Examples:
 * - "moving down to y=0.35" → { y: 0.35 }
 * - "increasing line height to 1.8" → { lineHeight: 1.8 }
 * - "y=0.26 creates balanced whitespace" → { y: 0.26 }
 * - "shrinking to 40% width" → { width: 0.4 }
 */
function extractParamsFromReason(action: string, reason: string): Record<string, number | string> {
    const extracted: Record<string, number | string> = {};
    const reasonLower = reason.toLowerCase();
    
    // Pattern: y=0.XX or y position of 0.XX or ~XX% vertical
    const yMatch = reason.match(/y[=:]?\s*(\d+\.?\d*)|(\d+\.?\d*)\s*vertical|~(\d+)%\s*vertical/i);
    if (yMatch) {
        const val = yMatch[1] || yMatch[2] || (yMatch[3] ? parseFloat(yMatch[3]) / 100 : null);
        if (val !== null) {
            const numVal = typeof val === 'string' ? parseFloat(val) : val;
            if (!isNaN(numVal) && numVal >= 0 && numVal <= 1) {
                extracted.y = numVal;
            }
        }
    }
    
    // Pattern: x=0.XX or x position
    const xMatch = reason.match(/x[=:]?\s*(\d+\.?\d*)/i);
    if (xMatch) {
        const val = parseFloat(xMatch[1]);
        if (!isNaN(val) && val >= 0 && val <= 1) {
            extracted.x = val;
        }
    }
    
    // Pattern: line height to 1.X or lineHeight: 1.X
    const lineHeightMatch = reason.match(/line[\s-]?height[^0-9]*(\d+\.?\d*)/i);
    if (lineHeightMatch) {
        const val = parseFloat(lineHeightMatch[1]);
        if (!isNaN(val) && val >= 1 && val <= 3) {
            extracted.lineHeight = val;
        }
    }
    
    // Pattern: XX% width/height
    const percentMatch = reason.match(/(\d+)%\s*(width|height)/gi);
    if (percentMatch) {
        for (const match of percentMatch) {
            const parts = match.match(/(\d+)%\s*(width|height)/i);
            if (parts) {
                const val = parseFloat(parts[1]) / 100;
                const dim = parts[2].toLowerCase();
                if (!isNaN(val) && val > 0 && val <= 1) {
                    extracted[dim] = val;
                }
            }
        }
    }
    
    // Pattern: padding/margin to X% or spacing of X%
    const paddingMatch = reason.match(/(?:padding|margin|spacing)[^0-9]*(\d+)%/i);
    if (paddingMatch) {
        const val = parseFloat(paddingMatch[1]) / 100;
        if (!isNaN(val) && val > 0 && val < 0.5) {
            extracted.padding = val;
        }
    }
    
    // Pattern: gap of X% or gap to X%
    const gapMatch = reason.match(/gap[^0-9]*(\d+)%/i);
    if (gapMatch) {
        const val = parseFloat(gapMatch[1]) / 100;
        if (!isNaN(val) && val > 0 && val < 0.3) {
            extracted.itemSpacing = val;
        }
    }
    
    // Pattern: color #XXXXXX
    const colorMatch = reason.match(/#([A-Fa-f0-9]{6})/);
    if (colorMatch && action === 'adjust_color') {
        extracted.color = `#${colorMatch[1]}`;
    }
    
    // Pattern: remove X items
    const removeMatch = reason.match(/remov(?:e|ing)\s*(\d+)\s*items?/i);
    if (removeMatch && action === 'simplify_content') {
        const val = parseInt(removeMatch[1]);
        if (!isNaN(val) && val > 0 && val <= 5) {
            extracted.removeCount = val;
        }
    }
    
    return extracted;
}

/**
 * Normalize repair action - merge params from structured data and extracted from reason.
 * Ensures all repairs have valid numeric parameters.
 */
function normalizeRepair(repair: RepairAction): RepairAction {
    const { action, params = {}, reason = '' } = repair;
    
    // Extract any values mentioned in reason text
    const extractedParams = extractParamsFromReason(action, reason);
    
    // Merge: explicit params take precedence, then extracted from reason
    const mergedParams: Record<string, any> = { ...extractedParams };
    
    // Only keep non-undefined params from original
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            mergedParams[key] = value;
        }
    }
    
    // Apply sensible defaults for common repair types if still missing
    if (action === 'adjust_spacing') {
        if (mergedParams.lineHeight === undefined) {
            mergedParams.lineHeight = 1.45; // Safe default within max bound (1.5)
        }
    }
    
    return {
        ...repair,
        params: mergedParams
    };
}

/**
 * Normalize all repairs in a batch, logging what was extracted/defaulted.
 */
function normalizeRepairs(repairs: RepairAction[]): RepairAction[] {
    return repairs.map(repair => {
        const normalized = normalizeRepair(repair);
        
        // Log if we extracted values from reason
        const originalHadParams = Object.values(repair.params || {}).some(v => v !== undefined);
        const normalizedHasParams = Object.values(normalized.params || {}).some(v => v !== undefined);
        
        if (!originalHadParams && normalizedHasParams) {
            console.log(`[REPAIR] Extracted params from reason: ${JSON.stringify(normalized.params)}`);
        }
        
        return normalized;
    });
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
 * Parse component ID from Qwen-VL output.
 * 
 * STANDARDIZED FORMAT: "{component-type}-{index}" e.g., "text-bullets-0", "metric-cards-1"
 * The index directly maps to layoutPlan.components[index].
 * 
 * Special IDs:
 * - "title" → isTitle: true (slide title, not a numbered component)
 * - "divider" → isDivider: true (accent bar, not a numbered component)
 */
function parseComponentId(componentId: string): {
    type: string;
    index: number;
    isTitle: boolean;
    isDivider: boolean;
    isLine: boolean;
} {
    const normalized = componentId.toLowerCase().trim();
    
    // Handle special non-indexed IDs first
    if (normalized === 'title' || normalized === 'heading') {
        return { type: 'title', index: -1, isTitle: true, isDivider: false, isLine: false };
    }
    if (normalized === 'divider' || normalized === 'accent-bar' || normalized === 'line') {
        return { type: 'divider', index: -1, isTitle: false, isDivider: true, isLine: true };
    }
    
    // Standard format: "{type}-{index}" e.g., "text-bullets-0"
    const parts = normalized.split('-');
    const indexStr = parts[parts.length - 1];
    const hasNumericIndex = /^\d+$/.test(indexStr);
    
    const index = hasNumericIndex ? parseInt(indexStr) : 0;
    const type = hasNumericIndex ? parts.slice(0, -1).join('-') : normalized;
    
    // Legacy ID patterns that map to title/divider
    const isTitle = ['text-title', 'section-header'].includes(type);
    const isDivider = ['line-decorative', 'underline'].includes(type);
    const isLine = isDivider || type.includes('line');
    
    return { type, index, isTitle, isDivider, isLine };
}

/**
 * Find component by direct index lookup.
 * 
 * With standardized IDs, the index in "text-bullets-0" directly maps to components[0].
 * Only falls back to type matching if direct lookup fails (legacy compatibility).
 */
function findComponentByFlexibleMatch(
    components: any[],
    parsedId: { type: string; index: number }
): { component: any; actualIndex: number } | null {
    if (!components || components.length === 0) return null;
    
    const { type, index } = parsedId;
    
    // STRATEGY 1: Direct index lookup (preferred - new standardized IDs)
    // The index in "text-bullets-0" directly maps to components[0]
    if (index >= 0 && index < components.length) {
        const component = components[index];
        const componentType = component.type?.toLowerCase() || '';
        
        // Verify type matches (sanity check)
        if (componentType === type) {
            return { component, actualIndex: index };
        }
        
        // Type mismatch warning but still use direct index (it's authoritative)
        console.warn(`[REPAIR] Component type mismatch: expected ${type} at index ${index}, found ${componentType}. Using direct index.`);
        return { component, actualIndex: index };
    }
    
    // STRATEGY 2: Fallback to type-based search (legacy compatibility)
    // For old-style IDs like "text-title-0" that don't map to component indices
    const typeMapping: Record<string, string[]> = {
        'text-bullets': ['text-bullets'],
        'text-title': ['text-bullets'], // Title text rendered from text-bullets
        'shape-card': ['metric-cards', 'icon-grid', 'chart-frame'],
        'metric-cards': ['metric-cards'],
        'process-flow': ['process-flow'],
        'icon-grid': ['icon-grid'],
        'chart-frame': ['chart-frame'],
        'diagram-svg': ['diagram-svg'],
    };
    
    const potentialTypes = typeMapping[type] || [type];
    
    // Find first component of matching type
    for (let i = 0; i < components.length; i++) {
        const cType = components[i].type?.toLowerCase() || '';
        if (potentialTypes.some(pt => cType === pt)) {
            console.warn(`[REPAIR] Using fallback type match for ${type}-${index} → component ${i} (${cType})`);
            return { component: components[i], actualIndex: i };
        }
    }
    
    console.warn(`[REPAIR] No component found for ${type}-${index}`);
    return null;
}

/**
 * Apply structured repairs to a slide
 * Modifies component positions, sizes, colors based on Qwen-VL repair instructions
 * 
 * IMPROVED: Direct index lookup now that SVG IDs match component indices.
 * 
 * NOTE: Some repairs (reposition, adjust_spacing) add hints to the component that
 * the spatial renderer can use during layout. These don't directly change positions
 * but influence the rendering pass.
 */
function applyRepairsToSlide(
    slide: SlideNode,
    repairs: RepairAction[],
    styleGuide: GlobalStyleGuide
): SlideNode {
    const updatedSlide = JSON.parse(JSON.stringify(slide)); // Deep clone
    let appliedCount = 0;
    const components = updatedSlide.layoutPlan?.components || [];

    for (const repair of repairs) {
        const { component_id, action, params, reason } = repair;

        // Parse component ID with improved logic
        const parsedId = parseComponentId(component_id);

        // Find component in layoutPlan
        if (!updatedSlide.layoutPlan?.components) {
            console.warn(`[REPAIR] No layout plan found in slide`);
            continue;
        }

        // Handle special IDs that map to slide-level properties
        if (parsedId.isTitle) {
            // Title repairs affect the slide title styling
            if (action === 'reposition' && params?.y !== undefined) {
                console.log(`[REPAIR] Setting title top margin hint: ${params.y} (${reason})`);
                updatedSlide.layoutPlan._titleMarginTop = params.y;
                appliedCount++;
            } else if (action === 'adjust_spacing') {
                console.log(`[REPAIR] Setting title spacing hint (${reason})`);
                updatedSlide.layoutPlan._titleSpacing = params?.padding || 'increased';
                appliedCount++;
            }
            continue;
        }

        if (parsedId.isDivider || parsedId.isLine) {
            // Divider positioning hints
            if (action === 'reposition' && params?.y !== undefined) {
                console.log(`[REPAIR] Setting divider position hint: y=${params.y} (${reason})`);
                updatedSlide.layoutPlan._dividerY = params.y;
                appliedCount++;
            }
            continue;
        }

        // Use flexible matching to find the component
        const match = findComponentByFlexibleMatch(components, parsedId);
        if (!match) {
            console.warn(`[REPAIR] Component not found: ${component_id} (parsed as ${parsedId.type}-${parsedId.index})`);
            continue;
        }
        
        const { component, actualIndex } = match;

        // Apply action
        switch (action) {
            case 'resize':
                console.log(`[REPAIR] Resizing ${component_id}: ${params?.width}x${params?.height} (${reason})`);
                // Add resize hints that spatial renderer can use
                if (params?.width !== undefined) (component as any)._hintWidth = params.width;
                if (params?.height !== undefined) (component as any)._hintHeight = params.height;
                appliedCount++;
                break;

            case 'reposition':
                console.log(`[REPAIR] Repositioning ${component_id}: (${params?.x}, ${params?.y}) (${reason})`);
                // Add position hints for spatial renderer
                if (params?.x !== undefined) (component as any)._hintX = params.x;
                if (params?.y !== undefined) (component as any)._hintY = params.y;
                appliedCount++;
                break;

            case 'adjust_color':
                console.log(`[REPAIR] Adjusting color ${component_id}: ${params?.color} (${reason})`);
                // Apply color changes to component data
                if (params?.color) {
                    (component as any).textColor = params.color;
                    (component as any)._hintColor = params.color;
                    
                    if (component.type === 'metric-cards' && 'metrics' in component) {
                        const metrics = (component as any).metrics;
                        if (Array.isArray(metrics)) {
                            metrics.forEach((m: any) => m.color = params.color);
                        }
                    }
                    appliedCount++;
                }
                break;

            case 'adjust_spacing':
                // CRITICAL FIX: Spacing increases cause overflow in tight layouts
                // Only apply spacing adjustments that REDUCE space, not increase it
                const currentLineHeight = (component as any)._hintLineHeight || 1.4;
                const requestedLineHeight = params?.lineHeight;
                
                // SAFETY: Never increase line height above 1.5 (causes overflow)
                // If Qwen-VL requests > 1.5, that's a signal that content reduction is needed
                // Prefer simplify_content or resize over silent clamping
                if (requestedLineHeight && requestedLineHeight > 1.5) {
                    console.warn(`[REPAIR] lineHeight ${requestedLineHeight} > max 1.5 for ${component_id}. Triggering content simplification.`);
                    
                    // Instead of clamping, reduce content if possible
                    const hasReducibleContent = 
                        (component.type === 'text-bullets' && Array.isArray((component as any).content) && (component as any).content.length > 2) ||
                        (component.type === 'metric-cards' && Array.isArray((component as any).metrics) && (component as any).metrics.length > 2) ||
                        (component.type === 'process-flow' && Array.isArray((component as any).steps) && (component as any).steps.length > 3);
                    
                    if (hasReducibleContent) {
                        // Remove 1 item to make room instead of forcing tight spacing
                        if (component.type === 'text-bullets') {
                            (component as any).content = (component as any).content.slice(0, -1);
                        } else if (component.type === 'metric-cards') {
                            (component as any).metrics = (component as any).metrics.slice(0, -1);
                        } else if (component.type === 'process-flow') {
                            (component as any).steps = (component as any).steps.slice(0, -1);
                        }
                        console.log(`[REPAIR] Simplified content for ${component_id} (removed 1 item) instead of excessive line-height`);
                        // Now we can use a comfortable 1.45 line-height
                        (component as any)._hintLineHeight = 1.45;
                    } else {
                        // Component can't be reduced further, clamp to max but log warning
                        (component as any)._hintLineHeight = 1.5;
                        console.warn(`[REPAIR] Clamped lineHeight to 1.5 (content cannot be reduced further)`);
                    }
                } else if (params?.lineHeight !== undefined) {
                    (component as any)._hintLineHeight = Math.min(params.lineHeight, 1.5); // Always enforce max
                }
                
                console.log(`[REPAIR] Adjusting spacing ${component_id}: padding=${params?.padding}, lineHeight=${(component as any)._hintLineHeight || params?.lineHeight} (${reason})`);
                
                // Padding increases are generally safe
                if (params?.padding !== undefined) (component as any)._hintPadding = params.padding;
                if (params?.itemSpacing !== undefined) (component as any)._hintItemSpacing = params.itemSpacing;
                appliedCount++;
                break;

            case 'simplify_content':
                console.log(`[REPAIR] Simplifying ${component_id}: remove ${params?.removeCount} items (${reason})`);
                const removeCount = params?.removeCount || 1;
                // Truncate arrays (bullets, metrics, etc.)
                if (component.type === 'text-bullets' && 'content' in component) {
                    const content = (component as any).content;
                    if (Array.isArray(content) && content.length > removeCount) {
                        (component as any).content = content.slice(0, -removeCount);
                        appliedCount++;
                    }
                } else if (component.type === 'metric-cards' && 'metrics' in component) {
                    const metrics = (component as any).metrics;
                    if (Array.isArray(metrics) && metrics.length > removeCount) {
                        (component as any).metrics = metrics.slice(0, -removeCount);
                        appliedCount++;
                    }
                } else if (component.type === 'process-flow' && 'steps' in component) {
                    const steps = (component as any).steps;
                    if (Array.isArray(steps) && steps.length > removeCount) {
                        (component as any).steps = steps.slice(0, -removeCount);
                        appliedCount++;
                    }
                } else if (component.type === 'icon-grid' && 'items' in component) {
                    const items = (component as any).items;
                    if (Array.isArray(items) && items.length > removeCount) {
                        (component as any).items = items.slice(0, -removeCount);
                        appliedCount++;
                    }
                }
                break;
        }
    }

    // Log summary
    if (appliedCount > 0) {
        console.log(`[REPAIR] Applied ${appliedCount}/${repairs.length} repairs to slide`);
    } else if (repairs.length > 0) {
        console.warn(`[REPAIR] No repairs could be applied (0/${repairs.length})`);
    }

    return updatedSlide;
}

// ============================================================================
// PER-SLIDE BUDGET ABORT CONFIGURATION
// ============================================================================
// Prevents runaway VL costs on problematic slides
const SLIDE_BUDGET_LIMITS = {
    maxTimeMs: 15_000,         // 15 seconds max per slide
    maxCostDollars: 0.05,      // $0.05 max per slide (roughly 25K tokens at VL rates)
    maxStagnantRounds: 2       // If same issue persists 2 rounds, abort
};

interface BudgetCheckResult {
    exceeded: boolean;
    reason?: 'time' | 'cost' | 'stagnation' | 'none';
    recommendation?: 'reroute_layout' | 'simplify_content' | 'accept_as_is';
}

/**
 * Track issue categories across rounds to detect stagnation
 */
function detectStagnation(repairs: RepairAction[][], currentRepairs: RepairAction[]): boolean {
    if (repairs.length < 2) return false;
    
    // Get issue categories from last 2 rounds plus current
    const getCategories = (r: RepairAction[]) => new Set(r.map(rep => rep.action));
    
    const prev = repairs[repairs.length - 1] || [];
    const prevPrev = repairs[repairs.length - 2] || [];
    
    const currCategories = getCategories(currentRepairs);
    const prevCategories = getCategories(prev);
    const prevPrevCategories = getCategories(prevPrev);
    
    // Check if same issue categories persist across 3 consecutive rounds
    for (const category of currCategories) {
        if (prevCategories.has(category) && prevPrevCategories.has(category)) {
            console.warn(`[BUDGET ABORT] Stagnation detected: "${category}" persists for 3+ rounds`);
            return true;
        }
    }
    
    return false;
}

/**
 * Run Qwen-VL3 Visual Architect iterative loop
 * Generates SVG proxy, critiques with Qwen-VL, applies repairs, repeats until convergence
 * 
 * NEW: Per-slide budget aborts to prevent runaway costs:
 * - Time limit: 15s per slide
 * - Cost limit: $0.05 per slide
 * - Stagnation detection: same issue 2+ rounds → abort and reroute/simplify
 */
export async function runQwenVisualArchitectLoop(
    slide: SlideNode,
    styleGuide: GlobalStyleGuide,
    routerConfig: RouterDecision,
    costTracker: CostTracker,
    maxRounds: number = 3
): Promise<VisualArchitectResult> {
    console.log('✨ [VISUAL ARCHITECT] Starting vision-first critique loop');

    const startTime = Date.now();
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
    let repairHistory: RepairAction[][] = []; // Track repairs per round for stagnation detection
    let previousScore = 0;
    let previousSvgHash = ''; // Track SVG hash to detect ineffective repairs
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    // Simple hash function for SVG content comparison
    const hashSvg = (svg: string): string => {
        // Extract key positioning data from SVG for comparison
        // This focuses on element positions rather than styling
        const positions = svg.match(/(x|y|width|height)="[\d.]+"/g) || [];
        return positions.join('|');
    };

    const preSummary = costTracker.getSummary();
    const preQwen = preSummary.qwenVL || { cost: 0, inputTokens: 0, outputTokens: 0, calls: 0 };

    for (let round = 1; round <= maxRounds; round++) {
        console.log(`\n[VISUAL ARCHITECT] Round ${round}/${maxRounds}`);

        // ============================================================================
        // PER-SLIDE BUDGET ABORT CHECKS
        // ============================================================================
        const elapsedMs = Date.now() - startTime;
        
        // Check time budget
        if (elapsedMs > SLIDE_BUDGET_LIMITS.maxTimeMs) {
            console.warn(`[VISUAL ARCHITECT] ⏱️  TIME BUDGET EXCEEDED (${Math.round(elapsedMs / 1000)}s > ${SLIDE_BUDGET_LIMITS.maxTimeMs / 1000}s). Aborting.`);
            return {
                slide: currentSlide,
                rounds: round - 1,
                finalScore: previousScore,
                repairs: allRepairs,
                converged: false,
                totalCost,
                totalInputTokens,
                totalOutputTokens,
                warning: `Budget abort: time exceeded (${Math.round(elapsedMs / 1000)}s)`
            };
        }
        
        // Check cost budget
        if (totalCost > SLIDE_BUDGET_LIMITS.maxCostDollars) {
            console.warn(`[VISUAL ARCHITECT] 💰 COST BUDGET EXCEEDED ($${totalCost.toFixed(4)} > $${SLIDE_BUDGET_LIMITS.maxCostDollars}). Aborting.`);
            return {
                slide: currentSlide,
                rounds: round - 1,
                finalScore: previousScore,
                repairs: allRepairs,
                converged: false,
                totalCost,
                totalInputTokens,
                totalOutputTokens,
                warning: `Budget abort: cost exceeded ($${totalCost.toFixed(4)})`
            };
        }

        try {
            // Step 1: Generate SVG proxy from current slide state
            console.log('[VISUAL ARCHITECT] Generating SVG proxy...');
            const { generateSvgProxy } = await import('./visual/svgProxy');
            const svgString = await generateSvgProxy(currentSlide, styleGuide);

            // RENDER-DIFF GATE: Check if SVG changed from previous round
            const currentSvgHash = hashSvg(svgString);
            if (round > 1 && currentSvgHash === previousSvgHash) {
                console.warn(`[VISUAL ARCHITECT] Repairs had no visual effect - renderer likely ignored hints. Exiting.`);
                return {
                    slide: currentSlide,
                    rounds: round,
                    finalScore: previousScore,
                    repairs: allRepairs,
                    converged: false,
                    totalCost,
                    totalInputTokens,
                    totalOutputTokens,
                    warning: 'Repairs ineffective - hints ignored by renderer'
                };
            }
            previousSvgHash = currentSvgHash;

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
            const rawRepairs = critiqueResult.repairs || [];
            const verdict = critiqueResult.verdict || 'flag_for_review';
            
            // CRITICAL: Normalize repairs to ensure params have numeric values
            // Extracts values from reason text when Qwen-VL doesn't provide them in params
            const repairs = normalizeRepairs(rawRepairs);

            console.log(`[VISUAL ARCHITECT] Score: ${currentScore}/100, Verdict: ${verdict}, Repairs: ${repairs.length}`);

            // STAGNATION DETECTION: If same issue categories persist, abort
            if (detectStagnation(repairHistory, repairs)) {
                console.warn(`[VISUAL ARCHITECT] 🔄 STAGNATION DETECTED: Same issues persist. Recommending layout reroute or content simplification.`);
                return {
                    slide: currentSlide,
                    rounds: round,
                    finalScore: currentScore,
                    repairs: allRepairs,
                    converged: false,
                    totalCost,
                    totalInputTokens,
                    totalOutputTokens,
                    warning: 'Budget abort: stagnation - same issues persist across rounds'
                };
            }
            
            // Track repairs for stagnation detection
            repairHistory.push(repairs);

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

            // Step 4: Apply repairs (already normalized)
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
