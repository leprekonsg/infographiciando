/**
 * Visual Design Agent - Interactions API Migration
 * 
 * This agent creates spatial and visual composition specifications for slides.
 * Migrated to use the Gemini Interactions API for consistency.
 */

import { SlideNode, RouterDecision, VisualDesignSpec, VisualDesignSpecSchema, ResearchFact, GlobalStyleGuide } from "../types/slideTypes";
import { PROMPTS } from "./promptRegistry";
import { createJsonInteraction, CostTracker, ThinkingLevel, MODEL_AGENTIC, MODEL_SIMPLE } from "./interactionsClient";
import { validateVisualLayoutAlignment, validateCritiqueResponse, validateRepairResponse } from "./validators";
import { SpatialLayoutEngine } from "./spatialRenderer";

// Visual Designer: Spatial reasoning is an agentic task → MODEL_AGENTIC (3 Flash)
// Phil Schmid: Flash beats Pro on agentic benchmarks (78% vs 76.2% SWE-bench)

// Helper to determine component types for the prompt before they exist
function estimateComponentTypes(routerConfig: RouterDecision, contentPlan: any): string[] {
    const types: Set<string> = new Set();
    const layout = routerConfig.layoutVariant;
    const mode = routerConfig.renderMode;

    // 1. Data-Viz priority
    if (mode === 'data-viz' || (contentPlan.chartSpec && contentPlan.chartSpec.type)) {
        types.add('chart-frame');
    }

    // 2. Layout-specific forcing
    if (layout === 'bento-grid') {
        types.add('metric-cards');
        types.add('icon-grid');
    } else if (layout === 'timeline-horizontal') {
        types.add('process-flow');
    }

    // 3. Content heuristics
    const numKeyPoints = contentPlan.keyPoints?.length || 0;
    const hasData = contentPlan.dataPoints && contentPlan.dataPoints.length > 0;

    if (hasData && !types.has('chart-frame')) {
        types.add('metric-cards');
    }

    if (numKeyPoints > 0) {
        if (numKeyPoints <= 2 && mode === 'statement') {
            types.add('hero-text'); // Will map to text-bullets with special style
        } else {
            types.add('text-bullets');
        }
    }

    // Default fallback
    if (types.size === 0) return ['text-bullets'];

    return Array.from(types);
}

export const runVisualDesigner = async (
    slideTitle: string,
    contentPlan: any,
    routerConfig: RouterDecision,
    facts: ResearchFact[],
    tracker: CostTracker
): Promise<VisualDesignSpec> => {
    const MAX_ATTEMPTS = 2;
    const layoutEngine = new SpatialLayoutEngine();

    // STEP 1: Analyze spatial requirements
    const zones = layoutEngine.getZonesForVariant(routerConfig.layoutVariant);
    const spatialStrategy = {
        zones,
        compositional_hierarchy: "Derived from layout template",
        negative_space_plan: "Standard",
        visual_weight_distribution: "Balanced"
    };

    const componentTypes = estimateComponentTypes(routerConfig, contentPlan);

    // NOTE: Schema flattened to comply with Gemini Interactions API 4-level nesting limit.
    // The 'zones' array is simplified - detailed zone structure is handled via prompt guidance.
    const visualDesignSchema = {
        type: "object",
        properties: {
            spatial_strategy: {
                type: "object",
                properties: {
                    // Zones array simplified to avoid depth limit (was 5 levels deep)
                    zones: { type: "array" },
                    compositional_hierarchy: { type: "string" },
                    negative_space_plan: { type: "string" },
                    visual_weight_distribution: { type: "string" }
                }
            },
            prompt_with_composition: { type: "string" },
            foreground_elements: { type: "array", items: { type: "string" } },
            background_treatment: { type: "string" },
            negative_space_allocation: { type: "string" },
            color_harmony: {
                type: "object",
                properties: {
                    primary: { type: "string" },
                    accent: { type: "string" },
                    background_tone: { type: "string" }
                }
            }
        },
        required: ["spatial_strategy", "prompt_with_composition", "background_treatment", "color_harmony"]
    };

    // Use passed tracker directly
    const costTracker = tracker;

    let previousErrors: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            console.log(`[VISUAL DESIGNER] Attempt ${attempt}/${MAX_ATTEMPTS} for "${slideTitle}"...`);

            let taskPrompt = PROMPTS.VISUAL_COMPOSER.TASK({
                title: slideTitle,
                visualFocus: routerConfig.visualFocus,
                layoutVariant: routerConfig.layoutVariant,
                spatialStrategy: spatialStrategy,
                componentTypes: componentTypes,
                densityContext: routerConfig.densityBudget,
                styleGuide: "Modern Professional"
            });

            if (previousErrors.length > 0) {
                taskPrompt += `\n\nCRITICAL FIX REQUIRED: The previous attempt failed validation. \nERRORS: ${JSON.stringify(previousErrors)}\nEnsure you address these issues in the new design.`;
            }

            const rawVisualPrompt = await createJsonInteraction<any>(
                MODEL_AGENTIC, // Spatial reasoning = agentic task, Flash outperforms Pro
                taskPrompt,
                visualDesignSchema,
                {
                    systemInstruction: PROMPTS.VISUAL_COMPOSER.ROLE,
                    thinkingLevel: 'low' as ThinkingLevel,
                    temperature: 0.3,
                    maxOutputTokens: 4096
                },
                costTracker
            );

            // STEP 2: Inject pre-computed spatial_strategy (LLM-generated zones are unreliable)
            // The LLM generates creative fields; zones come from deterministic layout templates
            const visualPrompt: VisualDesignSpec = {
                ...rawVisualPrompt,
                spatial_strategy: spatialStrategy // Use pre-computed zones from layoutEngine
            };

            // STEP 3: Schema Validation (Hard Parse)
            const parseResult = VisualDesignSpecSchema.safeParse(visualPrompt);
            if (!parseResult.success) {
                // Extract error details from the failed parse result
                const errors = (parseResult as any).error?.errors ?? [];
                const formatted = (parseResult as any).error?.format?.() ?? {};
                console.warn(`[VISUAL DESIGNER] Schema violations:`, formatted);
                previousErrors = errors.map((e: any) => `Schema Error at ${(e.path || []).join('.')}: ${e.message || 'Unknown'}`);
                continue;
            }

            // STEP 3: Validate visual alignment with layout
            const alignment = validateVisualLayoutAlignment(
                visualPrompt,
                routerConfig
            );

            // Phase 2: Log alignment score for tracking visual first-pass success rate
            console.log(`[VISUAL DESIGNER] Alignment score: ${alignment.score}/100 for "${slideTitle}"`);

            if (alignment.passed) {
                console.log(`[VISUAL DESIGNER] ✅ SUCCESS for "${slideTitle}" (score: ${alignment.score})`);
                return visualPrompt;
            }

            console.warn(`[VISUAL DESIGNER] ⚠️ Validation warning (score: ${alignment.score}): ${alignment.errors.map(e => e.message).join(', ')}`);
            previousErrors = alignment.errors.map(e => e.message);

            if (attempt === MAX_ATTEMPTS) {
                // Return best effort if out of retries
                console.log(`[VISUAL DESIGNER] Returning best effort (score: ${alignment.score})`);
                return visualPrompt;
            }

        } catch (e: any) {
            console.error(`[VISUAL DESIGNER] Failed (attempt ${attempt}):`, e.message);

            // If rate limited, wait before retry
            if (e.message.includes('429') || e.message.includes('503')) {
                const delay = Math.pow(2, attempt) * 1000;
                console.warn(`[VISUAL DESIGNER] Rate limited. Waiting ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    // Fallback - Use deterministic, context-aware fallback instead of generic prompt
    console.warn("[VISUAL DESIGNER] Using fallback design spec");

    // Build an ABSTRACT BACKGROUND fallback prompt - NO text, diagrams, or icons
    // All content is rendered separately by SpatialLayoutEngine
    const contextAwareFallbackPrompt = `
Abstract background gradient for professional presentation slide.
Theme: ${routerConfig.visualFocus || 'Corporate Technology'}.
Style: Dark gradient from #0f172a to #1e293b with subtle ${routerConfig.visualFocus ? routerConfig.visualFocus.toLowerCase() : 'blue'} accent glow.
Mood: Modern, premium, sophisticated.
Texture: Soft ambient lighting, subtle geometric patterns fading into background.
IMPORTANT: No text, no icons, no diagrams, no charts - abstract gradient ONLY.
`.trim();

    return {
        spatial_strategy: spatialStrategy as any,
        prompt_with_composition: contextAwareFallbackPrompt,
        foreground_elements: [], // Deprecated - not used for rendering
        background_treatment: "Gradient",
        negative_space_allocation: "20%",
        color_harmony: { primary: "#10b981", accent: "#f59e0b", background_tone: "#0f172a" }
    };
};

// --- SYSTEM 2: SYNTHETIC VISUAL CORTEX ---

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
    const getIconUrl = (name: string) => undefined;

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
            const bold = el.bold ? 'bold' : 'normal';

            // Truncate content to 40 chars for high-priority, 25 for others
            const maxChars = el.zone?.purpose === 'hero' ? 40 : 25;
            const content = (el.content || '').substring(0, maxChars);
            const truncated = el.content && el.content.length > maxChars ? '...' : '';

            // Escape XML special characters
            const escaped = (content + truncated)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');

            elementSvg = `  <text x="${x}" y="${y + fontSize}" font-size="${fontSize}" `;
            elementSvg += `fill="#${color}" font-weight="${bold}" text-anchor="${align === 'center' ? 'middle' : 'start'}">`;
            elementSvg += escaped;
            elementSvg += `</text>\n`;

        } else if (el.type === 'shape') {
            const fillColor = el.fill?.color?.replace('#', '') || '22C55E';
            const fillAlpha = el.fill?.alpha !== undefined ? el.fill.alpha : 1;
            const borderColor = el.border?.color?.replace('#', '') || fillColor;
            const borderWidth = el.border?.width || 0;
            const radius = (el as any).rectRadius || 0;

            if (el.shapeType === 'rect') {
                elementSvg = `  <rect x="${x}" y="${y}" width="${w}" height="${h}" `;
                elementSvg += `fill="#${fillColor}" fill-opacity="${fillAlpha}" `;
                if (borderWidth > 0) {
                    elementSvg += `stroke="#${borderColor}" stroke-width="${borderWidth}" `;
                }
                if (radius > 0) {
                    elementSvg += `rx="${radius}" ry="${radius}" `;
                }
                elementSvg += `/>\n`;
            } else if (el.shapeType === 'circle' || el.shapeType === 'ellipse') {
                const cx = x + w / 2;
                const cy = y + h / 2;
                const rx = w / 2;
                const ry = h / 2;
                elementSvg = `  <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" `;
                elementSvg += `fill="#${fillColor}" fill-opacity="${fillAlpha}" />\n`;
            }

            // Render shape text if present
            if (el.text) {
                const textColor = el.textColor?.replace('#', '') || 'FFFFFF';
                const textX = x + w / 2;
                const textY = y + h / 2 + 6; // Approximate vertical center
                const escaped = el.text
                    .substring(0, 20) // Reduce from 30 to save space
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                elementSvg += `  <text x="${textX}" y="${textY}" font-size="14" `;
                elementSvg += `fill="#${textColor}" text-anchor="middle">${escaped}</text>\n`;
            }
        }
        // Skip image elements (data URLs would bloat SVG excessively)

        // Check if adding this element would exceed size limit
        if (currentSize + elementSvg.length > MAX_SVG_SIZE) {
            // Stop adding elements - size limit reached
            break;
        }

        // Add element to SVG and update size counter
        svg += elementSvg;
        currentSize += elementSvg.length;
        renderedCount++;
    }

    if (elements.length > renderedCount) {
        svg += `  <!-- ${elements.length - renderedCount} lower-priority elements omitted (size limit: ${MAX_SVG_SIZE}) -->\n`;
    }

    svg += `</svg>`;

    // GAP 4: With priority-based inclusion, we should always stay under limit
    // Log warning if we're close to the limit
    if (svg.length > 13000) {
        console.warn(`[SVG PROXY] SVG proxy approaching size limit: ${svg.length} chars (${renderedCount}/${elements.length} elements)`);
    } else {
        console.log(`[SVG PROXY] Generated content-aware SVG: ${svg.length} chars, ${renderedCount}/${elements.length} elements`);
    }

    return svg;
}

/**
 * Fallback simplified SVG proxy (zone boxes only).
 * Used when content-aware SVG exceeds size limit.
 */
function generateSimplifiedSvgProxy(slide: SlideNode): string {
    const variant = slide.routerConfig?.layoutVariant || 'standard-vertical';
    const layoutEngine = new SpatialLayoutEngine();
    const zones = layoutEngine.getZonesForVariant(variant);

    let svg = `<svg viewBox="0 0 1000 563" xmlns="http://www.w3.org/2000/svg">\n`;
    svg += `  <rect x="0" y="0" width="1000" height="563" fill="#0f172a" id="bg"/>\n`;

    zones.forEach(zone => {
        const x = Math.round(zone.x * 100);
        const y = Math.round(zone.y * 100);
        const w = Math.round(zone.w * 100);
        const h = Math.round(zone.h * 100);

        const stroke = zone.purpose === 'hero' ? '#22c55e' :
                       zone.purpose === 'secondary' ? '#3b82f6' : '#f59e0b';

        svg += `  <rect x="${x}" y="${y}" width="${w}" height="${h}" `;
        svg += `fill="none" stroke="${stroke}" stroke-width="2" id="${zone.id}"/>\n`;
    });

    svg += `</svg>`;
    return svg;
}

/**
 * Run visual critique agent on a slide.
 * Returns VisualCritiqueReport with issues and overall score.
 */
export async function runVisualCritique(
    slide: SlideNode,
    svgProxy: string,
    costTracker: CostTracker
): Promise<any> {
    const variant = slide.routerConfig?.layoutVariant || 'standard-vertical';
    const componentTypes = (slide.layoutPlan?.components || []).map(c => c.type);

    // Simplified critique schema for Gemini API (avoid deep nesting)
    const critiqueSchema = {
        type: "object",
        properties: {
            issues: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        severity: { type: "string", enum: ["critical", "major", "minor"] },
                        category: { type: "string", enum: ["overlap", "contrast", "alignment", "hierarchy", "density"] },
                        zone: { type: "string" },
                        description: { type: "string" },
                        suggestedFix: { type: "string" }
                    },
                    required: ["severity", "category", "description", "suggestedFix"]
                }
            },
            overallScore: { type: "number" },
            hasCriticalIssues: { type: "boolean" }
        },
        required: ["issues", "overallScore", "hasCriticalIssues"]
    };

    try {
        const rawResult = await createJsonInteraction<any>(
            MODEL_SIMPLE, // Simple classification task - use cheap model
            PROMPTS.LAYOUT_CRITIC.TASK(svgProxy, variant, componentTypes),
            critiqueSchema,
            {
                systemInstruction: PROMPTS.LAYOUT_CRITIC.ROLE,
                temperature: 0.1,
                maxOutputTokens: 2048
            },
            costTracker
        );

        // Post-validate with Zod schema for runtime type safety
        const validated = validateCritiqueResponse(rawResult);
        if (!validated) {
            console.warn(`[VISUAL CRITIQUE] API response failed Zod validation, using fallback`);
            return { issues: [], overallScore: 75, hasCriticalIssues: false };
        }

        // Clamp score to valid range
        const validatedResult = {
            issues: validated.issues || [],
            overallScore: Math.min(100, Math.max(0, validated.overallScore)),
            hasCriticalIssues: validated.hasCriticalIssues
        };

        console.log(`[VISUAL CRITIQUE] Score: ${validatedResult.overallScore}, Issues: ${validatedResult.issues.length}`);
        return validatedResult;

    } catch (e: any) {
        console.error(`[VISUAL CRITIQUE] Failed:`, e.message);
        // Return passing result on error - don't block generation
        return { issues: [], overallScore: 75, hasCriticalIssues: false };
    }
}

/**
 * Run layout repair agent to fix visual issues.
 * Returns repaired SlideNode or original on failure.
 */
export async function runLayoutRepair(
    slide: SlideNode,
    critique: any,
    svgProxy: string,
    costTracker: CostTracker
): Promise<SlideNode> {
    const layoutPlanJson = JSON.stringify(slide.layoutPlan);
    const critiqueJson = JSON.stringify(critique);

    // Use same minimal schema as Generator for compatibility
    const repairSchema = {
        type: "object",
        properties: {
            title: { type: "string" },
            background: { type: "string", enum: ["solid", "gradient", "image"] },
            components: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        type: { type: "string", enum: ["text-bullets", "metric-cards", "process-flow", "icon-grid", "chart-frame", "title-section"] }
                    },
                    required: ["type"]
                }
            }
        },
        required: ["title", "components"]
    };

    try {
        const rawRepairedLayout = await createJsonInteraction<any>(
            MODEL_AGENTIC, // Repair requires reasoning - use agentic model
            PROMPTS.LAYOUT_REPAIRER.TASK(layoutPlanJson, critiqueJson, svgProxy),
            repairSchema,
            {
                systemInstruction: PROMPTS.LAYOUT_REPAIRER.ROLE,
                temperature: 0.2,
                maxOutputTokens: 4096
            },
            costTracker
        );

        // Post-validate with Zod schema for runtime type safety
        const validatedLayout = validateRepairResponse(rawRepairedLayout);
        if (!validatedLayout) {
            console.warn(`[LAYOUT REPAIR] API response failed Zod validation, returning original`);
            return {
                ...slide,
                warnings: [...(slide.warnings || []), 'Layout repair failed: invalid schema']
            };
        }

        // Return repaired slide - autoRepairSlide will be called by the orchestrator
        const repairedSlide: SlideNode = {
            ...slide,
            layoutPlan: validatedLayout,
            warnings: [...(slide.warnings || []), 'Layout repaired by System 2']
        };

        console.log(`[LAYOUT REPAIR] Successfully repaired layout for "${slide.title}"`);
        return repairedSlide;

    } catch (e: any) {
        console.error(`[LAYOUT REPAIR] Failed:`, e.message);
        // Return original on failure
        return {
            ...slide,
            warnings: [...(slide.warnings || []), `Layout repair failed: ${e.message}`]
        };
    }
}
