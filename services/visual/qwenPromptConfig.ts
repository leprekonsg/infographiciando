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

COMPONENT ID REFERENCE (use ONLY IDs from ComponentManifest comment):
- Format: "{component-type}-{index}" where index maps to layoutPlan.components[index]
- Example: "text-bullets-0" → layoutPlan.components[0], "metric-cards-1" → layoutPlan.components[1]
- The ComponentManifest comment in the SVG lists ALL valid component IDs
- For slide title positioning, use "title" (not a numbered component)
- For divider/accent bar positioning, use "divider" (not a numbered component)
- DO NOT use render-order IDs like "text-0", "shape-1" - use component IDs only

VALID COMPONENT TYPES:
- "text-bullets-N" for bullet point lists
- "metric-cards-N" for numeric metric displays
- "chart-frame-N" for data visualizations
- "process-flow-N" for step/process diagrams
- "icon-grid-N" for icon-based layouts
- "diagram-svg-N" for complex diagrams

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

// ============================================================================
// STYLE-AWARE VISUAL CRITIQUE RUBRICS
// ============================================================================

/**
 * StyleMode type for rubric selection.
 * Matches the StyleMode from slideTypes.ts
 */
export type QwenStyleMode = 'corporate' | 'professional' | 'serendipitous';

/**
 * Style-aware visual critique rubrics.
 * Each rubric emphasizes different visual qualities based on the target audience.
 * 
 * These rubrics transform System 2 validation from "is it broken?" to
 * "does it match the intended style?" - a critical shift for quality differentiation.
 */
export const STYLE_RUBRICS = {
    /**
     * Corporate Clarity Rubric
     * Target: Board decks, investor presentations, formal reports
     * Priority: Zero tolerance for chaos, maximum legibility, professional polish
     */
    corporate_clarity: `STYLE RUBRIC: CORPORATE CLARITY
Target audience: Executives, board members, investors, formal stakeholders

MANDATORY REQUIREMENTS (fail = requires_repair):
1. Grid Alignment: ALL elements must snap to a 50-unit grid (in 0-1000 space)
   - Text boxes aligned to left edge OR center
   - No "floating" elements that break visual rhythm
   - Consistent vertical spacing between sections

2. Text Legibility (STRICT):
   - Title: Minimum 24pt equivalent, high contrast (>7:1 ratio)
   - Body: Minimum 16pt equivalent, WCAG AAA compliance (>7:1 ratio)
   - NO text truncation visible - all content fully readable
   - Line height minimum 1.4 for body text

3. Visual Hierarchy (EXPLICIT):
   - Clear single focal point (title or hero metric)
   - Supporting content visually subordinate
   - No competing visual weights

4. Chart Legibility (if present):
   - Axis labels fully readable
   - Data labels present and legible
   - Legend clearly positioned and readable
   - No overlapping data elements

5. Professional Polish:
   - Consistent color palette (max 3 colors + neutrals)
   - No visual "noise" or decorative distractions
   - Adequate negative space (minimum 15% of slide area)
   - Edge margins respected (minimum 50 units from all edges)

SEVERITY WEIGHTING:
- Text truncation: CRITICAL (instant requires_repair)
- Chart legibility failure: CRITICAL
- Grid misalignment: WARNING (flag_for_review at 3+ instances)
- Contrast below 7:1: WARNING
- Insufficient negative space: INFO

SCORING ADJUSTMENTS FOR CORPORATE:
- Deduct 20 points for ANY "creative" asymmetry
- Deduct 15 points for serif fonts in data visualizations
- Deduct 10 points for more than 3 accent colors
- Add 10 points for perfect grid alignment throughout`,

    /**
     * Balanced Rubric (Professional)
     * Target: General business, team presentations, workshops
     * Priority: Readability + moderate visual interest, flexible standards
     */
    balanced: `STYLE RUBRIC: PROFESSIONAL BALANCE
Target audience: Business professionals, team meetings, workshops

EVALUATION PRIORITIES (balanced weighting):

1. Core Readability (40% of score):
   - All text legible at presentation distance
   - WCAG AA compliance (4.5:1 contrast minimum)
   - No critical truncation (minor overflow acceptable if context clear)
   - Line height 1.3-1.5 acceptable

2. Visual Organization (30% of score):
   - Clear content grouping
   - Logical flow (top-to-bottom, left-to-right)
   - Consistent spacing within sections
   - Minor alignment variations acceptable if intentional

3. Professional Appearance (20% of score):
   - Coherent color palette
   - Appropriate use of imagery/icons
   - No jarring visual elements
   - Margins respected (40 units minimum)

4. Visual Interest (10% of score):
   - Some visual variety welcome
   - Color accents add engagement
   - Moderate asymmetry acceptable
   - Personality allowed if not distracting

FLEXIBILITY ZONES:
- Grid alignment: 50-unit tolerance (vs. perfect snap)
- Color count: Up to 4 accent colors acceptable
- Asymmetry: Intentional asymmetry is a feature, not a bug
- Negative space: 10-15% range acceptable

SEVERITY WEIGHTING:
- Text truncation (critical content): CRITICAL
- Contrast below AA (4.5:1): WARNING
- Alignment inconsistency: INFO
- Color palette expansion: INFO

SCORING NOTES:
- Do NOT penalize for creative layouts if content remains clear
- Award points for visual hierarchy that aids comprehension
- Minor imperfections acceptable if overall professionalism maintained`,

    /**
     * Serendipity Impact Rubric
     * Target: Creative pitches, thought leadership, inspiration
     * Priority: Boldness, visual drama, memorable impact over conformity
     */
    serendipity_impact: `STYLE RUBRIC: SERENDIPITY IMPACT
Target audience: Creative professionals, innovation pitches, thought leadership

EVALUATION PHILOSOPHY:
This is NOT a safety check - this is an IMPACT assessment.
We're asking: "Would this make someone stop and pay attention?"

PRIMARY CRITERIA (impact-weighted):

1. Visual Drama (35% of score):
   - Does the slide have a clear FOCAL POINT that commands attention?
   - Is there intentional TENSION in the composition?
   - Does the layout avoid "template-y" corporate sameness?
   - Is negative space used BOLDLY (not just "adequately")?

2. Memorable Design (30% of score):
   - Would you remember this slide tomorrow?
   - Does it break expected patterns in a meaningful way?
   - Is there a visual "hook" or surprise element?
   - Does the design feel AUTHORED, not assembled?

3. Content Legibility (25% of score):
   - Core message readable (hero text, key metric)
   - Supporting content accessible (but can be secondary)
   - WCAG AA acceptable (4.5:1) - but HIGH contrast preferred (10:1+)
   - Truncation acceptable for decorative/atmospheric text

4. Cohesive Vision (10% of score):
   - Does the visual style serve the message?
   - Is boldness intentional, not accidental?
   - Do "breaking" elements feel designed, not broken?

ENCOURAGED ELEMENTS:
+ Dramatic asymmetry with purpose
+ Bold color contrasts and accent pops
+ Generous negative space (>20% encouraged)
+ Oversized typography for impact
+ Atmospheric/background elements that add depth
+ Rule-of-thirds positioning over center-alignment

THINGS NOT TO PENALIZE:
- Text that "breathes" (minimal bullet points)
- Unconventional layouts that still communicate
- Color boldness that maintains readability
- Asymmetric compositions with clear focal point
- Large empty areas (negative space is a feature)

RED FLAGS (require repair):
- Core message unreadable or obscured
- Chaotic layout with NO focal point
- Contrast so low that key text disappears
- Boldness that undermines rather than enhances message
- "Random" chaos vs. intentional drama

SCORING PHILOSOPHY:
- A "safe" but forgettable slide should score 50-60
- A bold slide with minor legibility issues: 70-80
- A dramatic slide that communicates clearly: 85-95
- A timid, template-like slide: 30-50 (fails the style intent)

CRITICAL: If the slide looks like it could have come from a generic template,
that is a FAILURE of serendipitous style, regardless of technical correctness.`
} as const;

/**
 * Get the appropriate style rubric for visual critique.
 * @param styleMode The style mode to use for critique
 * @returns The rubric text to append to the visual critique prompt
 */
export function getStyleRubric(styleMode: QwenStyleMode): string {
    switch (styleMode) {
        case 'corporate':
            return STYLE_RUBRICS.corporate_clarity;
        case 'professional':
            return STYLE_RUBRICS.balanced;
        case 'serendipitous':
            return STYLE_RUBRICS.serendipity_impact;
        default:
            return STYLE_RUBRICS.balanced; // Safe fallback
    }
}

/**
 * Build a style-aware visual critique prompt.
 * Combines the base critique prompt with the appropriate style rubric.
 * 
 * @param styleMode The style mode driving the critique rubric
 * @returns Complete prompt with style-specific evaluation criteria
 */
export function buildStyleAwareCritiquePrompt(styleMode: QwenStyleMode): string {
    const rubric = getStyleRubric(styleMode);
    
    return `${VISUAL_CRITIQUE_PROMPT}

---

${rubric}

IMPORTANT: Apply the style rubric above when determining severity ratings and the overall_verdict.
A slide that is technically correct but fails to match the style intent should be flagged for review.`;
}

/**
 * Build a style-aware repair prompt.
 * Adjusts repair priorities based on style mode.
 * 
 * @param styleMode The style mode driving repair priorities
 * @returns Complete repair prompt with style-specific priorities
 */
export function buildStyleAwareRepairPrompt(styleMode: QwenStyleMode): string {
    const styleContext = getStyleRepairContext(styleMode);
    
    return `${VISUAL_ARCHITECT_REPAIR_PROMPT}

---

STYLE-SPECIFIC REPAIR PRIORITIES:
${styleContext}

Apply these priorities when determining which repairs are most important.`;
}

/**
 * Get style-specific repair context.
 */
function getStyleRepairContext(styleMode: QwenStyleMode): string {
    switch (styleMode) {
        case 'corporate':
            return `MODE: CORPORATE
Repair Priority Order:
1. TEXT TRUNCATION - Fix immediately, no tolerance
2. GRID ALIGNMENT - Snap all elements to 50-unit grid
3. CONTRAST - Elevate to AAA (7:1) if possible
4. NEGATIVE SPACE - Increase to minimum 15%
5. COLOR SIMPLIFICATION - Reduce to max 3 accent colors

Avoid: ANY asymmetric "creative" repositioning`;

        case 'professional':
            return `MODE: PROFESSIONAL
Repair Priority Order:
1. CRITICAL TRUNCATION - Fix text that loses meaning
2. CONTRAST - Ensure AA compliance (4.5:1)
3. OVERLAP - Resolve any element collisions
4. SPACING - Normalize to consistent rhythm
5. MARGINS - Ensure 40-unit minimum from edges

Allow: Moderate asymmetry if it aids visual interest`;

        case 'serendipitous':
            return `MODE: SERENDIPITOUS
Repair Priority Order:
1. FOCAL POINT - Ensure ONE clear visual anchor
2. CORE MESSAGE - Key text must be readable (10:1+ preferred)
3. INTENTIONAL DRAMA - Preserve bold positioning, don't "normalize"
4. NEGATIVE SPACE - INCREASE if cramped, dramatic space is good

Avoid: Repairs that make the slide look "safer" or more template-like
Preserve: Bold asymmetry, generous whitespace, dramatic scale contrasts`;

        default:
            return '';
    }
}

/**
 * Determine if a slide passes style-specific quality gates.
 * Different modes have different acceptance thresholds.
 * 
 * @param score The overall score from Qwen critique (0-100)
 * @param styleMode The style mode to evaluate against
 * @param hasCriticalIssues Whether any critical issues were found
 * @returns Whether the slide passes the style-specific quality gate
 */
export function passesStyleQualityGate(
    score: number,
    styleMode: QwenStyleMode,
    hasCriticalIssues: boolean
): boolean {
    // Critical issues always fail, regardless of mode
    if (hasCriticalIssues) return false;
    
    // Style-specific thresholds
    const thresholds = {
        corporate: 85,      // High bar - safety first
        professional: 75,   // Standard bar
        serendipitous: 65   // Lower bar - impact over safety
    };
    
    const threshold = thresholds[styleMode] ?? 75;
    return score >= threshold;
}

/**
 * Get style-specific thinking mode.
 * Corporate mode uses more deliberate analysis; serendipitous uses faster perception.
 * 
 * @param styleMode The style mode
 * @param taskType The task being performed
 * @returns Thinking mode directive
 */
export function getStyleAwareThinkingMode(
    styleMode: QwenStyleMode,
    taskType: 'critique' | 'repair' | 'layout_select' | 'quick_score'
): string {
    // Corporate always uses thinking for thoroughness
    if (styleMode === 'corporate') {
        return THINKING_MODES.THINK;
    }
    
    // Serendipitous uses faster perception for most tasks
    if (styleMode === 'serendipitous') {
        return taskType === 'repair' ? THINKING_MODES.THINK : THINKING_MODES.NO_THINK;
    }
    
    // Professional uses default task-based thinking
    return getThinkingMode(taskType);
}
