/**
 * Slide Agent Service - Interactions API Migration
 * 
 * This module implements a multi-agent system for generating presentation decks
 * using the Gemini Interactions API. It follows the agent patterns from:
 * - https://ai.google.dev/api/interactions-api.md.txt
 * - https://www.philschmid.de/building-agents
 * 
 * Key Improvements:
 * - Proper Interactions API usage with status tracking
 * - Function calling with client-side tool execution loop
 * - Max iterations guard (escape hatch)
 * - Structured logging and transparency
 * - Thought signature preservation (Gemini 3)
 * - Style-aware pipeline (StyleMode propagation through all agents)
 */

import {
    EditableSlideDeck, SlideNode, SLIDE_TYPES, GlobalStyleGuide,
    ResearchFact, RouterDecision,
    FactClusterSchema, VisualDesignSpec, ValidationResult,
    // Level 3 Agentic Stack Types
    NarrativeTrail, RouterConstraints, GeneratorResult, DeckMetrics, GeneratorFailureReason,
    // System 2 Visual Critique
    VISUAL_THRESHOLDS,
    // Style Mode System
    StyleMode, StyleProfile, SlideArchetype, getStyleProfile, getVisualThresholdsForStyle,
    isLayoutAllowedForStyle, getBulletsMax, getTitleMaxChars,
    // Archetype inference and risk-based validation
    inferArchetype, shouldValidateSlide, ARCHETYPE_RISK, VisualThresholdsConfig
} from "../types/slideTypes";
import {
    createJsonInteraction,
    CostTracker
} from "./interactionsClient";
import { PROMPTS } from "./promptRegistry";
import { validateSlide, validateVisualLayoutAlignment, validateGeneratorCompliance, validateDeckCoherence, validateContentCompleteness, checkNoPlaceholderShippingGate } from "./validators";
import { runVisualDesigner } from "./visualDesignAgent";
import { SpatialLayoutEngine, createEnvironmentSnapshot } from "./spatialRenderer";
import { autoRepairSlide } from "./repair/autoRepair";
import { generateImageFromPrompt } from "./image/imageGeneration";
import { generateSvgProxy } from "./visual/svgProxy";
import { runResearcher } from "./agents/researcher";
import { runArchitect } from "./agents/architect";
import { runRouter } from "./agents/router";
import { runContentPlanner, ContentDensityHint, ContentPlanResult, StyleAwareContentHint } from "./agents/contentPlanner";
import { runQwenLayoutSelector } from "./agents/qwenLayoutSelector";
import {
    runCompositionArchitect,
    trackUsedSurprises,
    computeDetailedVariationBudget,
    applyStyleMultiplierToVariationBudget
} from "./agents/compositionArchitect";
import { CompositionPlan, SerendipityDNA } from "../types/serendipityTypes";
import { z } from "zod";

// --- FEATURE FLAGS ---
// Enable serendipity mode for high-variation slide generation
export const SERENDIPITY_MODE_ENABLED = true; // Layer-based composition with premium design

// Enable Director mode - uses orchestrator pattern with browser-based rendering
// When true, routes to DirectorAgent pipeline instead of legacy multi-agent pipeline
export const ENABLE_DIRECTOR_MODE = false; // Set to true to test new architecture

// Default style mode - can be overridden per-request
export const DEFAULT_STYLE_MODE: StyleMode = 'professional';

// --- CONSTANTS ---
// Model tiers imported from interactionsClient for consistency
// Based on Phil Schmid's agent best practices:
// - Agentic tasks: 3 Flash (78% SWE-bench, beats Pro at 76.2%)
// - Simple tasks: 2.5 Flash (classification, JSON structuring)
// - Reasoning: 3 Pro (reserved for >1M context, rarely needed)

import { MODEL_AGENTIC } from "./interactionsClient";

const MAX_AGENT_ITERATIONS = 10; // Global escape hatch per Phil Schmid's recommendation (reduced from 15 for faster convergence)

// --- AGENT DATA CONTRACT UTILITIES ---

/**
 * Creates a guaranteed-valid ContentPlanResult for use when actual planning fails
 * or when we need defensive defaults. This is the canonical fallback shape.
 */
function createSafeContentPlan(meta: any, source: string = 'defensive'): ContentPlanResult {
    return {
        title: meta?.title || 'Slide Content',
        keyPoints: [meta?.purpose || 'Key insight for this slide'],
        dataPoints: [],
        narrative: `Generated via ${source} fallback`
    };
}

/**
 * Validates and normalizes a content plan result, ensuring it matches the expected contract.
 * This is the SINGLE source of truth for content plan validation across all agents.
 */
function ensureValidContentPlan(plan: any, meta: any): ContentPlanResult {
    // Handle null/undefined
    if (!plan || typeof plan !== 'object') {
        console.warn('[ORCHESTRATOR] Content plan is null/undefined, using defensive fallback');
        return createSafeContentPlan(meta, 'null-guard');
    }

    // Validate keyPoints - the most critical field
    const hasValidKeyPoints = Array.isArray(plan.keyPoints) &&
        plan.keyPoints.length > 0 &&
        plan.keyPoints.some((kp: any) => typeof kp === 'string' && kp.trim().length > 0);

    if (!hasValidKeyPoints) {
        console.warn('[ORCHESTRATOR] Content plan has invalid keyPoints, using defensive fallback');
        return createSafeContentPlan(meta, 'keyPoints-guard');
    }

    // Return normalized plan with guaranteed shape
    return {
        title: typeof plan.title === 'string' && plan.title.trim()
            ? plan.title.trim()
            : (meta?.title || 'Slide Content'),
        keyPoints: plan.keyPoints
            .filter((kp: any) => typeof kp === 'string' && kp.trim().length > 0)
            .map((kp: string) => kp.trim()),
        dataPoints: Array.isArray(plan.dataPoints)
            ? plan.dataPoints.filter((dp: any) => dp && typeof dp === 'object' && dp.label)
            : [],
        narrative: typeof plan.narrative === 'string' ? plan.narrative : undefined,
        chartSpec: plan.chartSpec && typeof plan.chartSpec === 'object' && plan.chartSpec.type
            ? plan.chartSpec
            : undefined
    };
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const hashStringToUnit = (input: string): number => {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash) + input.charCodeAt(i);
        hash |= 0;
    }
    return clamp01((Math.abs(hash) % 1000) / 1000);
};

const computeVariationBudget = (
    slideIndex: number,
    totalSlides: number,
    slideType?: string,
    seed?: string
): number => {
    const isTitle = slideIndex === 0 || slideType === SLIDE_TYPES.TITLE;
    const isConclusion = slideIndex === totalSlides - 1 || slideType === SLIDE_TYPES.CONCLUSION;
    const base = isTitle || isConclusion ? 0.25 : 0.45;
    const drift = 0.15 * (slideIndex / Math.max(1, totalSlides - 1));
    const jitter = seed ? (hashStringToUnit(seed) - 0.5) * 0.2 : 0;
    return clamp01(base + drift + jitter);
};

const buildStyleHints = (
    styleGuide: GlobalStyleGuide | undefined,
    variationBudget: number
) => ({
    themeName: styleGuide?.themeName,
    colorPalette: styleGuide?.colorPalette,
    styleDNA: styleGuide?.styleDNA,
    variationBudget: clamp01(variationBudget)
});

// Deterministic visual focus enforcement for visual design spec
function enforceVisualFocusInSpec(
    spec: VisualDesignSpec | undefined,
    visualFocus?: string
): VisualDesignSpec | undefined {
    if (!spec || !visualFocus || visualFocus.trim().length === 0 || visualFocus === 'Content') {
        return spec;
    }

    const focus = visualFocus.trim();
    const focusTerms = focus.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    const prompt = spec.prompt_with_composition || '';
    const promptLower = prompt.toLowerCase();
    const elementsLower = (spec.foreground_elements || []).join(' ').toLowerCase();

    const mentionsFocus = focusTerms.some(term =>
        promptLower.includes(term) || elementsLower.includes(term)
    ) || promptLower.includes(focus.toLowerCase());

    if (mentionsFocus) return spec;

    const trimmed = prompt.trim();
    const suffix = ` Visual focus cues: ${focus}.`;
    const updatedPrompt = trimmed.length > 0
        ? `${trimmed}${trimmed.endsWith('.') ? '' : '.'}${suffix}`
        : `Visual focus cues: ${focus}.`;

    return {
        ...spec,
        prompt_with_composition: updatedPrompt,
        foreground_elements: Array.isArray(spec.foreground_elements)
            ? (spec.foreground_elements.some(el =>
                typeof el === 'string' && el.toLowerCase().includes(focus.toLowerCase())
            ) ? spec.foreground_elements : [...spec.foreground_elements, focus])
            : spec.foreground_elements
    };
}

// --- SPATIAL PREFLIGHT ADJUSTMENTS ---
// Reduce content density when spatial warnings indicate truncation or unplaced components.
const VARIANT_LIMITS: Record<string, {
    maxComponents: number;
    bullets: number;
    bulletChars: number;
    metrics: number;
    steps: number;
    icons: number;
}> = {
    'hero-centered': { maxComponents: 1, bullets: 1, bulletChars: 55, metrics: 2, steps: 1, icons: 2 },
    'split-left-text': { maxComponents: 2, bullets: 2, bulletChars: 60, metrics: 2, steps: 2, icons: 3 },
    'split-right-text': { maxComponents: 2, bullets: 2, bulletChars: 60, metrics: 2, steps: 2, icons: 3 },
    'standard-vertical': { maxComponents: 3, bullets: 3, bulletChars: 70, metrics: 3, steps: 3, icons: 4 },
    'asymmetric-grid': { maxComponents: 3, bullets: 3, bulletChars: 65, metrics: 3, steps: 3, icons: 4 },
    'bento-grid': { maxComponents: 3, bullets: 2, bulletChars: 55, metrics: 3, steps: 2, icons: 4 },
    'dashboard-tiles': { maxComponents: 3, bullets: 1, bulletChars: 50, metrics: 3, steps: 2, icons: 3 },
    'metrics-rail': { maxComponents: 2, bullets: 2, bulletChars: 60, metrics: 2, steps: 2, icons: 3 },
    'timeline-horizontal': { maxComponents: 1, bullets: 2, bulletChars: 55, metrics: 2, steps: 3, icons: 3 }
};

function trimText(input: string, max: number): string {
    if (!input || typeof input !== 'string') return input as any;
    if (input.length <= max) return input;
    return input.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function getBodyFontSize(styleGuide?: GlobalStyleGuide): number {
    const body = styleGuide?.themeTokens?.typography?.scale?.body;
    if (typeof body === 'number' && body > 6) return body;
    return 14;
}

function isMonospaceFont(fontFamily?: string): boolean {
    if (!fontFamily) return false;
    return /mono|code|courier|consolas|fira.*code|source.*code/i.test(fontFamily);
}

function computeDynamicBulletCharCap(
    baseCap: number,
    bulletCount: number,
    styleGuide?: GlobalStyleGuide
): number {
    const fontSize = getBodyFontSize(styleGuide);
    const fontFamily = styleGuide?.fontFamilyBody;

    // Font-aware adjustment: monospace fonts are ~30% wider per character
    const monospacePenalty = isMonospaceFont(fontFamily) ? 0.7 : 1.0;

    const fontAdjusted = Math.round(baseCap * (14 / fontSize) * monospacePenalty);
    const countAdjusted = bulletCount >= 3 ? Math.round(fontAdjusted * 0.9) : fontAdjusted;
    return Math.max(30, Math.min(countAdjusted, 100)); // Tighter limits for safety
}

function applySpatialPreflightAdjustments(
    slide: SlideNode,
    styleGuide: GlobalStyleGuide
): { slide: SlideNode; adjustments: string[] } {
    const updatedSlide: SlideNode = JSON.parse(JSON.stringify(slide));
    const adjustments: string[] = [];

    // Render once to populate spatial warnings
    const renderer = new SpatialLayoutEngine();
    renderer.renderWithSpatialAwareness(
        updatedSlide,
        styleGuide,
        () => undefined,
        updatedSlide.visualDesignSpec
    );

    const warnings = updatedSlide.warnings || [];
    const hasTruncation = warnings.some(w => /truncated|hidden|title dropped/i.test(String(w)));
    const hasUnplaced = warnings.some(w => /unplaced component/i.test(String(w)));

    if (!hasTruncation && !hasUnplaced) {
        return { slide: updatedSlide, adjustments };
    }

    const variant = updatedSlide.routerConfig?.layoutVariant || 'standard-vertical';
    const limits = VARIANT_LIMITS[variant] || VARIANT_LIMITS['standard-vertical'];
    const tightenedBulletLimit = hasTruncation ? Math.max(1, limits.bullets - 1) : limits.bullets;

    const components = updatedSlide.layoutPlan?.components || [];
    const baseBulletCharCap = computeDynamicBulletCharCap(limits.bulletChars, 2, styleGuide);
    const tightenedBulletCharsForDescriptions = hasTruncation
        ? Math.max(40, Math.round(baseBulletCharCap * 0.9))
        : baseBulletCharCap;

    components.forEach((c: any) => {
        if (c.type === 'text-bullets') {
            if (Array.isArray(c.content)) {
                const before = c.content.length;
                const bulletCharCap = computeDynamicBulletCharCap(
                    limits.bulletChars,
                    c.content.length,
                    styleGuide
                );
                const tightenedBulletChars = hasTruncation
                    ? Math.max(40, Math.round(bulletCharCap * 0.9))
                    : bulletCharCap;
                c.content = c.content
                    .slice(0, tightenedBulletLimit)
                    .map((t: string) => trimText(String(t), tightenedBulletChars));
                if (before !== c.content.length) adjustments.push('reduced bullets');
            }
            if (c.title) c.title = trimText(String(c.title), 50);
        }
        if (c.type === 'metric-cards' && Array.isArray(c.metrics)) {
            const before = c.metrics.length;
            c.metrics = c.metrics.slice(0, limits.metrics);
            if (before !== c.metrics.length) adjustments.push('reduced metrics');
        }
        if (c.type === 'process-flow' && Array.isArray(c.steps)) {
            const before = c.steps.length;
            c.steps = c.steps.slice(0, limits.steps).map((s: any) => ({
                ...s,
                title: s.title ? trimText(String(s.title), 18) : s.title,
                description: s.description ? trimText(String(s.description), tightenedBulletCharsForDescriptions) : s.description
            }));
            if (before !== c.steps.length) adjustments.push('reduced steps');
        }
        if (c.type === 'icon-grid' && Array.isArray(c.items)) {
            const before = c.items.length;
            c.items = c.items.slice(0, limits.icons).map((it: any) => ({
                ...it,
                label: it.label ? trimText(String(it.label), 24) : it.label,
                description: it.description ? trimText(String(it.description), 60) : it.description
            }));
            if (before !== c.items.length) adjustments.push('reduced icons');
        }
    });

    if (hasUnplaced || components.length > limits.maxComponents) {
        const prefer = updatedSlide.type === 'data-viz'
            ? ['chart-frame', 'diagram-svg', 'text-bullets', 'metric-cards', 'process-flow', 'icon-grid']
            : ['diagram-svg', 'text-bullets', 'metric-cards', 'process-flow', 'chart-frame', 'icon-grid'];

        const ranked = components
            .map((c: any, idx: number) => ({ c, idx, rank: prefer.indexOf(c.type) >= 0 ? prefer.indexOf(c.type) : prefer.length }))
            .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
            .slice(0, limits.maxComponents)
            .map(r => r.c);

        if (ranked.length < components.length) {
            updatedSlide.layoutPlan.components = ranked;
            adjustments.push('reduced components');
        }
    }

    const spatialWarningRegex = /truncated|hidden|title dropped|unplaced component|diagram placeholder used/i;
    const existingWarnings = updatedSlide.warnings || [];
    updatedSlide.warnings = existingWarnings.filter(w => !spatialWarningRegex.test(String(w)));

    const repaired = autoRepairSlide(updatedSlide, styleGuide);
    const rerender = new SpatialLayoutEngine();
    rerender.renderWithSpatialAwareness(
        repaired,
        styleGuide,
        () => undefined,
        repaired.visualDesignSpec
    );

    return { slide: repaired, adjustments };
}

// --- SYSTEM 2: RECURSIVE VISUAL CRITIQUE ---

/**
 * Runs recursive visual critique loop on a slide candidate.
 * Implements bounded recursion (MAX_ROUNDS=3) with score-based convergence.
 *
 * TWO-TIER VISUAL CRITIQUE APPROACH:
 *
 * Default (Fast Path):
 * - SVG proxy → PNG (resvg-js) → Qwen-VL critique
 * - Deterministic, no Chromium dependency
 * - ~200-500ms per critique
 * - Best for iterative refinement in System 2 loop
 * - Render fidelity: "svg-proxy"
 *
 * Escalation (Slow Path - Future):
 * - PPTX export → LibreOffice render → PDF → PNG → Qwen-VL
 * - Validates actual PPTX rendering (text wrapping, fonts, etc.)
 * - ~2-5s per critique
 * - Use for persistent issues or final quality gate
 * - Render fidelity: "pptx-render"
 *
 * @param candidate - Slide to critique
 * @param validation - Initial validation result
 * @param costTracker - Cost tracking
 * @param styleGuide - Global style guide for SVG rendering
 * @param styleMode - Style mode for style-aware thresholds and rubrics
 * @returns Enhanced result with rounds, finalScore, repairSucceeded
 */
async function runRecursiveVisualCritique(
    candidate: SlideNode,
    validation: ValidationResult,
    costTracker: CostTracker,
    styleGuide: GlobalStyleGuide,
    styleMode?: StyleMode
): Promise<{
    slide: SlideNode;
    rounds: number;
    finalScore: number;
    repairSucceeded: boolean;
    system2Cost: number;
    system2InputTokens: number;
    system2OutputTokens: number;
}> {
    const MAX_VISUAL_ROUNDS = 3;
    const MIN_IMPROVEMENT_DELTA = 5; // Require meaningful improvement

    // Get style-aware thresholds
    const styleProfile = getStyleProfile(styleMode);
    const thresholds = getVisualThresholdsForStyle(styleProfile);
    console.log(`[SYSTEM 2] Using style-aware thresholds: TARGET=${thresholds.TARGET}, REPAIR_REQUIRED=${thresholds.REPAIR_REQUIRED} (style=${styleMode || 'default'})`);

    // Capture cost before System 2 operations
    const preSystem2Summary = costTracker.getSummary();
    const preSystem2Cost = preSystem2Summary.totalCost;
    const preSystem2InputTokens = preSystem2Summary.totalInputTokens;
    const preSystem2OutputTokens = preSystem2Summary.totalOutputTokens;

    // Import visual cortex functions (including style-aware critique)
    const { runVisualCritique, runLayoutRepair } = await import('./visualDesignAgent');
    const { getStyleAwareCritiqueFromSvg, isQwenVLAvailable } = await import('./visualCortex');

    let currentSlide = candidate;
    let currentValidation = validation;
    let round = 0;
    let repairSucceeded = false;

    // GAP 9: Issue Persistence Tracking
    // Track issue categories across rounds to detect unfixable issues
    const issueHistory = new Map<string, number>(); // category -> count

    while (round < MAX_VISUAL_ROUNDS && currentValidation.score < thresholds.TARGET) {
        round++;
        console.log(`[SYSTEM 2] Visual critique round ${round}/${MAX_VISUAL_ROUNDS} (score: ${currentValidation.score}, target: ${thresholds.TARGET})...`);

        try {
            // Generate SVG proxy from current slide state
            const svgProxy = generateSvgProxy(currentSlide, styleGuide);

            // --- QWEN-VL STYLE-AWARE VISUAL CRITIQUE (External Visual Cortex) ---
            // Fast Path: SVG proxy → PNG (resvg) → Qwen-VL with style rubric
            // This provides real bounding box detection and spatial analysis
            let externalCritique: any = null;
            if (isQwenVLAvailable()) {
                try {
                    console.log(`[SYSTEM 2] Qwen-VL style-aware visual critique (style=${styleMode || 'professional'})...`);

                    // Use style-aware critique with appropriate rubric
                    externalCritique = await getStyleAwareCritiqueFromSvg(
                        svgProxy,
                        styleMode || 'professional',
                        costTracker
                    );

                    if (externalCritique) {
                        console.log(`[SYSTEM 2] Qwen-VL critique: score=${externalCritique.overall_score}, verdict=${externalCritique.overall_verdict}, passesStyleGate=${externalCritique.passesStyleGate}`);
                        console.log(`[SYSTEM 2] Issues: ${externalCritique.issues.length}, Empty regions: ${externalCritique.empty_regions.length}`);

                        // Log render fidelity and style mode
                        console.log(`[SYSTEM 2] Render fidelity: ${externalCritique.renderFidelity}, style rubric: ${styleMode || 'professional'}`);

                        // Map Qwen-VL critique to internal format
                        // For now, we use external critique as supplementary validation
                        // Future: Could replace or merge with internal critique based on score agreement
                        if (externalCritique.overall_verdict === 'requires_repair') {
                            console.warn(`[SYSTEM 2] Qwen-VL flagged for repair - external validation confirms spatial issues`);
                        }
                    }
                } catch (qwenErr: any) {
                    console.error(`[SYSTEM 2] Qwen-VL critique failed:`, qwenErr.message);
                    // Fall through to internal critique
                }
            } else {
                console.log('[SYSTEM 2] Qwen-VL critique skipped (missing proxy/key or Node rasterizer).');
            }

            // Run internal visual critique (always run as fallback)
            const critique = await runVisualCritique(currentSlide, svgProxy, costTracker);

            // Merge Qwen-VL issues to guide repair (richer than binary verdict)
            const mapQwenCategory = (cat: string) => {
                switch (cat) {
                    case 'text_overlap':
                        return 'overlap';
                    case 'contrast':
                        return 'contrast';
                    case 'alignment':
                        return 'alignment';
                    case 'density':
                        return 'density';
                    case 'spacing':
                        return 'density';
                    default:
                        return 'density';
                }
            };

            const mappedExternalIssues = (externalCritique?.issues || []).map((issue: any) => ({
                severity: issue.severity === 'critical' ? 'critical' : issue.severity === 'warning' ? 'major' : 'minor',
                category: mapQwenCategory(issue.category),
                zone: issue.location ? `x:${issue.location.x.toFixed(2)},y:${issue.location.y.toFixed(2)}` : undefined,
                description: issue.description || 'External visual issue detected',
                suggestedFix: issue.suggested_fix || 'Adjust spacing or move content'
            }));

            const emptyRegionHints = (externalCritique?.empty_regions || [])
                .filter((r: any) => r.label === 'safe_for_text')
                .slice(0, 2)
                .map((r: any) => ({
                    severity: 'minor',
                    category: 'density',
                    zone: `empty_region x:${r.bbox.x.toFixed(2)},y:${r.bbox.y.toFixed(2)},w:${r.bbox.w.toFixed(2)},h:${r.bbox.h.toFixed(2)}`,
                    description: 'Text-safe empty region detected by Qwen-VL',
                    suggestedFix: 'Relocate dense text into this region to reduce truncation/overlap'
                }));

            const mergedCritique = (mappedExternalIssues.length > 0 || emptyRegionHints.length > 0)
                ? {
                    ...critique,
                    issues: [...critique.issues, ...mappedExternalIssues, ...emptyRegionHints],
                    overallScore: externalCritique?.overall_score
                        ? Math.min(critique.overallScore, externalCritique.overall_score)
                        : critique.overallScore,
                    hasCriticalIssues: critique.hasCriticalIssues || mappedExternalIssues.some(i => i.severity === 'critical')
                }
                : critique;

            // Check if critique score meets style-aware target
            if (mergedCritique.overallScore >= thresholds.TARGET) {
                console.log(`[SYSTEM 2] Critique passed (score: ${mergedCritique.overallScore}, target: ${thresholds.TARGET}), exiting loop`);
                break;
            }

            // GAP 9: Track issue persistence
            mergedCritique.issues.forEach(issue => {
                const count = issueHistory.get(issue.category) || 0;
                issueHistory.set(issue.category, count + 1);
            });

            // Check for persistent issues (same category appears 2+ times)
            const persistentIssues = Array.from(issueHistory.entries())
                .filter(([_, count]) => count >= 2)
                .map(([category]) => category);

            if (persistentIssues.length > 0 && round >= 2) {
                console.warn(`[SYSTEM 2] Persistent issues detected after ${round} rounds: ${persistentIssues.join(', ')}`);
                console.warn(`[SYSTEM 2] These issues may be unfixable at current layout, exiting critique loop`);

                currentSlide.warnings = [
                    ...(currentSlide.warnings || []),
                    `Persistent visual issues after ${round} repair attempts: ${persistentIssues.join(', ')}`
                ];
                break;
            }

            // Determine if repair is needed based on style-aware thresholds
            const needsRepair = mergedCritique.hasCriticalIssues ||
                mergedCritique.overallScore < thresholds.REPAIR_REQUIRED ||
                externalCritique?.overall_verdict === 'requires_repair';

            if (needsRepair) {
                console.warn(`[SYSTEM 2] Repair needed (score: ${mergedCritique.overallScore}, critical: ${mergedCritique.hasCriticalIssues})`);

                // Run layout repair
                const repairedCandidate = await runLayoutRepair(
                    currentSlide,
                    mergedCritique,
                    svgProxy,
                    costTracker
                );

                // Track truncation-related issues
                mergedCritique.issues.forEach(issue => {
                    if (issue.category === 'text_truncation' || issue.category === 'overflow') {
                        const count = (issueHistory.get('truncation') || 0) + 1;
                        issueHistory.set('truncation', count);
                    }
                });

                // NEW: Circuit Breaker Logic - Re-route if truncation persists
                const truncationCount = issueHistory.get('truncation') || 0;
                if (truncationCount >= 2 && round >= 2) {
                    console.error(
                        `[SYSTEM 2] Truncation persists after ${round} repair rounds. ` +
                        `Triggering re-routing to accommodate text.`
                    );

                    // Define constraints: "No hero-centered, need bigger text zones"
                    const constraints: RouterConstraints = {
                        avoidLayoutVariants: [currentSlide.routerConfig?.layoutVariant || 'hero-centered'],
                        minTextHeight: 3.0, // Require at least 3.0 units for text zones
                        textDensityTarget: 0.65
                    };

                    // Re-route with constraints (pass styleMode for style-aware layout selection)
                    try {
                        const reroutedDecision = await runRouter(
                            {
                                title: currentSlide.title,
                                type: currentSlide.type, // Use correct type property
                                purpose: 'Fix persistent text truncation'
                            },
                            costTracker,
                            constraints,
                            styleMode  // Pass styleMode for style filtering
                        );

                        console.log(`[SYSTEM 2] Re-routed: ${currentSlide.routerConfig?.layoutVariant} → ${reroutedDecision.layoutVariant}`);

                        // Update slide with new layout decision
                        currentSlide.routerConfig = {
                            ...currentSlide.routerConfig,
                            layoutVariant: reroutedDecision.layoutVariant,
                            renderMode: reroutedDecision.renderMode
                        };

                        // Note: We need spatialRenderer instance here. 
                        // Assuming runRecursiveVisualCritique has access or we can import it.
                        // Actually, looking at the context, we are inside runRecursiveVisualCritique which is passed 'candidate'.
                        // We need to re-render. Ideally, we should restart the critique loop with the NEW layout.
                        // However, 'currentSlide' is mutable. 
                        // But wait! We don't have access to 'spatialRenderer' inside this function unless it is imported? 
                        // 'spatialRenderer' is usually instantiated or imported. 
                        // Let's check imports. 'VisualDesigner' agent usually returns layout. 
                        // 'spatialRenderer' is used in 'renderWithSpatialAwareness'.

                        // We need to trigger the renderer to apply the new layout (zones).
                        // The 'renderWithSpatialAwareness' function is in 'spatialRenderer.ts'. 
                        // We need to import the class 'SpatialLayoutEngine'.
                        // The file imports 'runVisualDesigner'.
                        // Let's assume we can just break the loop and let the caller handle it? 
                        // No, the instruction is to re-route HERE.
                        // The user provided code assumes we can re-render: 
                        // "const reroutedElements = spatialRenderer.renderWithSpatialAwareness(..."

                        // I need to instantiate the renderer locally if not available.
                        // import { SpatialLayoutEngine } from "./spatialRenderer";
                        // I should double check imports.

                        // For now, I will modify the loop to recognize the re-route.
                        // If I can't render here, I can't validate.
                        // The USER PROVIDED CODE assumes I can render.

                        // Let's check if 'SpatialLayoutEngine' is imported. Checking file top...
                        // It is NOT imported in the viewed lines.
                        // But I can't see the top of the file right now (viewed lines 1-800 in step 61, imports visible).
                        // Step 61 showed lines 1-40. Imports:
                        // import { ... } from "../types/slideTypes";
                        // ...
                        // It does NOT import SpatialLayoutEngine.
                        // I need to add the import if I use it.
                        // HOWEVER, I am editing the MIDDLE of the file. I can't add imports easily without another call.

                        // ALTERNATIVE: Break the loop and return a special status "NEEDS_REROUTE"?
                        // The function returns { slide, rounds, ... }.
                        // If I modify the slide's routerConfig, the caller (runGenerator) might not know to re-render 
                        // unless I force it. But runGenerator uses the result.slide.
                        // The result.slide is fully rendered? No, runGenerator returns the 'SlideNode'.
                        // The 'renderWithSpatialAwareness' happens in the FRONTEND, or is it used during validation?
                        // `validateSlide` calls `renderWithSpatialAwareness` internally? NO.
                        // `validateSlide` checks structure.

                        // Wait, `runRecursiveVisualCritique` calls `runVisualDesigner` (System 2 agent).
                        // Visual Designer returns a NEW layoutPlan.
                        // The re-route changes the layout VARIANT (e.g. from hero-centered to split-left).
                        // BUT the content needs to be re-allocated to the new zones.
                        // `SpatialLayoutEngine` does the allocation.
                        // If I just change `routerConfig`, `validateSlide` won't see the new allocation unless it runs the renderer.
                        // `validateSlide` usually works on the declarative structure.

                        // Let's look at `validateSlide` usage.
                        // It's imported.

                        // If I change routerConfig, I MUST re-run the layout allocation (renderer) so that `validateSlide`
                        // (if it checks zones) sees the new reality.
                        // BUT `validateSlide` typically checks `slide.layoutPlan.components`.
                        // The renderer (SpatialLayoutEngine) updates `validation`?
                        // Actually, in `runRecursiveVisualCritique` (which I am editing), 
                        // we normally call the LLM to "Move text to...", "Resize..."

                        // If I re-route, I am effectively bypassing the LLM repair and force-switching layout.
                        // I NEED to update the `layoutPlan` (components need to move to new zones?).
                        // SpatialLayoutEngine.allocateComponents DOES that mapping!
                        // So yes, I need `SpatialLayoutEngine`.

                        // Since I cannot add an import easily in this block replacement step,
                        // I will instantiate it if I can, or I should have added import first.
                        // BUT `SpatialLayoutEngine` is a class export from `./spatialRenderer`.
                        // I check imports again. Lines 39: `import { runVisualDesigner } from "./visualDesignAgent";`
                        // I don't see `spatialRenderer`.

                        // CRITICAL: The user provided code snippet calls `spatialRenderer.renderWithSpatialAwareness`.
                        // It assumes `spatialRenderer` exists.
                        // If it doesn't, this code will fail.
                        // I'll assume for a moment the user is right and maybe I missed the import or variable in scope.
                        // If not, I should add the import.

                        // Actually, let's look at `runRecursiveVisualCritique` signature. It's not fully visible.
                        // But I can see the `runGenerator` call.

                        // I'll take a safe bet: I'll try to use `new SpatialLayoutEngine()` but I need to import it.
                        // Or I can add the Logic that `runGenerator` handles "needsReroute".
                        // `runGenerator` has a block "Phase 3: Check for critical errors... return { needsReroute: true ... }"
                        // Maybe I should just RETURN specifically and let `runGenerator` re-route?
                        // `runRecursiveVisualCritique` returns `{ slide, rounds, ..., repairSucceeded }`.
                        // It doesn't seem to support returning "reroute needed".

                        // So I must do it inplace. 
                        // I will add the necessary import in a separate step if needed. 
                        // But I can't "Add import" and "Replace block" in one transaction easily unless I overwrite the whole file.

                        // Plan: I'll write the code assuming `SpatialLayoutEngine` is available or I can use dynamic import()?
                        // TypeScript dynamic import `const { SpatialLayoutEngine } = await import('./spatialRenderer');`
                        // That works!

                        const { SpatialLayoutEngine } = await import('./spatialRenderer');
                        const renderer = new SpatialLayoutEngine();

                        // Re-render
                        const reroutedElements = renderer.renderWithSpatialAwareness(
                            currentSlide,
                            styleGuide,
                            (name) => `icon://${name}`, // Mock icon URL getter
                            currentSlide.visualDesignSpec
                        );

                        // Re-validate
                        // Note: validateSlide might not check spatial/rendering warnings unless we add them to slide?
                        // renderer.renderWithSpatialAwareness updates slide.warnings!
                        currentValidation = validateSlide(currentSlide);
                        console.log(`[SYSTEM 2] Re-render validation: score=${currentValidation.score}`);

                        // Exit loop (use the re-routed slide)
                        repairSucceeded = true;
                        break;
                    } catch (rerouteErr: any) {
                        console.error(`[SYSTEM 2] Re-routing failed: ${rerouteErr.message}`);
                    }
                }

                // Apply deterministic repair normalization
                const normalizedRepair = autoRepairSlide(repairedCandidate, styleGuide);

                // ... (rest of the block)
                const repairedValidation = validateSlide(normalizedRepair);

                // ... (rest of logic)
                const improvement = repairedValidation.score - currentValidation.score;
                const meetsMinImprovement = improvement >= MIN_IMPROVEMENT_DELTA;
                const crossedThreshold = currentValidation.score < thresholds.REPAIR_REQUIRED &&
                    repairedValidation.score >= thresholds.REPAIR_REQUIRED;

                if (repairedValidation.passed &&
                    (meetsMinImprovement || crossedThreshold)) {
                    console.log(`[SYSTEM 2] Repair succeeded (${currentValidation.score} → ${repairedValidation.score}, Δ=${improvement})`);
                    currentSlide = normalizedRepair;
                    currentValidation = repairedValidation;
                    repairSucceeded = true;
                } else {
                    console.warn(`[SYSTEM 2] Repair did not improve slide (Δ=${improvement}), keeping original`);
                    // Keep current slide, exit loop
                    break;
                }
            } else {
                // Score between REPAIR_REQUIRED and TARGET - informational only
                console.log(`[SYSTEM 2] Critique identified ${critique.issues.length} issues but no repair needed`);
                currentSlide.warnings = [
                    ...(currentSlide.warnings || []),
                    `Visual critique: ${critique.issues.length} issues (score: ${critique.overallScore})`
                ];
                break;
            }

        } catch (critiqueErr: any) {
            console.error(`[SYSTEM 2] Round ${round} error:`, critiqueErr.message);
            currentSlide.warnings = [
                ...(currentSlide.warnings || []),
                `Visual critique round ${round} failed: ${critiqueErr.message}`
            ];
            // Continue to next round or exit
            if (round >= MAX_VISUAL_ROUNDS) break;
        }
    }

    // Final summary
    if (round >= MAX_VISUAL_ROUNDS && currentValidation.score < thresholds.TARGET) {
        console.warn(`[SYSTEM 2] Max rounds reached (${MAX_VISUAL_ROUNDS}), final score: ${currentValidation.score} (target: ${thresholds.TARGET})`);
    } else if (currentValidation.score >= thresholds.TARGET) {
        console.log(`[SYSTEM 2] Converged to style-aware target score (${currentValidation.score} >= ${thresholds.TARGET})`);
    }

    // --- PHASE 2: ENVIRONMENT STATE SNAPSHOT ---
    // Capture the final rendered state (Visual Elements + Spatial Zones) for context folding.
    try {
        const { SpatialLayoutEngine } = await import('./spatialRenderer');
        const renderer = new SpatialLayoutEngine();

        // Render final elements
        const elements = renderer.renderWithSpatialAwareness(
            currentSlide,
            styleGuide,
            (name) => `icon://${name}`, // Mock icon URL
            currentSlide.visualDesignSpec
        );

        // Get spatial zones
        const zones = renderer.getZonesForVariant(currentSlide.routerConfig?.layoutVariant || 'standard-vertical');

        currentSlide.environmentSnapshot = {
            elements,
            zones
        };
        console.log(`[SYSTEM 2] Environment snapshot captured: ${elements.length} elements, ${zones.length} zones`);

    } catch (snapshotErr: any) {
        console.warn(`[SYSTEM 2] Failed to capture environment snapshot: ${snapshotErr.message}`);
    }

    // Calculate System 2 cost impact
    const postSystem2Summary = costTracker.getSummary();
    const system2Cost = postSystem2Summary.totalCost - preSystem2Cost;
    const system2InputTokens = postSystem2Summary.totalInputTokens - preSystem2InputTokens;
    const system2OutputTokens = postSystem2Summary.totalOutputTokens - preSystem2OutputTokens;

    console.log(`[SYSTEM 2] Cost: $${system2Cost.toFixed(4)} (${system2InputTokens} in, ${system2OutputTokens} out)`);

    return {
        slide: currentSlide,
        rounds: round,
        finalScore: currentValidation.score,
        repairSucceeded,
        system2Cost,
        system2InputTokens,
        system2OutputTokens
    };
}

// --- AGENT 5: GENERATOR (Phase 1+3: Context Folding + Circuit Breaker) ---

/**
 * Generator with Self-Healing Circuit Breaker
 * Returns GeneratorResult with needsReroute flag for reliability-targeted self-healing.
 *
 * @param meta - Slide metadata
 * @param routerConfig - Router decision (layout, density, etc.)
 * @param contentPlan - Content plan from planner (should be validated ContentPlanResult)
 * @param visualDesignSpec - Visual design spec (optional)
 * @param facts - Research facts
 * @param factClusters - Fact clusters from architect
 * @param styleGuide - Global style guide for visual rendering
 * @param costTracker - Cost tracking
 * @param recentHistory - Phase 1: Recent narrative history for context folding
 */
async function runGenerator(
    meta: any,
    routerConfig: RouterDecision,
    contentPlan: ContentPlanResult | any, // Accept typed or untyped for backwards compatibility
    visualDesignSpec: VisualDesignSpec | undefined,
    facts: ResearchFact[],
    factClusters: z.infer<typeof FactClusterSchema>[],
    styleGuide: GlobalStyleGuide,
    costTracker: CostTracker,
    recentHistory?: NarrativeTrail[],
    progress?: {
        onProgress: (status: string, percent?: number) => void;
        slideIndex?: number;
        totalSlides?: number;
        styleMode?: StyleMode; // NEW: StyleMode for style-aware generation
    }
): Promise<GeneratorResult> {
    console.log(`[GENERATOR] Generating slide: "${meta.title}"...`);
    if (recentHistory?.length) {
        console.log(`[GENERATOR] Narrative context: ${recentHistory.length} previous slides`);
    }

    // BALANCED SCHEMA: Type is enforced, internals are loosened for autoRepairSlide to normalize
    // ULTRA-MINIMAL SCHEMA: Reduced to absolute minimum to avoid FST constraint errors
    // FST constraint limit is 5888 - previous schema was 17493 (3x over limit)
    // Solution: Remove all nested property definitions, rely on prompt for structure
    const minimalGeneratorSchema = {
        type: "object",
        properties: {
            layoutPlan: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    background: { type: "string" }, // Removed enum to reduce FST height
                    components: {
                        type: "array",
                        maxItems: 3,
                        items: {
                            type: "object",
                            properties: {
                                type: { type: "string" }
                            },
                            required: ["type"]
                        }
                    }
                },
                required: ["title", "components"]
            },
            // Removed speakerNotesLines - generated automatically in autoRepairSlide
            // Removed selfCritique - not critical for generation, added by autoRepairSlide
        },
        required: ["layoutPlan"]
    };

    const MAX_RETRIES = 2;
    let lastValidation: any = null;
    let generatorFailures = 0;

    // CRITICAL: Ensure contentPlan has valid shape before processing
    // The caller should already pass validated ContentPlanResult, but we guard defensively
    const safeContentPlan: ContentPlanResult = (contentPlan && typeof contentPlan === 'object' && Array.isArray(contentPlan.keyPoints))
        ? {
            title: String(contentPlan.title || meta?.title || 'Slide'),
            keyPoints: contentPlan.keyPoints.filter((kp: any) => typeof kp === 'string' && kp.trim()),
            dataPoints: Array.isArray(contentPlan.dataPoints) ? contentPlan.dataPoints : [],
            narrative: contentPlan.narrative,
            chartSpec: contentPlan.chartSpec
        }
        : createSafeContentPlan(meta, 'generator-guard');

    // AGGRESSIVE PRE-TRUNCATION: Limit contentPlan size before prompt construction
    // Reduced limits to prevent token exhaustion causing "o0o0o0" degeneration
    if (safeContentPlan.keyPoints.length > 4) {
        console.warn(`[GENERATOR] Truncating keyPoints from ${safeContentPlan.keyPoints.length} to 4`);
        safeContentPlan.keyPoints = safeContentPlan.keyPoints.slice(0, 4);
    }
    if (safeContentPlan.dataPoints.length > 3) {
        console.warn(`[GENERATOR] Truncating dataPoints from ${safeContentPlan.dataPoints.length} to 3`);
        safeContentPlan.dataPoints = safeContentPlan.dataPoints.slice(0, 3);
    }
    // Truncate individual key points if too long (prevent verbose LLM inputs)
    safeContentPlan.keyPoints = safeContentPlan.keyPoints.map((kp: string) =>
        kp.length > 150 ? kp.slice(0, 147) + '...' : kp
    );

    // Apply deterministic visual focus enforcement early to avoid repeated validation loops
    const enforcedVisualDesignSpec = enforceVisualFocusInSpec(visualDesignSpec, routerConfig.visualFocus);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const isRecoveryAttempt = attempt > 0;

            // TOKEN BUDGET: Reduced from 5120/7168 to prevent bloat
            // Schema maxItems constraints enforce brevity (max 3 components, max 5 items per array)
            // NOTE: We do NOT escalate to MODEL_REASONING (Pro) because:
            // - Pro uses reasoning tokens that reduce output budget
            // - Flash is faster, cheaper, and equally capable for JSON generation
            const maxTokens = isRecoveryAttempt ? 4096 : 3072;

            // ULTRA-COMPACT component examples - minimize prompt tokens to maximize output budget
            // Layout-specific component requirements
            const layoutVariant = routerConfig.layoutVariant;
            const minComponents = ['split-left-text', 'split-right-text'].includes(layoutVariant) ? 2 : 1;
            const maxComponents = ['bento-grid'].includes(layoutVariant) ? 3 : 2;

            // CRITICAL FIX: Pre-check if we have valid dataPoints for metric-cards
            // If not, steer away from metric-cards in examples to prevent empty arrays
            const hasValidDataPoints = safeContentPlan.dataPoints && safeContentPlan.dataPoints.length >= 2;

            // SCHEMA GUIDANCE: Since schema is now ultra-minimal, provide explicit JSON examples
            // CRITICAL: metric-cards example MUST show full array structure with 2+ items
            // The model outputs empty metrics:[] because the minimal schema doesn't define inner structure
            const metricExample = hasValidDataPoints
                ? `metric-cards: {"type":"metric-cards","metrics":[{"value":"${safeContentPlan.dataPoints[0]?.value || '42M'}","label":"${safeContentPlan.dataPoints[0]?.label || 'Metric'}","icon":"TrendingUp"},{"value":"${safeContentPlan.dataPoints[1]?.value || '85%'}","label":"${safeContentPlan.dataPoints[1]?.label || 'Growth'}","icon":"Activity"}]}`
                : `text-bullets: {"type":"text-bullets","title":"Key Insights","content":["First insight","Second insight"]}  // (use text-bullets when no dataPoints)`;

            const componentExamples = `COMPONENT EXAMPLES (${minComponents}-${maxComponents} for ${layoutVariant}):
text-bullets: {"type":"text-bullets","title":"Title","content":["Line 1","Line 2"]}
${metricExample}
process-flow: {"type":"process-flow","steps":[{"title":"Step 1","description":"Details","icon":"ArrowRight"}]}
icon-grid: {"type":"icon-grid","items":[{"label":"Feature","icon":"Activity"}]}
chart-frame: {"type":"chart-frame","title":"Chart","chartType":"bar","data":[{"label":"Q1","value":100}]}

CRITICAL: If using metric-cards, the metrics array MUST have 2-3 items with value, label, and icon. Empty metrics:[] will fail validation.`;

            // CONTEXT COMPRESSION: Only pass essential fields to prevent "constraint too tall" errors
            // Problem: Full routerConfig + visualDesignSpec can exceed Gemini's FST constraint (5888 height)
            // Solution: Extract only the fields needed for generation
            const compressedRouterConfig = {
                layoutVariant: routerConfig.layoutVariant,
                visualFocus: routerConfig.visualFocus,
                renderMode: routerConfig.renderMode,
                densityBudget: {
                    maxChars: routerConfig.densityBudget?.maxChars || 400,
                    maxItems: routerConfig.densityBudget?.maxItems || 5
                    // Omit minVisuals and forbiddenPatterns arrays
                }
            };

            const compressedVisualSpec = enforcedVisualDesignSpec ? {
                color_harmony: enforcedVisualDesignSpec.color_harmony,
                background_treatment: enforcedVisualDesignSpec.background_treatment,
                negative_space_allocation: enforcedVisualDesignSpec.negative_space_allocation
                // Omit spatial_strategy (verbose zones), prompt_with_composition, foreground_elements
            } : undefined;

            // Truncate recentHistory to 50 chars per mainPoint (was 100)
            const compressedHistory = recentHistory?.slice(-3).map(h => ({
                title: h.title,
                mainPoint: h.mainPoint.substring(0, 50)
            }));

            const totalSlidesForBudget = progress?.totalSlides || (meta?.totalSlides as number) || 10;
            const slideIndexForBudget = progress?.slideIndex ?? (meta.order ? meta.order - 1 : 0);
            const variationBudget = computeVariationBudget(slideIndexForBudget, totalSlidesForBudget, meta.type, meta.title);
            const styleHints = buildStyleHints(styleGuide, variationBudget);

            let basePrompt: string;
            if (isRecoveryAttempt && lastValidation?.errors) {
                // Compact repair prompt
                const errorSummary = lastValidation.errors.slice(0, 2).map((e: any) => e.message).join('; ');
                const visualFocusHint = routerConfig.visualFocus && routerConfig.visualFocus !== 'Content'
                    ? `\nVISUAL FOCUS: Include the theme "${routerConfig.visualFocus}" in component text.`
                    : '';
                basePrompt = `Fix these errors: ${errorSummary}${visualFocusHint}\n\nContent: ${JSON.stringify(safeContentPlan)}`;
            } else {
                basePrompt = PROMPTS.VISUAL_DESIGNER.TASK(
                    JSON.stringify(safeContentPlan),
                    compressedRouterConfig,
                    compressedVisualSpec,
                    compressedHistory,
                    styleHints
                );
            }

            // PROMPT BUDGETING: Hard circuit breaker for prompt length
            // Prevent constraint violations by progressively shedding context
            const MAX_PROMPT_CHARS = 12000;
            let prompt = `${basePrompt}\n\n${componentExamples}`;

            if (prompt.length > MAX_PROMPT_CHARS) {
                console.warn(`[GENERATOR] Prompt too long (${prompt.length} chars), dropping component examples...`);
                // Tier 1: Drop examples
                prompt = basePrompt;
            }

            if (prompt.length > MAX_PROMPT_CHARS) {
                console.warn(`[GENERATOR] Prompt still too long (${prompt.length} chars), dropping visual spec...`);
                // Tier 2: Drop visual spec entirely
                basePrompt = PROMPTS.VISUAL_DESIGNER.TASK(
                    JSON.stringify(safeContentPlan),
                    compressedRouterConfig,
                    undefined, // Drop visual spec
                    compressedHistory,
                    styleHints
                );
                prompt = basePrompt;
            }

            if (prompt.length > MAX_PROMPT_CHARS) {
                console.warn(`[GENERATOR] Prompt still too long (${prompt.length} chars), using minimal router config...`);
                // Tier 3: Replace router config with minimal hints only
                const ultraRouter = {
                    layoutVariant: routerConfig.layoutVariant,
                    densityBudget: compressedRouterConfig.densityBudget
                };
                basePrompt = PROMPTS.VISUAL_DESIGNER.TASK(
                    JSON.stringify(safeContentPlan),
                    ultraRouter,
                    undefined,
                    compressedHistory,
                    styleHints
                );
                prompt = basePrompt;
            }



            // Always use MODEL_AGENTIC (Flash) - it's faster and doesn't truncate
            const raw = await createJsonInteraction(
                MODEL_AGENTIC,  // ALWAYS Flash - never escalate to Pro
                prompt,
                minimalGeneratorSchema,
                {
                    systemInstruction: PROMPTS.VISUAL_DESIGNER.ROLE,
                    temperature: isRecoveryAttempt ? 0.0 : 0.1,
                    maxOutputTokens: maxTokens
                },
                costTracker
            );

            if (!raw || !raw.layoutPlan) {
                throw new Error("Invalid generator output: missing layoutPlan");
            }

            let candidate: SlideNode = {
                order: meta.order || 0,
                type: meta.type as any,
                title: raw.layoutPlan?.title || meta.title,
                purpose: meta.purpose,
                routerConfig,
                layoutPlan: raw.layoutPlan,
                visualReasoning: "Generated via Interactions API",
                visualPrompt: "",
                visualDesignSpec: enforcedVisualDesignSpec,
                speakerNotesLines: raw.speakerNotesLines || [],
                citations: [],
                chartSpec: raw.chartSpec,
                selfCritique: raw.selfCritique,
                readabilityCheck: 'pass',
                validation: undefined,
                warnings: []
            };

            // Use safeContentPlan (not raw contentPlan) for guaranteed-valid keyPoints
            if (Array.isArray(safeContentPlan.keyPoints) && safeContentPlan.keyPoints.length > 0) {
                candidate.content = safeContentPlan.keyPoints;
            }

            // Auto-add chart frame if needed
            if (candidate.type === 'data-viz' && candidate.chartSpec && candidate.layoutPlan?.components) {
                const hasFrame = candidate.layoutPlan.components.some((c: any) => c.type === 'chart-frame');
                if (!hasFrame) {
                    candidate.layoutPlan.components.push({
                        type: 'chart-frame',
                        title: candidate.chartSpec.title || "Data Analysis",
                        chartType: (['bar', 'pie', 'doughnut', 'line'].includes(candidate.chartSpec.type) ? candidate.chartSpec.type : 'bar') as any,
                        data: candidate.chartSpec.data
                    });
                }
            }

            candidate = autoRepairSlide(candidate, styleGuide);
            const preflight = applySpatialPreflightAdjustments(candidate, styleGuide);
            candidate = preflight.slide;
            if (preflight.adjustments.length > 0) {
                candidate.warnings = [
                    ...(candidate.warnings || []),
                    `Preflight adjustments: ${Array.from(new Set(preflight.adjustments)).join(', ')}`
                ];
            }

            const preflightWarnings = candidate.warnings || [];
            const preflightNeedsLayout = preflightWarnings.some(w => /truncated|hidden|title dropped|unplaced component/i.test(String(w)));
            if (preflightNeedsLayout && attempt === MAX_RETRIES) {
                try {
                    const suggestedRouter = await runQwenLayoutSelector(
                        meta,
                        safeContentPlan,
                        candidate.routerConfig,
                        styleGuide,
                        costTracker,
                        undefined,
                        candidate.layoutPlan?.components
                    );

                    if (suggestedRouter.layoutVariant !== candidate.routerConfig.layoutVariant) {
                        candidate.routerConfig = {
                            ...candidate.routerConfig,
                            layoutVariant: suggestedRouter.layoutVariant,
                            layoutIntent: suggestedRouter.layoutIntent
                        };
                        candidate.warnings = [
                            ...(candidate.warnings || []),
                            `Layout adjusted by Qwen selector: ${suggestedRouter.layoutVariant}`
                        ];

                        const rerender = new SpatialLayoutEngine();
                        rerender.renderWithSpatialAwareness(
                            candidate,
                            styleGuide,
                            () => undefined,
                            candidate.visualDesignSpec
                        );
                    }
                } catch (layoutErr: any) {
                    console.warn(`[GENERATOR] Qwen layout selector failed during preflight: ${layoutErr.message}`);
                }
            }
            const validation = validateSlide(candidate);

            // GAP 1: Content-Intent Alignment Validation
            // Validate that Generator honored Router's decisions
            const complianceValidation = validateGeneratorCompliance(candidate, candidate.routerConfig);
            if (!complianceValidation.passed || complianceValidation.errors.length > 0) {
                validation.errors.push(...complianceValidation.errors);
                validation.score = Math.min(validation.score, complianceValidation.score);
                if (!complianceValidation.passed) {
                    validation.passed = false;
                    console.warn(`[GENERATOR] Compliance validation failed (score: ${complianceValidation.score}):`,
                        complianceValidation.errors.map(e => e.code).join(', '));
                }
            }

            // Merge Visual Alignment Validation
            if (enforcedVisualDesignSpec) {
                const alignment = validateVisualLayoutAlignment(enforcedVisualDesignSpec, candidate.routerConfig, candidate.layoutPlan);
                if (!alignment.passed || alignment.errors.length > 0) {
                    validation.errors.push(...alignment.errors);
                    validation.score = Math.min(validation.score, alignment.score);
                    // If visual alignment fails critically, should we fail the slide?
                    // For now, we treated it as soft warnings in visual agent, but here let's valid it formally.
                    if (!alignment.passed) validation.passed = false;
                }
            }

            // CONTENT COMPLETENESS VALIDATION
            // Ensures slides have substantive content, not just valid JSON structure
            // This caps QA score even if structural validation passes
            const contentCompleteness = validateContentCompleteness(candidate);
            if (!contentCompleteness.passed || contentCompleteness.score < 100) {
                // Add content issues as validation errors
                const contentErrors = contentCompleteness.issues.map(issue => ({
                    code: issue.code,
                    message: issue.message,
                    suggestedFix: issue.severity === 'critical' ? 'Add substantive content or remove placeholder' : undefined
                }));
                validation.errors.push(...contentErrors);
                
                // Cap score based on content completeness (cannot exceed content score)
                validation.score = Math.min(validation.score, contentCompleteness.score);
                
                // Critical content issues should fail the slide
                if (!contentCompleteness.passed) {
                    validation.passed = false;
                    console.warn(`[GENERATOR] Content completeness failed (score: ${contentCompleteness.score}):`,
                        contentCompleteness.issues.filter(i => i.severity === 'critical').map(i => i.code).join(', '));
                }
            }

            if (validation.errors.length > 0) {
                const validationWarnings = validation.errors.map(e => `Validation: ${e.code} - ${e.message}`);
                candidate.warnings = [...(candidate.warnings || []), ...validationWarnings];
            }

            lastValidation = validation;

            // ============================================================================
            // GATE ORDERING FOR COST CONTROL (Critical Change)
            // ============================================================================
            // Order of gates (cheap → expensive):
            // 1. Content completeness (CHEAP) - if failing, skip VL entirely; regenerate/prune/summarize
            // 2. Fast layout score (CHEAP-ish) - only if content passes
            // 3. Full critique/repairs (EXPENSIVE) - only for slides that pass content AND still fail fit/score
            //
            // This prevents wasting VL tokens on slides with incomplete/placeholder content.
            // ============================================================================

            // --- VISUAL ARCHITECT: QWEN-VL3 VISION-FIRST CRITIQUE LOOP (DEFAULT) ---
            // Run Vision Architect if validation passed but score < TARGET threshold
            // OR if spatial warnings indicate layout issues (unplaced/truncation)
            // This uses Qwen-VL to see actual SVG renders and apply structured repairs
            const VISUAL_REPAIR_ENABLED = true;

            let visualCritiqueRan = false;
            let visualRepairAttempted = false;
            let visualRepairSucceeded = false;
            let system2Rounds = 0;
            let system2Cost = 0;
            let system2InputTokens = 0;
            let system2OutputTokens = 0;

            // GATE 1: CONTENT COMPLETENESS (CHEAP - no API calls)
            // If content is fundamentally incomplete, VL cannot help - skip to save cost
            const contentIsShippable = contentCompleteness.passed && contentCompleteness.score >= 50;
            if (!contentIsShippable) {
                console.log(`[GENERATOR] Skipping Visual Architect: content incomplete (score: ${contentCompleteness.score}). VL cannot fix missing content.`);
            }

            let hasSpatialWarnings = false;
            try {
                const spatialProbe = JSON.parse(JSON.stringify(candidate)) as SlideNode;
                const probeRenderer = new SpatialLayoutEngine();
                probeRenderer.renderWithSpatialAwareness(
                    spatialProbe,
                    styleGuide,
                    () => undefined,
                    spatialProbe.visualDesignSpec
                );
                const probeWarnings = spatialProbe.warnings || [];
                hasSpatialWarnings = probeWarnings.some(w => /unplaced component|truncated|hidden|title dropped|diagram placeholder used/i.test(String(w)));
            } catch (probeErr: any) {
                console.warn(`[GENERATOR] Spatial probe failed for visual repair gate: ${probeErr.message}`);
            }

            const qualityFlags = (candidate.warnings || []).some(w =>
                /Qwen QA flagged|Auto-rerouted layout|Converted .* to text-bullets|Preflight adjustments|Validation:/i.test(String(w))
            );

            // CRITICAL: Check for STRUCTURAL issues (overflow/truncation) vs COSMETIC issues
            // Visual Architect can only fix cosmetic issues (spacing, positioning, colors)
            // Structural issues require content reduction or layout change - Visual Architect cannot help
            const hasStructuralIssues = (candidate.warnings || []).some(w =>
                /truncated|hidden|overflow|requires \d+\.\d+ units but only/i.test(String(w))
            );

            if (hasStructuralIssues) {
                console.log(`[GENERATOR] Skipping Visual Architect: structural issues detected (overflow/truncation). Visual repairs won't help.`);
            }

            // Get style-aware threshold for this slide
            const generatorStyleMode = progress?.styleMode;
            const generatorStyleProfile = getStyleProfile(generatorStyleMode);
            const generatorThresholds = getVisualThresholdsForStyle(generatorStyleProfile);

            // GATE 2: DECIDE WHETHER TO RUN EXPENSIVE VL CRITIQUE
            // Must pass: content completeness (Gate 1) AND no structural issues AND needs visual polish
            const shouldRunVisualRepair = VISUAL_REPAIR_ENABLED
                && contentIsShippable // GATE 1: Content must be complete (cheap check)
                && !hasStructuralIssues // Skip if structural issues exist (VL can't help)
                && (validation.passed || qualityFlags)
                && (validation.score < generatorThresholds.TARGET || hasSpatialWarnings || qualityFlags);

            if (shouldRunVisualRepair) {
                console.log(`[GENERATOR] Entering visual repair loop (score: ${validation.score})...`);
                visualCritiqueRan = true;

                if (progress?.onProgress) {
                    const slideLabel = (typeof progress.slideIndex === 'number' && typeof progress.totalSlides === 'number')
                        ? ` Slide ${progress.slideIndex + 1}/${progress.totalSlides}`
                        : '';
                    progress.onProgress(`Agent 4b/5: Visual Architect${slideLabel}...`);
                }

                try {
                    // Import Visual Architect functions
                    const { runQwenVisualArchitectLoop, isQwenVLAvailable } = await import('./visualCortex');

                    // Check if Qwen-VL Visual Architect is available (DEFAULT)
                    const qwenAvailable = isQwenVLAvailable();
                    console.log(`[VISUAL ARCHITECT] Availability: ${qwenAvailable ? 'available' : 'unavailable'}`);
                    if (qwenAvailable) {
                        console.log('✨ [VISUAL ARCHITECT] Using Qwen-VL3 Visual Architect (vision-first, default)');

                        const architectResult = await runQwenVisualArchitectLoop(
                            candidate,
                            styleGuide,
                            routerConfig,
                            costTracker,
                            3 // maxRounds
                        );

                        // Update candidate with Visual Architect result
                        candidate = architectResult.slide;
                        system2Rounds = architectResult.rounds;
                        visualRepairSucceeded = architectResult.converged;
                        visualRepairAttempted = architectResult.rounds > 0;
                        system2Cost = architectResult.totalCost || 0;
                        system2InputTokens = architectResult.totalInputTokens || 0;
                        system2OutputTokens = architectResult.totalOutputTokens || 0;

                        // Update validation with final score
                        candidate.validation = validateSlide(candidate);
                        lastValidation = candidate.validation;

                        console.log(`✅ [VISUAL ARCHITECT] Complete: ${system2Rounds} rounds, final score: ${architectResult.finalScore}, converged: ${architectResult.converged}, cost: $${system2Cost.toFixed(4)}`);

                        if (progress?.onProgress) {
                            progress.onProgress(`Visual Architect complete: score ${Math.round(architectResult.finalScore)} (${architectResult.converged ? 'converged' : 'not converged'})`);
                        }

                    } else {
                        // Fallback: Use legacy System 2 critique loop
                        console.log('[VISUAL ARCHITECT] Qwen-VL not available (missing proxy/key or Node rasterizer). Using legacy System 2');

                        const system2Result = await runRecursiveVisualCritique(
                            candidate,
                            validation,
                            costTracker,
                            styleGuide,
                            progress?.styleMode  // Pass styleMode for style-aware thresholds
                        );

                        // Update candidate with System 2 result
                        candidate = system2Result.slide;
                        system2Rounds = system2Result.rounds;
                        visualRepairSucceeded = system2Result.repairSucceeded;
                        visualRepairAttempted = system2Result.rounds > 0;
                        system2Cost = system2Result.system2Cost;
                        system2InputTokens = system2Result.system2InputTokens;
                        system2OutputTokens = system2Result.system2OutputTokens;

                        // Update validation with final score
                        candidate.validation = validateSlide(candidate);
                        lastValidation = candidate.validation;

                        console.log(`[GENERATOR] Legacy System 2 complete: ${system2Rounds} rounds, final score: ${system2Result.finalScore}, cost: $${system2Result.system2Cost.toFixed(4)}`);

                        if (progress?.onProgress) {
                            progress.onProgress(`Visual critique complete: score ${Math.round(system2Result.finalScore)}`);
                        }
                    }

                } catch (critiqueErr: any) {
                    // Don't block on visual critique errors - graceful degradation
                    console.error(`[GENERATOR] Visual repair error:`, critiqueErr.message);
                    candidate.warnings = [...(candidate.warnings || []), `Visual critique skipped: ${critiqueErr.message}`];
                    if (progress?.onProgress) {
                        progress.onProgress(`Visual critique skipped: ${critiqueErr.message}`);
                    }
                }
            } else if (!VISUAL_REPAIR_ENABLED) {
                console.log('[GENERATOR] Visual repair disabled by flag.');
            } else if (!validation.passed) {
                console.log(`[GENERATOR] Skipping visual repair: validation failed (score: ${validation.score})`);
            } else {
                console.log(`[GENERATOR] Skipping visual repair: score ${validation.score} meets/exceeds target ${generatorThresholds.TARGET} and no spatial warnings detected.`);
            }

            // --- QWEN VISUAL QA (always inspect slide if available) ---
            let qwenQaScore: number | null = null;
            let qwenQaVerdict: string | null = null;
            try {
                const { isQwenVLAvailable, getVisualCritiqueFromSvg } = await import('./visualCortex');

                if (isQwenVLAvailable()) {
                    const svgProxy = await generateSvgProxy(candidate, styleGuide);
                    const qaCritique = await getVisualCritiqueFromSvg(svgProxy, costTracker);

                    if (qaCritique) {
                        console.log(`[QWEN QA] Score=${qaCritique.overall_score}, Verdict=${qaCritique.overall_verdict}, Fidelity=${qaCritique.renderFidelity}`);
                        qwenQaScore = qaCritique.overall_score ?? null;
                        qwenQaVerdict = qaCritique.overall_verdict ?? null;

                        if (qaCritique.overall_verdict === 'requires_repair') {
                            candidate.warnings = [
                                ...(candidate.warnings || []),
                                `Qwen QA flagged for repair (score: ${qaCritique.overall_score})`
                            ];
                        } else if (qaCritique.overall_verdict === 'flag_for_review') {
                            candidate.warnings = [
                                ...(candidate.warnings || []),
                                `Qwen QA flagged for review (score: ${qaCritique.overall_score})`
                            ];
                        }

                        if (qaCritique.edit_instructions?.length) {
                            const hints = qaCritique.edit_instructions
                                .slice(0, 3)
                                .map((h: any) => `${h.action} @ ${h.target_region}: ${h.detail}`)
                                .join(' | ');
                            candidate.warnings = [
                                ...(candidate.warnings || []),
                                `Qwen QA edit hints: ${hints}`
                            ];
                        }
                    } else {
                        console.warn('[QWEN QA] Critique unavailable (proxy/key missing or rasterizer unavailable).');
                    }
                }
            } catch (qaErr: any) {
                console.warn(`[QWEN QA] Inspection failed: ${qaErr.message}`);
            }

            // --- SCORE-BASED CIRCUIT BREAKER ---
            // Create environment snapshot to check spatial health
            const renderStartTime = Date.now();
            const spatialEngine = new SpatialLayoutEngine();
            const variant = candidate.routerConfig?.layoutVariant || routerConfig.layoutVariant || 'standard-vertical';

            // Render once to attach spatial warnings (truncation/unplaced)
            spatialEngine.renderWithSpatialAwareness(
                candidate,
                styleGuide,
                () => undefined,
                candidate.visualDesignSpec
            );

            const zones = spatialEngine.getZonesForVariant(variant);
            const { allocation } = spatialEngine.allocateComponents(
                candidate.title,
                candidate.layoutPlan?.components || [],
                variant
            );
            const renderDurationMs = Date.now() - renderStartTime;

            const envSnapshot = createEnvironmentSnapshot(
                candidate,
                zones,
                allocation,
                renderDurationMs
            );

            console.log(`[CIRCUIT BREAKER] Slide "${candidate.title}": fit_score=${envSnapshot.fit_score.toFixed(2)}, health=${envSnapshot.health_level}, needs_reroute=${envSnapshot.needs_reroute}`);

            // Score thresholds for circuit breaker
            const SCORE_THRESHOLD = {
                PERFECT: 0.85,
                ACCEPTABLE: 0.75,
                TIGHT: 0.60,
                CRITICAL: 0.50
            };

            // Immediate reroute on Qwen QA requires_repair
            if (qwenQaVerdict === 'requires_repair') {
                console.warn(`[CIRCUIT BREAKER] Qwen QA verdict requires repair. Signaling reroute.`);
                return {
                    slide: candidate,
                    needsReroute: true,
                    rerouteReason: `Qwen QA requires repair (score: ${qwenQaScore ?? 'n/a'})`,
                    rerouteReasonType: GeneratorFailureReason.QwenQaFailed,
                    avoidLayoutVariants: [routerConfig.layoutVariant],
                    visualCritiqueRan,
                    visualRepairAttempted,
                    visualRepairSucceeded,
                    system2Cost,
                    system2InputTokens,
                    system2OutputTokens
                };
            }

            // Check if reroute is needed based on fit score
            if (envSnapshot.fit_score < SCORE_THRESHOLD.ACCEPTABLE && attempt === MAX_RETRIES) {
                console.warn(`[CIRCUIT BREAKER] Fit score ${envSnapshot.fit_score.toFixed(2)} < threshold ${SCORE_THRESHOLD.ACCEPTABLE}. Signaling reroute.`);
                return {
                    slide: candidate,
                    needsReroute: true,
                    rerouteReason: envSnapshot.reroute_reason || `Low fit score: ${envSnapshot.fit_score.toFixed(2)}`,
                    rerouteReasonType: GeneratorFailureReason.LowFitScore,
                    avoidLayoutVariants: [routerConfig.layoutVariant],
                    visualCritiqueRan,
                    visualRepairAttempted,
                    visualRepairSucceeded,
                    system2Cost,
                    system2InputTokens,
                    system2OutputTokens
                };
            }

            // Qwen QA-weighted reroute (high priority)
            if (attempt === MAX_RETRIES && qwenQaScore !== null) {
                const QWEN_MIN_SCORE = 70;
                const qwenSoftFail = qwenQaVerdict === 'requires_repair' || qwenQaScore < QWEN_MIN_SCORE;
                const qwenReviewFail = qwenQaVerdict === 'flag_for_review' && envSnapshot.fit_score < 0.7;
                if (qwenSoftFail || qwenReviewFail) {
                    console.warn(`[CIRCUIT BREAKER] Qwen QA score ${qwenQaScore} below ${QWEN_MIN_SCORE} or requires repair. Signaling reroute.`);
                    return {
                        slide: candidate,
                        needsReroute: true,
                        rerouteReason: `Qwen QA score ${qwenQaScore}`,
                        rerouteReasonType: GeneratorFailureReason.QwenQaFailed,
                        avoidLayoutVariants: [routerConfig.layoutVariant],
                        visualCritiqueRan,
                        visualRepairAttempted,
                        visualRepairSucceeded,
                        system2Cost,
                        system2InputTokens,
                        system2OutputTokens
                    };
                }
            }

            if (validation.passed) {
                candidate.validation = validation;
                // Add environment snapshot to slide for observability
                (candidate as any).environmentSnapshot = envSnapshot;

                // Phase 3: Return GeneratorResult with successful slide
                return {
                    slide: candidate,
                    needsReroute: false,
                    visualCritiqueRan,
                    visualRepairAttempted,
                    visualRepairSucceeded,
                    system2Cost,
                    system2InputTokens,
                    system2OutputTokens
                };
            }

            // Phase 3: Check for critical errors that warrant rerouting
            // GAP 1: Include compliance errors as reroute triggers
            const criticalErrors = validation.errors.filter(e =>
                e.code === 'ERR_TEXT_OVERFLOW_CRITICAL' ||
                e.code === 'ERR_MISSING_VISUALS_CRITICAL' ||
                e.code === 'ERR_LAYOUT_MISMATCH_CRITICAL' ||
                e.code === 'ERR_DENSITY_CRITICAL_EXCEEDED' ||
                e.code === 'ERR_TOO_MANY_COMPONENTS' ||
                e.code === 'ERR_ITEM_COUNT_CRITICAL' ||
                e.code === 'ERR_PLACEHOLDER_METRIC'
            );

            const visualFocusError = validation.errors.find(e => e.code === 'VISUAL_FOCUS_MISSING');

            if (visualFocusError && attempt === MAX_RETRIES) {
                console.warn(`[GENERATOR] Visual focus missing, signaling reroute.`);
                return {
                    slide: candidate,
                    needsReroute: true,
                    rerouteReason: visualFocusError.message,
                    rerouteReasonType: GeneratorFailureReason.VisualFocusMissing,
                    avoidLayoutVariants: [routerConfig.layoutVariant],
                    visualCritiqueRan,
                    visualRepairAttempted,
                    visualRepairSucceeded,
                    system2Cost,
                    system2InputTokens,
                    system2OutputTokens
                };
            }

            if (criticalErrors.length > 0 && attempt === MAX_RETRIES) {
                // Instead of falling back immediately, signal reroute opportunity
                console.warn(`[GENERATOR] Critical errors detected, signaling reroute: ${criticalErrors.map(e => e.code).join(', ')}`);
                return {
                    slide: candidate,
                    needsReroute: true,
                    rerouteReason: criticalErrors[0].code,
                    rerouteReasonType: GeneratorFailureReason.CriticalValidation,
                    avoidLayoutVariants: [routerConfig.layoutVariant],
                    visualCritiqueRan,
                    visualRepairAttempted,
                    visualRepairSucceeded,
                    system2Cost,
                    system2InputTokens,
                    system2OutputTokens
                };
            }

            console.warn(`[GENERATOR] Validation failed (attempt ${attempt + 1}):`, validation.errors);
            generatorFailures++;

        } catch (e: any) {
            console.error(`[GENERATOR] Error (attempt ${attempt + 1}):`, e.message);
            generatorFailures++;

            // CIRCUIT BREAKER: If we've failed too many times, skip further attempts
            if (generatorFailures > 2) {
                console.warn(`[GENERATOR] Circuit breaker triggered after ${generatorFailures} failures`);
                break;
            }
        }
    }

    // Fallback: Use text-bullets only for maximum reliability
    console.warn(`[GENERATOR] All attempts exhausted. Using text-bullets fallback.`);
    const fallbackSlide: SlideNode = {
        order: meta.order || 0,
        type: meta.type as any,
        title: meta.title,
        purpose: meta.purpose,
        routerConfig,
        layoutPlan: {
            title: meta.title,
            background: 'solid',
            components: [{
                type: 'text-bullets',
                title: "Key Insights",
                content: safeContentPlan.keyPoints || ["Data unavailable."],
                style: 'standard'
            }]
        },
        visualReasoning: "Fallback (circuit breaker)",
        visualPrompt: "",
        visualDesignSpec: enforcedVisualDesignSpec,
        speakerNotesLines: [`Fallback due to ${generatorFailures} generation failures.`],
        readabilityCheck: 'warning',
        citations: [],
        warnings: lastValidation?.errors?.map((e: any) => e.message) || ["Generation failed after max retries"]
    };

    // Phase 3: Return fallback with needsReroute = false (no more attempts)
    return {
        slide: fallbackSlide,
        needsReroute: false,
        visualCritiqueRan: false,
        visualRepairAttempted: false,
        visualRepairSucceeded: false,
        system2Cost: 0,
        system2InputTokens: 0,
        system2OutputTokens: 0
    };
}

// --- BLUEPRINT TO EDITABLE DECK CONVERTER (Director Pipeline Support) ---

import type { DeckBlueprint } from './DirectorAgent';

/**
 * Converts a Director-produced DeckBlueprint into an EditableSlideDeck.
 * This bridges the new Director pipeline output to the existing UI/export layer.
 */
function blueprintToEditableDeck(
    blueprint: DeckBlueprint,
    costTracker: CostTracker
): EditableSlideDeck {
    const slides: SlideNode[] = blueprint.slides.map((bpSlide, index) => {
        // Build layoutPlan from blueprint components
        const layoutPlan = {
            title: bpSlide.title,
            components: bpSlide.components.map((comp: any) => ({
                type: comp.type || 'text-bullets',
                zoneId: comp.zoneId || 'body',
                content: comp.content || {}
            }))
        };

        const slideNode: SlideNode = {
            order: bpSlide.order,
            type: index === 0 ? SLIDE_TYPES['title-slide'] : 
                  index === blueprint.slides.length - 1 ? SLIDE_TYPES['conclusion'] : SLIDE_TYPES['content-main'],
            title: bpSlide.title,
            purpose: bpSlide.purpose,
            routerConfig: {
                layoutVariant: bpSlide.layoutId as any || 'standard-vertical',
                renderMode: 'standard'
            },
            layoutPlan,
            visualReasoning: `Director-generated: ${bpSlide.purpose}`,
            visualPrompt: bpSlide.imagePrompts?.[0] || '',
            visualDesignSpec: undefined,
            speakerNotesLines: bpSlide.speakerNotes ? [bpSlide.speakerNotes] : [],
            readabilityCheck: 'pass',
            citations: [],
            warnings: []
        };
        return slideNode;
    });

    // Build deck metrics from blueprint (aligned with DeckMetrics interface)
    const deckMetrics: DeckMetrics = {
        totalDurationMs: 0, // Will be filled by caller
        retries: 0,
        totalCost: costTracker.totalCost,
        fallbackSlides: 0,
        visualAlignmentFirstPassSuccess: slides.length,
        totalVisualDesignAttempts: slides.length,
        rerouteCount: 0,
        visualCritiqueAttempts: 0,
        visualRepairSuccess: 0,
        system2Cost: 0,
        system2TokensInput: 0,
        system2TokensOutput: 0,
        coherenceScore: 80,
        coherenceIssues: 0
    };

    return {
        id: crypto.randomUUID(),
        topic: blueprint.title,
        meta: {
            title: blueprint.title,
            narrativeGoal: blueprint.narrativeGoal,
            knowledgeSheet: [], // Empty ResearchFact array - Director doesn't pass raw facts through
            slides: blueprint.slides.map(s => ({
                order: s.order,
                type: SLIDE_TYPES['content-main'],
                title: s.title,
                purpose: s.purpose
            })),
            styleGuide: blueprint.styleGuide || {
                themeName: 'Default',
                fontFamilyTitle: 'Inter',
                fontFamilyBody: 'Inter',
                colorPalette: {
                    primary: '#10b981',
                    secondary: '#3b82f6',
                    background: '#0f172a',
                    text: '#f8fafc',
                    accentHighContrast: '#f59e0b'
                },
                imageStyle: 'Clean',
                layoutStrategy: 'Standard'
            },
            factClusters: []
        },
        slides,
        metrics: deckMetrics
    };
}


// --- ORCHESTRATOR (Level 3: Context Folding + Self-Healing Circuit Breaker + Style-Aware Pipeline) ---

/**
 * Generation options for deck creation
 */
export interface GenerationOptions {
    styleMode?: StyleMode;
    // Future: archetype overrides, custom constraints, etc.
}

/**
 * Main entry point for deck generation.
 * Routes to Director pipeline when ENABLE_DIRECTOR_MODE=true,
 * with silent fallback to legacy pipeline on Director failure.
 * 
 * @param topic - The topic/prompt for deck generation
 * @param onProgress - Progress callback for UI updates
 * @param options - Optional generation options including styleMode
 */
export const generateAgenticDeck = async (
    topic: string,
    onProgress: (status: string, percent?: number) => void,
    options?: GenerationOptions
): Promise<EditableSlideDeck> => {
    // Extract style mode with fallback to default
    const styleMode: StyleMode = options?.styleMode || DEFAULT_STYLE_MODE;
    const styleProfile = getStyleProfile(styleMode);
    
    console.log(`[ORCHESTRATOR] Style mode: ${styleMode} (variation multiplier: ${styleProfile.variationBudgetMultiplier}, negative space: ${styleProfile.negativeSpaceMinRatio})`);
    
    // =========================================================================
    // DIRECTOR PIPELINE (Phase 3 Integration)
    // Silent fallback to legacy pipeline on failure - critical for reliability
    // =========================================================================
    if (ENABLE_DIRECTOR_MODE) {
        console.log("[ORCHESTRATOR] Director mode enabled, routing to new pipeline...");
        try {
            const { runDirector, DeckBlueprintSchema } = await import('./DirectorAgent');
            const costTracker = new CostTracker();
            
            const blueprint = await runDirector(
                { topic, styleMode }, // Pass styleMode to Director
                costTracker,
                onProgress
            );
            
            // JSON Hallucination Trap: Validate blueprint before proceeding
            const parseResult = DeckBlueprintSchema.safeParse(blueprint);
            if (parseResult.success) {
                // Convert blueprint to EditableSlideDeck
                const deck = blueprintToEditableDeck(parseResult.data, costTracker);
                console.log(`[ORCHESTRATOR] Director pipeline complete: ${deck.slides.length} slides`);
                return deck;
            }
            // Validation failed - fall through to legacy pipeline
            console.warn('[ORCHESTRATOR] Director produced invalid blueprint, falling back to legacy');
        } catch (directorErr: any) {
            console.warn('[ORCHESTRATOR] Director pipeline failed, silently falling back:', directorErr.message);
            // Fall through to legacy pipeline
        }
    }

    // =========================================================================
    // LEGACY PIPELINE (Original multi-agent orchestration + Style-Aware)
    // =========================================================================
    const costTracker = new CostTracker();
    const startTime = Date.now();

    console.log("[ORCHESTRATOR] Starting Level 3 Agentic Deck Generation (Legacy)...");
    console.log(`[ORCHESTRATOR] Max iterations per agent: ${MAX_AGENT_ITERATIONS}`);
    console.log(`[ORCHESTRATOR] Style: ${styleMode} | Fit threshold: ${styleProfile.fitScoreThreshold} | Qwen rubric: ${styleProfile.qwenRubric}`);

    // --- PHASE 1: CONTEXT FOLDING STATE ---
    const narrativeHistory: NarrativeTrail[] = [];

    // --- SERENDIPITY STATE (Layer-based composition) ---
    let usedSurprisesInDeck: string[] = []; // Track used surprise types to avoid repetition
    let serendipityDNA: SerendipityDNA | undefined;

    // --- RELIABILITY METRICS ---
    let fallbackSlides = 0;
    let visualAlignmentFirstPassSuccess = 0;
    let totalVisualDesignAttempts = 0;
    let rerouteCount = 0;
    // System 2 Visual Critique Tracking
    let visualCritiqueAttempts = 0;
    let visualRepairSuccess = 0;
    // System 2 Cost Breakdown
    let system2TotalCost = 0;
    let system2TotalInputTokens = 0;
    let system2TotalOutputTokens = 0;

    // 1. RESEARCH PHASE
    onProgress("Agent 1/5: Deep Research (Interactions API)...", 10);
    const facts = await runResearcher(topic, costTracker);
    console.log(`[ORCHESTRATOR] Research complete: ${facts.length} facts found`);

    // 2. ARCHITECTURE PHASE
    onProgress("Agent 2/5: Structuring Narrative...", 25);
    const outline = await runArchitect(topic, facts, costTracker);
    console.log(`[ORCHESTRATOR] Architecture complete: ${outline.slides.length} slides planned`);

    const slides: SlideNode[] = [];
    const totalSlides = outline.slides.length;

    // 3. PER-SLIDE GENERATION with Context Folding + Circuit Breaker + Style-Awareness
    for (let i = 0; i < totalSlides; i++) {
        const slideMeta = outline.slides[i];
        let slideConstraints: RouterConstraints = {};

        try {
            console.log(`[ORCHESTRATOR] Processing slide ${i + 1}/${totalSlides}: "${slideMeta.title}" [${styleMode}]`);

            // --- PHASE 1: Get recent narrative history for context folding ---
            const recentHistory = narrativeHistory.slice(-2);

            // 3a. Route Layout (with optional constraints for rerouting + styleMode)
            onProgress(`Agent 3/5: Routing Slide ${i + 1}/${totalSlides} [${styleMode}]...`, 30 + Math.floor((i / (totalSlides * 2)) * 30));
            let routerConfig = await runRouter(slideMeta, costTracker, slideConstraints, styleMode);

            // 3b. Plan Content (with narrative history for context folding + style hints)
            const clusterIds = slideMeta.relevantClusterIds || [];
            const relevantClusterFacts: string[] = [];
            if (clusterIds.length > 0 && outline.factClusters) {
                clusterIds.forEach((cid: string) => {
                    const cluster = outline.factClusters?.find(c => c.id === cid);
                    if (cluster && cluster.factIds) {
                        cluster.factIds.forEach(fid => {
                            const f = facts.find(fact => fact.id === fid);
                            if (f) relevantClusterFacts.push(`[${f.id}] ${f.claim}`);
                        });
                    }
                });
            }
            const factsContext = relevantClusterFacts.join('\n') || "No specific facts found.";

            // Compute density hints based on slide type, position, AND LAYOUT VARIANT
            // This is critical - zone sizes vary dramatically between layouts
            const isHeroOrIntro = slideMeta.type === 'title-slide' || slideMeta.type === 'section-header' || i === 0;
            const layoutVariant = routerConfig?.layoutVariant || 'standard-vertical';

            // Layout-aware density budgets (based on actual zone capacity)
            // These values are calibrated to the zone sizes in spatialRenderer.ts
            // Now also adjusted by style profile
            const LAYOUT_DENSITY_BUDGETS: Record<string, { maxBullets: number; maxCharsPerBullet: number }> = {
                'hero-centered': { maxBullets: 2, maxCharsPerBullet: 50 },      // Minimal text, big impact
                'split-left-text': { maxBullets: 3, maxCharsPerBullet: 60 },    // 50% width for text
                'split-right-text': { maxBullets: 3, maxCharsPerBullet: 60 },   // 50% width for text
                'bento-grid': { maxBullets: 2, maxCharsPerBullet: 40 },         // Very tight cells
                'dashboard-tiles': { maxBullets: 2, maxCharsPerBullet: 45 },    // Metric-focused
                'metrics-rail': { maxBullets: 2, maxCharsPerBullet: 50 },       // Sidebar layout
                'timeline-horizontal': { maxBullets: 3, maxCharsPerBullet: 50 },// Horizontal flow
                'asymmetric-grid': { maxBullets: 3, maxCharsPerBullet: 55 },    // Mixed zones
                'standard-vertical': { maxBullets: 3, maxCharsPerBullet: 70 },  // Most generous
            };

            const layoutBudget = LAYOUT_DENSITY_BUDGETS[layoutVariant] || LAYOUT_DENSITY_BUDGETS['standard-vertical'];

            // Infer proper archetype from slide type and layout (no unsafe casting)
            const inferredArchetype = inferArchetype(slideMeta.type, layoutVariant, slideMeta.purpose);

            // Apply style-specific adjustments to density budget
            const styleAdjustedBullets = Math.min(
                layoutBudget.maxBullets,
                getBulletsMax(styleProfile, inferredArchetype)
            );

            const densityHint: ContentDensityHint = {
                maxBullets: isHeroOrIntro ? Math.min(2, styleAdjustedBullets) : styleAdjustedBullets,
                maxCharsPerBullet: isHeroOrIntro ? Math.min(50, layoutBudget.maxCharsPerBullet) : layoutBudget.maxCharsPerBullet,
                maxDataPoints: layoutVariant === 'bento-grid' ? 4 : 3
            };

            // Create style-aware content hint
            const styleAwareHint: StyleAwareContentHint = {
                ...densityHint,
                styleMode,
                archetype: inferredArchetype,
                preferDiagram: styleMode === 'serendipitous',
                preferMetrics: styleMode === 'corporate' && !isHeroOrIntro,
                avoidBullets: styleMode === 'serendipitous' && isHeroOrIntro
            };

            console.log(`[ORCHESTRATOR] Layout-aware density: ${layoutVariant} → max ${densityHint.maxBullets} bullets @ ${densityHint.maxCharsPerBullet} chars [${styleMode}]`);

            onProgress(`Agent 3b/5: Content Planning Slide ${i + 1} [${styleMode}]...`, 32 + Math.floor((i / (totalSlides * 2)) * 30));

            // CRITICAL: Content Planner now returns typed ContentPlanResult with style awareness
            // We still validate with ensureValidContentPlan for defense-in-depth
            const rawContentPlan = await runContentPlanner(slideMeta, factsContext, costTracker, recentHistory, densityHint, styleAwareHint);
            const safeContentPlan: ContentPlanResult = ensureValidContentPlan(rawContentPlan, slideMeta);

            console.log(`[ORCHESTRATOR] Content plan validated: ${safeContentPlan.keyPoints.length} keyPoints, ${safeContentPlan.dataPoints.length} dataPoints${safeContentPlan.contentStrategy ? ` (${safeContentPlan.contentStrategy.preferredFormat})` : ''}`);

            // CREATIVITY FIX: If dataPoints are insufficient, steer away from metric-heavy layouts
            // This prevents Generator from outputting empty metrics:[] arrays
            const hasValidDataPoints = safeContentPlan.dataPoints && safeContentPlan.dataPoints.length >= 2;
            if (!hasValidDataPoints) {
                // Add metrics-rail and dashboard-tiles to avoid list (they require metrics)
                const metricHeavyLayouts = ['metrics-rail', 'dashboard-tiles'];
                slideConstraints.avoidLayoutVariants = [
                    ...(slideConstraints.avoidLayoutVariants || []),
                    ...metricHeavyLayouts.filter(l => !slideConstraints.avoidLayoutVariants?.includes(l))
                ];
                console.log(`[ORCHESTRATOR] No valid dataPoints (${safeContentPlan.dataPoints.length}), avoiding metric-heavy layouts`);
                
                // STYLE-AWARE FALLBACK: Corporate mode without data degrades to professional
                if (styleMode === 'corporate' && !hasValidDataPoints) {
                    console.log(`[ORCHESTRATOR] Corporate mode with no data - degrading to professional for this slide`);
                    // Note: We don't change the global styleMode, just log the degradation
                }
            }

            // 3b.1 Qwen Layout Selector (visual QA-driven layout selection)
            routerConfig = await runQwenLayoutSelector(
                slideMeta,
                safeContentPlan,
                routerConfig,
                outline.styleGuide,
                costTracker,
                slideConstraints
            );

            // 3c. Visual Design (using Interactions API) - Track first-pass success
            onProgress(`Agent 3c/5: Visual Design Slide ${i + 1} [${styleMode}]...`, 34 + Math.floor((i / (totalSlides * 2)) * 30));
            totalVisualDesignAttempts++;
            
            // Apply style multiplier to variation budget
            const baseVariationBudget = computeVariationBudget(i, totalSlides, slideMeta.type, slideMeta.title);
            const variationBudget = applyStyleMultiplierToVariationBudget(baseVariationBudget, styleMode);
            console.log(`[ORCHESTRATOR] Variation budget: ${baseVariationBudget.toFixed(2)} → ${variationBudget.toFixed(2)} (${styleMode} multiplier)`);
            
            const visualDesign = await runVisualDesigner(
                slideMeta.title,
                safeContentPlan,
                routerConfig,
                facts,
                costTracker,
                outline.styleGuide,
                variationBudget
            );

            // Phase 2: Track visual alignment first-pass success
            const visualValidation = validateVisualLayoutAlignment(visualDesign, routerConfig);
            if (visualValidation.passed && visualValidation.score >= styleProfile.fitScoreThreshold) {
                visualAlignmentFirstPassSuccess++;
                console.log(`[ORCHESTRATOR] Visual design first-pass SUCCESS (score: ${visualValidation.score} >= ${styleProfile.fitScoreThreshold})`);
            } else {
                console.log(`[ORCHESTRATOR] Visual design needs improvement (score: ${visualValidation.score} < ${styleProfile.fitScoreThreshold})`);
            }

            // 3c.1 COMPOSITION ARCHITECT (Serendipity Mode - Layer-based composition + Style-aware)
            // Runs only when SERENDIPITY_MODE_ENABLED is true
            let compositionPlan: CompositionPlan | undefined;
            if (SERENDIPITY_MODE_ENABLED) {
                onProgress(`Agent 3c.1/5: Composition Architecture Slide ${i + 1} [${styleMode}]...`, 36 + Math.floor((i / (totalSlides * 2)) * 30));

                // Extract serendipity DNA from style guide on first slide
                if (i === 0 && outline.styleGuide.styleDNA) {
                    serendipityDNA = {
                        motifs: outline.styleGuide.styleDNA.motifs || [],
                        texture: outline.styleGuide.styleDNA.texture,
                        gridRhythm: outline.styleGuide.styleDNA.gridRhythm,
                        accentRule: outline.styleGuide.styleDNA.accentRule,
                        cardStyle: outline.styleGuide.styleDNA.cardStyle || 'glass',
                        surpriseCues: outline.styleGuide.styleDNA.surpriseCues
                    };
                }

                const detailedBudget = computeDetailedVariationBudget(
                    i,
                    totalSlides,
                    slideMeta.type,
                    serendipityDNA
                );

                compositionPlan = await runCompositionArchitect({
                    slideId: `slide-${i}`,
                    slideTitle: slideMeta.title,
                    slidePurpose: slideMeta.purpose,
                    routerConfig,
                    contentPlan: {
                        keyPoints: safeContentPlan.keyPoints || [],
                        dataPoints: (safeContentPlan as any).dataPoints || []
                    },
                    serendipityDNA,
                    variationBudget: detailedBudget.overall,
                    narrativeTrail: recentHistory,
                    usedSurprisesInDeck,
                    styleMode // Pass styleMode to Composition Architect
                }, costTracker);

                // Track used surprises to avoid repetition
                usedSurprisesInDeck = trackUsedSurprises(usedSurprisesInDeck, compositionPlan);

                console.log(`[ORCHESTRATOR] Composition plan: ${compositionPlan.layerPlan.contentStructure.pattern}, surprises: ${compositionPlan.serendipityPlan.allocatedSurprises.length} [${styleMode}]`);
            }

            // 3d. Final Generation (with narrative history + circuit breaker + style awareness)
            // GAP 3: Bounded reroute loop to prevent infinite reroutes
            const MAX_REROUTES_PER_SLIDE = 2;
            let slideRerouteCount = 0;
            let generatorResult: GeneratorResult;

            // CRITICAL: Use typed ContentPlanResult throughout the generation loop
            // This ensures all downstream consumers (generator, visual designer, layout selector)
            // receive a guaranteed-valid content plan shape
            let currentContentPlan: ContentPlanResult = safeContentPlan;
            let currentVisualDesign = visualDesign;
            let currentRouterConfig = routerConfig;
            let currentCompositionPlan = compositionPlan; // Pass composition plan to generator

            while (slideRerouteCount <= MAX_REROUTES_PER_SLIDE) {
                onProgress(`Agent 4/5: Generating Slide ${i + 1} [${styleMode}]...`, 40 + Math.floor((i / (totalSlides * 2)) * 40));
                generatorResult = await runGenerator(
                    slideMeta,
                    currentRouterConfig,
                    currentContentPlan,
                    currentVisualDesign,
                    facts,
                    outline.factClusters || [],
                    outline.styleGuide,
                    costTracker,
                    recentHistory,
                    {
                        onProgress,
                        slideIndex: i,
                        totalSlides,
                        styleMode // Pass styleMode to Generator
                    }
                );

                // Track System 2 metrics
                if (generatorResult.visualCritiqueRan) visualCritiqueAttempts++;
                if (generatorResult.visualRepairSucceeded) visualRepairSuccess++;
                // Accumulate System 2 costs
                if (generatorResult.system2Cost) {
                    system2TotalCost += generatorResult.system2Cost;
                    system2TotalInputTokens += generatorResult.system2InputTokens || 0;
                    system2TotalOutputTokens += generatorResult.system2OutputTokens || 0;
                }

                // --- PHASE 3: SELF-HEALING CIRCUIT BREAKER ---
                if (generatorResult.needsReroute && slideRerouteCount < MAX_REROUTES_PER_SLIDE) {
                    slideRerouteCount++;
                    const reasonType = generatorResult.rerouteReasonType || GeneratorFailureReason.Unknown;
                    console.warn(`[ORCHESTRATOR] Reroute ${slideRerouteCount}/${MAX_REROUTES_PER_SLIDE} for slide ${i + 1} (${reasonType}): ${generatorResult.rerouteReason}`);
                    rerouteCount++;

                    // Re-run router with constraints to avoid failed layout (preserve styleMode)
                    const newConstraints: RouterConstraints = {
                        avoidLayoutVariants: generatorResult.avoidLayoutVariants
                    };
                    currentRouterConfig = await runRouter(slideMeta, costTracker, newConstraints, styleMode);

                    // TIGHTER density hints on reroute - content overflow was likely the issue
                    const rerouteDensityHint: ContentDensityHint = {
                        maxBullets: 2, // Stricter on reroute
                        maxCharsPerBullet: 60, // Shorter bullets
                        maxDataPoints: 2
                    };

                    // Build style-aware hint for reroute with tighter constraints
                    const rerouteStyleHint: StyleAwareContentHint = {
                        ...rerouteDensityHint,
                        styleMode,
                        archetype: inferredArchetype,
                        preferDiagram: styleMode === 'serendipitous',
                        preferMetrics: styleMode === 'corporate' && !isHeroOrIntro,
                        avoidBullets: styleMode === 'serendipitous' && isHeroOrIntro
                    };

                    // Re-run content planner with tighter constraints and validate result (preserve style)
                    const rerouteRawContentPlan = await runContentPlanner(slideMeta, factsContext, costTracker, recentHistory, rerouteDensityHint, rerouteStyleHint);
                    currentContentPlan = ensureValidContentPlan(rerouteRawContentPlan, slideMeta);
                    console.log(`[ORCHESTRATOR] Reroute content plan: ${currentContentPlan.keyPoints.length} keyPoints`);

                    // Re-run Qwen layout selector (visual QA-driven)
                    currentRouterConfig = await runQwenLayoutSelector(
                        slideMeta,
                        currentContentPlan,
                        currentRouterConfig,
                        outline.styleGuide,
                        costTracker,
                        newConstraints
                    );
                    const rerouteVariationBudget = computeVariationBudget(i, totalSlides, slideMeta.type, slideMeta.title);
                    currentVisualDesign = await runVisualDesigner(
                        slideMeta.title,
                        currentContentPlan,
                        currentRouterConfig,
                        facts,
                        costTracker,
                        outline.styleGuide,
                        rerouteVariationBudget
                    );

                    // Continue loop for another attempt
                    continue;
                } else if (generatorResult.needsReroute && slideRerouteCount >= MAX_REROUTES_PER_SLIDE) {
                    // Max reroutes exhausted - force fallback
                    console.error(`[ORCHESTRATOR] Max reroutes (${MAX_REROUTES_PER_SLIDE}) exhausted for slide ${i + 1}, using fallback`);
                    generatorResult.slide.warnings = [
                        ...(generatorResult.slide.warnings || []),
                        `Failed to find suitable layout after ${MAX_REROUTES_PER_SLIDE} reroutes, using fallback`
                    ];
                    fallbackSlides++;
                    break;
                } else {
                    // Success - exit loop
                    break;
                }
            }

            const slideNode = generatorResult.slide;

            // Attach composition plan to slide for layer-aware rendering
            if (SERENDIPITY_MODE_ENABLED && currentCompositionPlan) {
                slideNode.compositionPlan = currentCompositionPlan;
            }

            // Track if this is a fallback slide
            if (slideNode.visualReasoning?.includes('Fallback')) {
                fallbackSlides++;
            }

            // 3e. Image Generation
            const finalVisualPrompt = visualDesign.prompt_with_composition || `${slideNode.title} professional abstract background`;
            slideNode.visualPrompt = finalVisualPrompt;

            if (finalVisualPrompt) {
                onProgress(`Agent 5/5: Rendering Visual ${i + 1}...`, 60 + Math.floor((i / totalSlides) * 40));
                const imgResult = await generateImageFromPrompt(finalVisualPrompt, "16:9", costTracker);
                if (imgResult) {
                    slideNode.backgroundImageUrl = imgResult.imageUrl;
                }
            }

            // --- LOG ENVIRONMENT SNAPSHOT METRICS ---
            const envSnapshot = (slideNode as any).environmentSnapshot;
            if (envSnapshot) {
                console.log(`[ORCHESTRATOR] Slide ${i + 1} "${slideNode.title}" spatial health:`);
                console.log(`  - Fit Score: ${envSnapshot.fit_score.toFixed(2)} (${envSnapshot.health_level})`);
                console.log(`  - Text Density: ${envSnapshot.text_density.toFixed(2)}`);
                console.log(`  - Visual Utilization: ${envSnapshot.visual_utilization.toFixed(2)}`);
                console.log(`  - Warnings: ${envSnapshot.warnings_count}`);
                console.log(`  - Suggested Action: ${envSnapshot.suggested_action}`);

                if (envSnapshot.health_level === 'critical' || envSnapshot.fit_score < 0.5) {
                    console.warn(`[ORCHESTRATOR] ⚠️  Slide ${i + 1} has critical spatial issues despite generation.`);
                }
            }

            // --- PHASE 1: Update narrative history for context folding ---
            // Enhanced with design decisions and visual themes
            const componentTypes = slideNode.layoutPlan?.components?.map(c => c.type) || [];
            const visualTheme = slideNode.visualDesignSpec?.color_harmony
                ? `${slideNode.visualDesignSpec.color_harmony.primary} / ${slideNode.visualDesignSpec.color_harmony.accent}`
                : undefined;
            const designDecisions = slideNode.routerConfig?.layoutIntent || slideNode.visualDesignSpec?.spatial_strategy?.compositional_hierarchy;

            narrativeHistory.push({
                title: slideNode.title,
                mainPoint: slideNode.speakerNotesLines?.[0]?.substring(0, 100) || slideNode.purpose || '',
                layoutVariant: slideNode.routerConfig?.layoutVariant,
                renderMode: slideNode.routerConfig?.renderMode,
                componentTypes,
                visualTheme,
                designDecisions
            });

            slides.push(slideNode);

        } catch (slideError: any) {
            // --- ERROR BOUNDARY: Create fallback slide instead of failing entire deck ---
            console.error(`[ORCHESTRATOR] Slide ${i + 1} failed, using fallback:`, slideError.message);
            fallbackSlides++;

            const fallbackSlide: SlideNode = {
                order: slideMeta.order || i,
                type: slideMeta.type as any,
                title: slideMeta.title,
                purpose: slideMeta.purpose,
                routerConfig: {
                    renderMode: 'standard',
                    layoutVariant: 'standard-vertical',
                    layoutIntent: 'Fallback due to error',
                    densityBudget: { maxChars: 500, maxItems: 5, minVisuals: 0 },
                    visualFocus: 'Content'
                },
                layoutPlan: {
                    title: slideMeta.title,
                    background: 'solid',
                    components: [{
                        type: 'text-bullets',
                        title: 'Content',
                        content: ['Slide content could not be generated.', 'Please edit this slide manually.'],
                        style: 'standard'
                    }]
                },
                visualReasoning: 'Fallback due to generation error',
                visualPrompt: `${slideMeta.title} professional abstract background`,
                speakerNotesLines: [`Slide generation failed: ${slideError.message}`],
                readabilityCheck: 'warning',
                citations: [],
                warnings: [`Generation failed: ${slideError.message}`]
            };

            // Still update narrative history for context continuity
            narrativeHistory.push({
                title: slideMeta.title,
                mainPoint: 'Content pending manual edit'
            });

            slides.push(fallbackSlide);
        }
    }

    onProgress("Finalizing Deck...", 100);

    // ============================================================================
    // NO-PLACEHOLDER SHIPPING GATE (HARD FAIL)
    // ============================================================================
    // Final check: ensure no placeholder content escapes to export.
    // Slides with placeholders are either fixed (component removal) or flagged.
    console.log("[ORCHESTRATOR] Checking no-placeholder shipping gate...");
    
    let placeholderBlockCount = 0;
    slides.forEach((slide, idx) => {
        const shippingGate = checkNoPlaceholderShippingGate(slide);
        
        if (!shippingGate.canShip) {
            placeholderBlockCount++;
            console.warn(`[ORCHESTRATOR] ⚠️  Slide ${idx + 1} blocked by shipping gate: ${shippingGate.blockedContent.map(b => b.placeholderFound).join(', ')}`);
            console.warn(`[ORCHESTRATOR]    Recommendation: ${shippingGate.recommendation}`);
            
            // Apply auto-fix based on recommendation
            if (shippingGate.recommendation === 'remove_component' || shippingGate.recommendation === 'convert_to_text') {
                const indicesToRemove = [...new Set(shippingGate.blockedContent.map(b => b.componentIndex))];
                
                // For chart-frame/metric-cards with placeholder data, convert to simple text fallback
                indicesToRemove.forEach(compIdx => {
                    const comp = slide.layoutPlan?.components?.[compIdx];
                    if (comp && (comp.type === 'chart-frame' || comp.type === 'metric-cards')) {
                        // Convert to text-bullets fallback
                        // Note: metric-cards doesn't have title, use intro or generic fallback
                        const fallbackTitle = comp.type === 'chart-frame' 
                            ? (comp as any).title || 'Content'
                            : (comp as any).intro || 'Data';
                        const fallbackComp = {
                            type: 'text-bullets' as const,
                            title: fallbackTitle,
                            content: ['Data visualization pending manual update.'],
                            style: 'standard' as const
                        };
                        slide.layoutPlan!.components![compIdx] = fallbackComp;
                        console.log(`[ORCHESTRATOR]    Auto-converted ${comp.type} at index ${compIdx} to text-bullets fallback`);
                    }
                });
                
                slide.warnings = [
                    ...(slide.warnings || []),
                    `Shipping gate: Placeholder content auto-fixed (${shippingGate.blockedContent.length} issues)`
                ];
            } else if (shippingGate.recommendation === 'regenerate') {
                // Cannot auto-fix - flag for manual attention
                slide.warnings = [
                    ...(slide.warnings || []),
                    `⚠️ MANUAL REVIEW REQUIRED: Multiple placeholder content issues found`
                ];
                slide.readabilityCheck = 'fail' as any;
            }
        }
    });
    
    if (placeholderBlockCount > 0) {
        console.warn(`[ORCHESTRATOR] Shipping gate: ${placeholderBlockCount}/${slides.length} slides had placeholder content (auto-fixed or flagged)`);
    } else {
        console.log(`[ORCHESTRATOR] ✅ No-placeholder shipping gate passed for all slides`);
    }

    // GAP 2: Deck-Wide Narrative Coherence Validation
    console.log("[ORCHESTRATOR] Validating deck-wide narrative coherence...");
    const coherenceReport = validateDeckCoherence(slides);

    if (!coherenceReport.passed || coherenceReport.issues.length > 0) {
        console.warn(`[ORCHESTRATOR] Coherence validation: score ${coherenceReport.coherenceScore}/100`);
        coherenceReport.issues.forEach(issue => {
            const severity = issue.severity === 'critical' ? '🔴' : issue.severity === 'major' ? '🟡' : '🔵';
            const slideRefs = issue.slideIndices.map(i => `#${i + 1}`).join(', ');
            console.warn(`${severity} [${issue.type.toUpperCase()}] ${issue.message} (slides: ${slideRefs})`);

            // Add warnings to affected slides
            issue.slideIndices.forEach(idx => {
                if (slides[idx]) {
                    slides[idx].warnings = [
                        ...(slides[idx].warnings || []),
                        `Coherence issue: ${issue.message}`
                    ];
                }
            });
        });

        // Log summary
        const repetitionCount = coherenceReport.issues.filter(i => i.type === 'repetition').length;
        const arcViolationCount = coherenceReport.issues.filter(i => i.type === 'arc_violation').length;
        const driftCount = coherenceReport.issues.filter(i => i.type === 'thematic_drift').length;

        if (repetitionCount > 0) console.warn(`[ORCHESTRATOR]   - ${repetitionCount} repetition issue(s)`);
        if (arcViolationCount > 0) console.warn(`[ORCHESTRATOR]   - ${arcViolationCount} narrative arc violation(s)`);
        if (driftCount > 0) console.warn(`[ORCHESTRATOR]   - ${driftCount} thematic drift issue(s)`);
    } else {
        console.log(`[ORCHESTRATOR] ✅ Deck coherence validation passed (score: ${coherenceReport.coherenceScore}/100)`);
    }

    const totalDurationMs = Date.now() - startTime;
    const costSummary = costTracker.getSummary();

    // --- RELIABILITY METRICS LOGGING ---
    const visualFirstPassRate = totalVisualDesignAttempts > 0
        ? Math.round((visualAlignmentFirstPassSuccess / totalVisualDesignAttempts) * 100)
        : 0;
    const fallbackRate = totalSlides > 0 ? (fallbackSlides / totalSlides) * 100 : 0;

    console.log("[ORCHESTRATOR] ✅ Level 3 Generation Complete!");
    console.log(`[ORCHESTRATOR] Duration: ${(totalDurationMs / 1000).toFixed(1)}s`);
    console.log(`[ORCHESTRATOR] Total Cost: $${costSummary.totalCost.toFixed(4)}`);
    console.log(`[ORCHESTRATOR] 💰 Savings vs Pro: $${costSummary.totalSavingsVsPro.toFixed(4)} (${((costSummary.totalSavingsVsPro / (costSummary.totalCost + costSummary.totalSavingsVsPro)) * 100).toFixed(0)}%)`);
    console.log(`[ORCHESTRATOR] Tokens: ${costSummary.totalInputTokens} in, ${costSummary.totalOutputTokens} out`);
    console.log(`[ORCHESTRATOR] Tokens (reported total): ${costSummary.totalTokensReported}`);
    console.log(`[ORCHESTRATOR] Model Breakdown:`, costSummary.modelBreakdown);
    console.log(`[ORCHESTRATOR] 📊 RELIABILITY METRICS:`);
    console.log(`[ORCHESTRATOR]   - Fallback Slides: ${fallbackSlides}/${totalSlides} (${fallbackRate.toFixed(1)}%) - Target: ≤1/deck`);
    console.log(`[ORCHESTRATOR]   - Visual First-Pass Success: ${visualAlignmentFirstPassSuccess}/${totalVisualDesignAttempts} (${visualFirstPassRate}%) - Target: ≥80%`);
    console.log(`[ORCHESTRATOR]   - Reroute Count: ${rerouteCount}`);
    console.log(`[ORCHESTRATOR] 🔍 SYSTEM 2 VISUAL CRITIQUE:`);
    console.log(`[ORCHESTRATOR]   - Visual Critique Attempts: ${visualCritiqueAttempts}/${totalSlides}`);
    console.log(`[ORCHESTRATOR]   - Visual Repair Success: ${visualRepairSuccess}/${visualCritiqueAttempts > 0 ? visualCritiqueAttempts : 1}`);
    console.log(`[ORCHESTRATOR]   - System 2 Cost: $${system2TotalCost.toFixed(4)} (${costSummary.totalCost > 0 ? (system2TotalCost / costSummary.totalCost * 100).toFixed(1) : 0}% of total)`);
    console.log(`[ORCHESTRATOR]   - System 2 Tokens: ${system2TotalInputTokens} in, ${system2TotalOutputTokens} out`);

    // Compute metrics for reliability targets
    const deckMetrics: DeckMetrics = {
        totalDurationMs,
        retries: rerouteCount,
        totalCost: costSummary.totalCost,
        fallbackSlides,
        visualAlignmentFirstPassSuccess,
        totalVisualDesignAttempts,
        rerouteCount,
        visualCritiqueAttempts,
        visualRepairSuccess,
        system2Cost: system2TotalCost,
        system2TokensInput: system2TotalInputTokens,
        system2TokensOutput: system2TotalOutputTokens,
        coherenceScore: coherenceReport.coherenceScore,
        coherenceIssues: coherenceReport.issues.length
    };

    return {
        id: crypto.randomUUID(),
        topic,
        meta: outline,
        slides,
        metrics: deckMetrics
    };
};

// --- SINGLE SLIDE REGENERATION ---

export const regenerateSingleSlide = async (
    meta: any,
    currentSlide: SlideNode,
    facts: ResearchFact[],
    factClusters: z.infer<typeof FactClusterSchema>[] = [],
    styleMode?: StyleMode  // Optional style mode for consistency
): Promise<SlideNode> => {
    const costTracker = new CostTracker();

    // Use default styleGuide for single slide regeneration
    const defaultStyleGuide: GlobalStyleGuide = {
        themeName: "Default",
        fontFamilyTitle: "Inter",
        fontFamilyBody: "Inter",
        colorPalette: {
            primary: "#10b981",
            secondary: "#3b82f6",
            background: "#0f172a",
            text: "#f8fafc",
            accentHighContrast: "#f59e0b"
        },
        imageStyle: "Clean",
        layoutStrategy: "Standard"
    };

    let routerConfig = await runRouter(meta, costTracker, undefined, styleMode);

    // Build style hint for single slide regeneration
    const singleSlideStyleHint: StyleAwareContentHint | undefined = styleMode ? {
        maxBullets: 3,
        maxCharsPerBullet: 70,
        styleMode,
        archetype: undefined,
        preferDiagram: styleMode === 'serendipitous',
        preferMetrics: styleMode === 'corporate',
        avoidBullets: false
    } : undefined;

    // Use typed content plan with validation for single slide regeneration
    const rawContentPlan = await runContentPlanner(meta, "", costTracker, [], undefined, singleSlideStyleHint);
    const contentPlan: ContentPlanResult = ensureValidContentPlan(rawContentPlan, meta);

    routerConfig = await runQwenLayoutSelector(
        meta,
        contentPlan,
        routerConfig,
        defaultStyleGuide,
        costTracker
    );
    const visualDesign = await runVisualDesigner(
        meta.title,
        contentPlan,
        routerConfig,
        facts,
        costTracker,
        defaultStyleGuide,
        computeVariationBudget(0, 1, meta.type, meta.title)
    );

    // Generator now returns GeneratorResult, extract the slide
    const generatorResult = await runGenerator(meta, routerConfig, contentPlan, visualDesign, facts, factClusters, defaultStyleGuide, costTracker);
    const newSlide = generatorResult.slide;

    newSlide.visualPrompt = visualDesign.prompt_with_composition;

    if (newSlide.visualPrompt) {
        const imgResult = await generateImageFromPrompt(newSlide.visualPrompt, "16:9", costTracker);
        if (imgResult) {
            newSlide.backgroundImageUrl = imgResult.imageUrl;
        }
    }
    return newSlide;
};

