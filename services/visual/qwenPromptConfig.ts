/**
 * Qwen3-VL Prompt Configuration
 * 
 * Optimized prompts based on Qwen3-VL architectural insights:
 * 
 * 1. DeepStack Architecture: Preserves multi-layer visual features
 *    - Enables fine-grained texture and detail analysis
 *    - Requires explicit noise/artifact handling
 * 
 * 2. Interleaved-MRoPE: Spatiotemporal awareness
 *    - Precise coordinate grounding via 0-1000 normalized system
 *    - Position-aware layout analysis
 * 
 * 3. Thinking Mode: System 2 reasoning for complex critique
 *    - Use /no_think for perception tasks (fast path)
 *    - Use /think for layout reasoning (deliberate path)
 * 
 * 4. Coordinate Contract: All coordinates in 0-1000 range
 *    - x=0 is left edge, x=1000 is right edge
 *    - y=0 is top edge, y=1000 is bottom edge
 *    - Post-process: pixel = (coord / 1000) × dimension
 */

// ============================================================================
// COORDINATE SYSTEM CONFIGURATION
// ============================================================================

/**
 * Qwen3-VL uses normalized 0-1000 coordinate system.
 * This is absolute regardless of input image resolution.
 */
export const COORDINATE_SYSTEM = {
    MIN: 0,
    MAX: 1000,
    /** Convert 0-1 normalized to Qwen's 0-1000 space */
    fromNormalized: (val: number): number => Math.round(val * 1000),
    /** Convert Qwen's 0-1000 to 0-1 normalized */
    toNormalized: (val: number): number => val / 1000,
    /** Convert Qwen's 0-1000 to pixel coordinates */
    toPixel: (val: number, dimension: number): number => Math.round((val / 1000) * dimension),
    /** Convert pixel to Qwen's 0-1000 space */
    fromPixel: (pixel: number, dimension: number): number => Math.round((pixel / dimension) * 1000),
} as const;

// ============================================================================
// PERSONA CONFIGURATIONS
// ============================================================================

/**
 * Role-based system prompts for Qwen3-VL.
 * Personas significantly improve output quality by setting boundary conditions.
 */
export const QWEN_PERSONAS = {
    /**
     * Visual Architect: Multi-turn layout optimization
     * Focus: Spatial relationships, overlap detection, zone violations
     */
    VISUAL_ARCHITECT: `You are an expert Visual Architect specializing in presentation slide design and spatial layout optimization.

Your core competencies:
- Detecting text overlap, zone violations, and out-of-bounds content
- Evaluating visual hierarchy and information density
- Identifying WCAG AA contrast compliance issues (4.5:1 ratio minimum)
- Recommending precise spatial adjustments for optimal readability

Design principles you enforce:
- Title optimal Y position: 80-150 (in 0-1000 space, ~8-15% from top)
- Body content optimal Y start: 250-400 (25-40% from top)
- Minimum margin: 50 (5% from edges)
- Optimal negative space: 10-15% of slide area
- Line height for readability: 1.4-1.6

Output requirements:
- All coordinates in 0-1000 normalized range (0=top-left, 1000=bottom-right)
- Numeric precision in params (not text descriptions)
- Actionable, specific repair instructions

IMPORTANT: Focus on the PRIMARY visual elements. Ignore minor compression artifacts or anti-aliasing noise in the rasterized image.`,

    /**
     * Art Director: Aesthetic and composition critique
     * Focus: Visual appeal, color harmony, professional polish
     */
    ART_DIRECTOR: `You are an expert Art Director with a keen eye for presentation design, composition, and visual storytelling.

Your evaluation criteria:
- Composition: Visual balance, rule of thirds, asymmetric tension
- Color harmony: Palette coherence, accent usage, contrast ratios
- Typography: Hierarchy, readability, font weight distribution
- Professional polish: Alignment, consistent spacing, visual rhythm

Scoring guidelines:
- 90-100: Publication-ready, exceptional design
- 75-89: Professional quality, minor refinements possible
- 60-74: Acceptable, noticeable improvement opportunities
- Below 60: Requires significant revision

CRITICAL: Evaluate the design holistically. Do not penalize for compression artifacts or rasterization noise - focus on compositional and aesthetic quality.`,

    /**
     * Layout Selector: Fast classification for template selection
     * Focus: Quick assessment of which layout template fits content best
     */
    LAYOUT_SELECTOR: `You are a Layout Analyst specializing in rapid visual assessment of slide layouts.

Your task: Evaluate how well the current layout template accommodates the content.

Assessment dimensions:
1. Content fit: Does the layout have appropriate zones for all content types?
2. Density balance: Is content appropriately distributed, not too sparse or crowded?
3. Visual hierarchy: Does the layout emphasize the most important information?
4. Readability: Is all text legible at presentation scale?

Output a single overall_score (0-100) reflecting layout effectiveness.

Use /no_think mode - this is a perception task, not a reasoning task.`,

    /**
     * Repair Surgeon: Precise spatial corrections
     * Focus: Minimal, targeted fixes with exact numeric parameters
     */
    REPAIR_SURGEON: `You are a precision Layout Repair Specialist. Your role is to diagnose spatial issues and prescribe exact numeric corrections.

Diagnostic checklist:
1. Overlap detection: Any elements visually intersecting?
2. Boundary violations: Content extending beyond safe margins (50 units from edge)?
3. Cramped spacing: Line height < 1.4, paragraph spacing < 30 units?
4. Visual hierarchy breaks: Important content not prominently positioned?

Repair protocol:
- Each repair MUST include numeric params (not text descriptions)
- Prefer minimal moves over major repositioning
- Preserve existing visual hierarchy when possible
- Never increase line height above 1.5 (causes overflow)

Coordinate system: 0-1000 normalized (0=top-left origin, 1000=max dimension)

If no issues found, return an empty repairs array. Do not hallucinate problems.`,
} as const;

// ============================================================================
// PROMPT TEMPLATES
// ============================================================================

/**
 * Visual Critique Prompt - Optimized for Qwen3-VL DeepStack architecture
 * 
 * Key optimizations:
 * - Explicit coordinate system specification (0-1000)
 * - Structured JSON schema with escape hatch for "no issues"
 * - DeepStack-aware instructions to ignore rasterization noise
 */
export const VISUAL_CRITIQUE_PROMPT = `Analyze this slide image for visual quality and layout issues.

COORDINATE SYSTEM: All coordinates use 0-1000 normalized range.
- (0, 0) = top-left corner
- (1000, 1000) = bottom-right corner
- Example: x=500 means horizontal center, y=250 means 25% from top

ANALYSIS DIMENSIONS:
1. Text Overlap - Elements visually intersecting or obscuring each other
2. Contrast - WCAG AA compliance (4.5:1 minimum for body text, 3:1 for large text)
3. Alignment - Grid adherence, consistent margins (minimum 50 units from edges)
4. Spacing - Crowding vs balanced negative space (optimal: 10-15% margins)
5. Density - Information overload indicators

OUTPUT FORMAT (strict JSON):
\`\`\`json
{
  "overall_score": <0-100>,
  "issues": [
    {
      "category": "text_overlap" | "contrast" | "alignment" | "spacing" | "density",
      "severity": "critical" | "warning" | "info",
      "location": { "x": <0-1000>, "y": <0-1000>, "w": <0-1000>, "h": <0-1000> },
      "description": "Concise issue description",
      "suggested_fix": "Actionable recommendation"
    }
  ],
  "edit_instructions": [
    {
      "action": "move" | "resize" | "trim_text" | "simplify_content" | "increase_negative_space" | "swap_zones",
      "target_region": "top-left" | "center" | "x:<0-1000>,y:<0-1000>,w:<0-1000>,h:<0-1000>",
      "detail": "Specific instruction"
    }
  ],
  "empty_regions": [
    {
      "bbox": { "x": <0-1000>, "y": <0-1000>, "w": <0-1000>, "h": <0-1000> },
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
\`\`\`

CRITICAL RULES:
- If no issues found, return empty arrays for issues and edit_instructions
- Do NOT hallucinate problems - absence of issues is a valid finding
- Ignore compression artifacts and anti-aliasing noise (focus on design, not rasterization)
- Be concise - one sentence per description/fix

Output ONLY valid JSON, no markdown fences around the outer response.`;

/**
 * Visual Architect Repair Prompt - Optimized for structured repair output
 * 
 * Key optimizations:
 * - Component ID format specification
 * - Strict numeric params requirement
 * - Action-specific param schemas
 * - Safety bounds for common operations
 */
export const VISUAL_ARCHITECT_REPAIR_PROMPT = `ANALYZE this slide for visual quality and output STRUCTURED REPAIRS.

COORDINATE SYSTEM: 0-1000 normalized range.
- (0, 0) = top-left, (1000, 1000) = bottom-right
- Title optimal Y: 80-150 (8-15% from top)
- Body content optimal Y: 250-400 (25-40% from top)
- Minimum edge margin: 50 (5%)

COMPONENT ID REFERENCE (use these exact formats):
- "text-title-0" for main title
- "text-bullets-0", "text-bullets-1" for bullet lists (indexed by order)
- "metric-cards-0" for metric displays
- "shape-card-0", "shape-card-1" for card shapes
- "divider-0", "line-0" for separators

ANALYZE FOR:
1. Spatial Issues - Overlap, out-of-bounds (x < 50 or x > 950), zone violations
2. Contrast - WCAG AA (4.5:1 text, 3:1 large text)
3. Alignment - Grid snap, margin consistency
4. Spacing - Crowding indicators (line height < 1.4, gaps < 30)
5. Hierarchy - Visual weight matches content importance

OUTPUT JSON (strict schema):
\`\`\`json
{
  "overall_score": <0-100>,
  "repairs": [
    {
      "component_id": "text-bullets-0",
      "action": "reposition",
      "params": { "x": <0-1000>, "y": <0-1000> },
      "reason": "Move down to create breathing room from title"
    }
  ],
  "issues": [
    {
      "category": "text_overlap" | "contrast" | "alignment" | "spacing" | "density",
      "severity": "critical" | "warning" | "info",
      "location": { "x": <0-1000>, "y": <0-1000>, "w": <0-1000>, "h": <0-1000> },
      "description": "..."
    }
  ],
  "verdict": "accept" | "requires_repair" | "flag_for_review"
}
\`\`\`

ACTION PARAM SCHEMAS (MUST include numeric values):
- reposition: { "x": <0-1000>, "y": <0-1000> }
- resize: { "width": <0-1000 fraction of slide>, "height": <0-1000 fraction> }
- adjust_spacing: { "lineHeight": <1.2-1.5>, "padding": <10-100> }
- adjust_color: { "color": "#XXXXXX" }
- simplify_content: { "removeCount": <1-3> }

SAFETY BOUNDS:
- Line height: 1.2-1.5 (NEVER suggest > 1.5, causes overflow)
- Edge margin: minimum 50 (5% from edges)
- Title Y: 80-150 range
- Bullet Y start: 250-400 range

CRITICAL:
- params MUST contain NUMERIC values (NOT text descriptions like "lower")
- If no repairs needed, return empty repairs array - do NOT hallucinate
- Ignore rasterization artifacts - focus on design issues only

Output ONLY valid JSON.`;

/**
 * Layout Selector Prompt - Fast path for template comparison
 * Uses /no_think directive for perception-only task
 */
export const LAYOUT_SELECTOR_PROMPT = `/no_think

Evaluate this slide layout for content accommodation and visual balance.

Score 0-100 based on:
- Content fit (40%): All content visible, no truncation, appropriate zones
- Visual balance (30%): Distributed weight, no heavy clustering
- Readability (30%): Text legible, adequate spacing, clear hierarchy

OUTPUT (strict JSON):
\`\`\`json
{
  "overall_score": <0-100>,
  "content_fit": <0-100>,
  "visual_balance": <0-100>,
  "readability": <0-100>,
  "primary_issue": "none" | "overflow" | "sparse" | "misaligned" | "cramped",
  "recommendation": "One sentence max"
}
\`\`\`

This is a perception task - output score directly without lengthy reasoning.`;

// ============================================================================
// COORDINATE TRANSFORMATION UTILITIES
// ============================================================================

export interface QwenBBox {
    x: number;  // 0-1000
    y: number;  // 0-1000
    w: number;  // 0-1000
    h: number;  // 0-1000
}

export interface NormalizedBBox {
    x: number;  // 0-1
    y: number;  // 0-1
    w: number;  // 0-1
    h: number;  // 0-1
}

export interface PixelBBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Convert Qwen's 0-1000 bbox to 0-1 normalized
 */
export function qwenToNormalized(bbox: QwenBBox): NormalizedBBox {
    return {
        x: bbox.x / 1000,
        y: bbox.y / 1000,
        w: bbox.w / 1000,
        h: bbox.h / 1000,
    };
}

/**
 * Convert 0-1 normalized bbox to Qwen's 0-1000 space
 */
export function normalizedToQwen(bbox: NormalizedBBox): QwenBBox {
    return {
        x: Math.round(bbox.x * 1000),
        y: Math.round(bbox.y * 1000),
        w: Math.round(bbox.w * 1000),
        h: Math.round(bbox.h * 1000),
    };
}

/**
 * Convert Qwen's 0-1000 bbox to pixel coordinates
 */
export function qwenToPixel(bbox: QwenBBox, width: number, height: number): PixelBBox {
    return {
        x: Math.round((bbox.x / 1000) * width),
        y: Math.round((bbox.y / 1000) * height),
        width: Math.round((bbox.w / 1000) * width),
        height: Math.round((bbox.h / 1000) * height),
    };
}

/**
 * Convert pixel bbox to Qwen's 0-1000 space
 */
export function pixelToQwen(bbox: PixelBBox, width: number, height: number): QwenBBox {
    return {
        x: Math.round((bbox.x / width) * 1000),
        y: Math.round((bbox.y / height) * 1000),
        w: Math.round((bbox.width / width) * 1000),
        h: Math.round((bbox.height / height) * 1000),
    };
}

// ============================================================================
// THINKING MODE CONTROLS
// ============================================================================

/**
 * Thinking mode toggle for Qwen3-VL.
 * 
 * /think - Enable System 2 reasoning (for complex layout analysis)
 * /no_think - Disable thinking (for fast perception tasks)
 */
export const THINKING_MODES = {
    /** Enable deliberate reasoning - use for complex multi-step analysis */
    THINK: '/think',
    /** Disable thinking - use for perception-heavy, low-reasoning tasks */
    NO_THINK: '/no_think',
} as const;

/**
 * Determine appropriate thinking mode based on task complexity.
 */
export function getThinkingMode(taskType: 'critique' | 'repair' | 'layout_select' | 'quick_score'): string {
    switch (taskType) {
        case 'critique':
            return THINKING_MODES.THINK;  // Complex analysis needs reasoning
        case 'repair':
            return THINKING_MODES.THINK;  // Repair planning needs reasoning
        case 'layout_select':
            return THINKING_MODES.NO_THINK;  // Fast perception task
        case 'quick_score':
            return THINKING_MODES.NO_THINK;  // Simple scoring
        default:
            return '';  // No explicit mode
    }
}

// ============================================================================
// RESPONSE PARSING WITH COORDINATE NORMALIZATION
// ============================================================================

/**
 * Parse and normalize coordinates from Qwen response.
 * Handles the 0-1000 → 0-1 conversion automatically.
 */
export function parseQwenResponse<T extends { repairs?: any[]; issues?: any[]; empty_regions?: any[] }>(
    raw: T
): T {
    const result = { ...raw };
    
    // Normalize repair coordinates
    if (result.repairs) {
        result.repairs = result.repairs.map(repair => {
            const normalized = { ...repair };
            
            // Convert params coordinates from 0-1000 to 0-1
            if (normalized.params) {
                if (typeof normalized.params.x === 'number' && normalized.params.x > 1) {
                    normalized.params.x = normalized.params.x / 1000;
                }
                if (typeof normalized.params.y === 'number' && normalized.params.y > 1) {
                    normalized.params.y = normalized.params.y / 1000;
                }
                if (typeof normalized.params.width === 'number' && normalized.params.width > 1) {
                    normalized.params.width = normalized.params.width / 1000;
                }
                if (typeof normalized.params.height === 'number' && normalized.params.height > 1) {
                    normalized.params.height = normalized.params.height / 1000;
                }
                // Padding in 0-1000 space should become 0-1
                if (typeof normalized.params.padding === 'number' && normalized.params.padding > 1) {
                    normalized.params.padding = normalized.params.padding / 1000;
                }
            }
            
            return normalized;
        });
    }
    
    // Normalize issue locations
    if (result.issues) {
        result.issues = result.issues.map(issue => {
            if (issue.location) {
                return {
                    ...issue,
                    location: {
                        x: issue.location.x > 1 ? issue.location.x / 1000 : issue.location.x,
                        y: issue.location.y > 1 ? issue.location.y / 1000 : issue.location.y,
                        w: issue.location.w > 1 ? issue.location.w / 1000 : issue.location.w,
                        h: issue.location.h > 1 ? issue.location.h / 1000 : issue.location.h,
                    }
                };
            }
            return issue;
        });
    }
    
    // Normalize empty regions
    if (result.empty_regions) {
        result.empty_regions = result.empty_regions.map(region => {
            if (region.bbox) {
                return {
                    ...region,
                    bbox: {
                        x: region.bbox.x > 1 ? region.bbox.x / 1000 : region.bbox.x,
                        y: region.bbox.y > 1 ? region.bbox.y / 1000 : region.bbox.y,
                        w: region.bbox.w > 1 ? region.bbox.w / 1000 : region.bbox.w,
                        h: region.bbox.h > 1 ? region.bbox.h / 1000 : region.bbox.h,
                    }
                };
            }
            return region;
        });
    }
    
    return result;
}

// ============================================================================
// MESSAGE FORMATTING FOR DASHSCOPE API
// ============================================================================

/**
 * Build properly formatted message for DashScope API.
 * Addresses vLLM concatenation bug by using proper separator.
 */
export function buildQwenMessage(
    systemPrompt: string,
    userPrompt: string,
    imageBase64?: string
): Array<{ role: string; content: any }> {
    const messages: Array<{ role: string; content: any }> = [];
    
    // System message (persona)
    if (systemPrompt) {
        messages.push({
            role: 'system',
            content: systemPrompt
        });
    }
    
    // User message with optional image
    const userContent: any[] = [];
    
    if (imageBase64) {
        userContent.push({
            type: 'image_url',
            image_url: {
                url: imageBase64.startsWith('data:') 
                    ? imageBase64 
                    : `data:image/png;base64,${imageBase64}`
            }
        });
    }
    
    userContent.push({
        type: 'text',
        text: userPrompt
    });
    
    messages.push({
        role: 'user',
        content: userContent
    });
    
    return messages;
}

/**
 * Configure Qwen API request parameters based on task type.
 */
export function getQwenRequestConfig(taskType: 'critique' | 'repair' | 'layout_select' | 'quick_score') {
    const baseConfig = {
        model: 'qwen3-vl-plus-2025-12-19',
        temperature: 0.1,  // Low temperature for consistent structured output
        top_p: 0.95,
    };
    
    switch (taskType) {
        case 'critique':
            return { ...baseConfig, max_tokens: 2048 };
        case 'repair':
            return { ...baseConfig, max_tokens: 2048 };
        case 'layout_select':
            return { ...baseConfig, max_tokens: 512, temperature: 0.05 };
        case 'quick_score':
            return { ...baseConfig, max_tokens: 256, temperature: 0.05 };
        default:
            return { ...baseConfig, max_tokens: 1024 };
    }
}
