/**
 * Director Agent - Adaptive Orchestrator (Manus-style)
 * 
 * ARCHITECTURE: Non-linear state machine with BIDIRECTIONAL quality loops
 * and TWO-TIER validation (Logic Gate + Visual Gate).
 * 
 * Key Capabilities:
 * - THIN content → ENRICH (targeted re-research)
 * - FAT content → PRUNE/SUMMARIZE (condensation)
 * - Visual Gate → quickFitCheck (catches overflow that char counts miss)
 * - Early Asset Extraction → Parallel image generation
 * 
 * Two-Tier Validation (IFR + VFR):
 * 1. Logic Gate (Fast): Character counts + layout-specific limits
 * 2. Visual Gate (Accurate): quickFitCheck for real overflow detection
 * 
 * Layout-Aware Quality Gates:
 * - Hero slides: LESS is MORE (Apple-style minimalism)
 * - Standard slides: Bounded content with min/max thresholds
 * 
 * State Machine:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  RESEARCH → ARCHITECT → ASSET_EXTRACT → [Per-Slide] → ASSEMBLE │
 * │                              ↓ (parallel)                       │
 * │                    ┌─────────▼─────────┐                       │
 * │                    │  ROUTE → PLAN     │                       │
 * │                    │       │           │                       │
 * │                    │ EVALUATE (Logic)  │                       │
 * │                    │       │           │                       │
 * │                    │ VISUAL GATE ◄─────┤ (if sampled)          │
 * │                    │  │   │   │        │                       │
 * │                    │ PASS THIN FAT     │                       │
 * │                    │  │   │   │        │                       │
 * │                    │  ▼   ▼   ▼        │                       │
 * │                    │ NEXT ENRICH PRUNE─┘                       │
 * │                    └───────────────────┘                       │
 * └─────────────────────────────────────────────────────────────────┘
 * 
 * Tool Invocations:
 * - runResearcher: Initial research + targeted re-research
 * - runArchitect: Narrative structure planning
 * - runRouter: Layout selection per slide
 * - runContentPlanner: Content generation per slide
 * - pruneContent: Remove excess points (local)
 * - summarizeContent: Condense verbose text (local)
 * - quickFitCheck: Visual overflow detection (VisualSensor)
 * - generateAssetsParallel: Background image generation
 */

import { z } from 'zod';
import { CostTracker, MODEL_SIMPLE } from './interactionsClient';
import type { ResearchFact } from '../types/slideTypes';
import { quickFitCheck } from './VisualSensor';

// =============================================================================
// DIRECTOR CONFIGURATION
// =============================================================================

// =============================================================================
// VISUAL GATE FAILURE CODES (Structured Logging)
// =============================================================================

export type VisualGateFailureCode = 
    | 'TITLE_OVERFLOW'         // Title text exceeds zone width
    | 'BODY_WRAP_EXCEEDED'     // Body text wraps beyond acceptable lines
    | 'BULLET_TOO_LONG'        // Individual bullet exceeds char limit
    | 'TOTAL_CHARS_OVERFLOW'   // Total content chars exceed layout limit
    | 'ELEMENT_DENSITY_HIGH'   // Too many visual elements in zone
    | 'VISUAL_FIT_FAILED';     // Generic quickFitCheck failure

export interface VisualGateFailure {
    code: VisualGateFailureCode;
    slideIndex: number;
    layoutId: string;
    details: string;
    action: 'prune' | 'summarize' | 'change_layout';
}

// =============================================================================
// LAYOUT RISK PROFILES (Risk-Based Sampling)
// =============================================================================
// High-risk layouts need 100% validation; low-risk can be skipped.
// This prevents the "sampling gamble" where easy slides pass but hard ones fail.

type LayoutRiskLevel = 'high' | 'medium' | 'low';

const LAYOUT_RISK_PROFILES: Record<string, LayoutRiskLevel> = {
    // HIGH RISK: Complex, tight constraints - ALWAYS validate
    'bento-grid': 'high',
    'dashboard-tiles': 'high',
    'metrics-rail': 'high',
    'asymmetric-grid': 'high',
    
    // MEDIUM RISK: Moderate density - use sampling rate
    'split-left-text': 'medium',
    'split-right-text': 'medium',
    'standard-vertical': 'medium',
    'timeline-horizontal': 'medium',
    
    // LOW RISK: Simple layouts - skip unless title is very long
    'hero-centered': 'low'
};

const getLayoutRiskLevel = (layoutId: string): LayoutRiskLevel => {
    return LAYOUT_RISK_PROFILES[layoutId] || 'medium';
};

// =============================================================================
// DIRECTOR MODE PRESETS
// =============================================================================
// Pre-configured modes to avoid combinatorial config explosion.
// Users pick a mode; advanced users can override raw flags.

export type DirectorMode = 'fast' | 'balanced' | 'premium';

export interface DirectorConfig {
    mode?: DirectorMode;              // Preset mode (overrides individual flags if set)
    enableVisualValidation: boolean;  // Use Visual Sensor for validation
    visualValidationSampling: number; // 0-1: Base sampling rate for MEDIUM risk layouts
    enableParallelPlanning: boolean;  // Enable parallel slide planning
    enableEarlyAssetExtraction: boolean; // Extract image prompts early
    assetGenerationTimeout: number;   // Max wait time for assets at ASSEMBLE (ms)
    maxConcurrentImages: number;      // Back-pressure control for image generation
}

const MODE_PRESETS: Record<DirectorMode, Omit<DirectorConfig, 'mode'>> = {
    fast: {
        enableVisualValidation: false,
        visualValidationSampling: 0,
        enableParallelPlanning: false,
        enableEarlyAssetExtraction: true,
        assetGenerationTimeout: 5000,    // 5s max wait
        maxConcurrentImages: 5           // Higher concurrency for speed
    },
    balanced: {
        enableVisualValidation: true,
        visualValidationSampling: 0.3,   // 30% for MEDIUM risk
        enableParallelPlanning: false,
        enableEarlyAssetExtraction: true,
        assetGenerationTimeout: 15000,   // 15s reasonable wait
        maxConcurrentImages: 3           // Conservative
    },
    premium: {
        enableVisualValidation: true,
        visualValidationSampling: 1.0,   // 100% validation
        enableParallelPlanning: false,   // Still experimental
        enableEarlyAssetExtraction: true,
        assetGenerationTimeout: 30000,   // Wait longer for quality
        maxConcurrentImages: 2           // Very conservative
    }
};

const DEFAULT_CONFIG: DirectorConfig = {
    mode: 'balanced',
    ...MODE_PRESETS.balanced
};

/**
 * Resolve config with mode presets. Mode takes precedence over individual flags.
 */
function resolveConfig(userConfig?: Partial<DirectorConfig>): DirectorConfig {
    if (!userConfig) return DEFAULT_CONFIG;
    
    // If mode is specified, use preset as base
    if (userConfig.mode && MODE_PRESETS[userConfig.mode]) {
        return {
            mode: userConfig.mode,
            ...MODE_PRESETS[userConfig.mode],
            // Allow individual overrides on top of preset
            ...Object.fromEntries(
                Object.entries(userConfig).filter(([k, v]) => k !== 'mode' && v !== undefined)
            )
        } as DirectorConfig;
    }
    
    return { ...DEFAULT_CONFIG, ...userConfig };
}

// =============================================================================
// DECK BLUEPRINT SCHEMA
// =============================================================================

export const DeckBlueprintSchema = z.object({
    narrativeGoal: z.string().max(300),
    title: z.string().max(100),
    styleGuide: z.any(),
    slides: z.array(z.object({
        order: z.number(),
        layoutId: z.string(),
        title: z.string(),
        purpose: z.string(),
        components: z.array(z.any()),
        imagePrompts: z.array(z.string()).optional(),
        speakerNotes: z.string().optional(),
        enrichmentAttempts: z.number().optional() // Track loop-backs
    })).min(3).max(15),
    researchSummary: z.string().optional(),
    metrics: z.object({
        totalEnrichments: z.number(),
        slidesEnriched: z.number()
    }).optional()
});

export type DeckBlueprint = z.infer<typeof DeckBlueprintSchema>;

// =============================================================================
// CONTENT QUALITY THRESHOLDS (Now Layout-Aware)
// =============================================================================

const QUALITY_THRESHOLDS = {
    MIN_KEY_POINTS: 2,           // Minimum bullet points for standard slides
    MIN_CHARS_PER_POINT: 20,     // Minimum substantive content per point
    MIN_TOTAL_CHARS: 80,         // Minimum total content characters
    MAX_ENRICHMENT_ATTEMPTS: 2,  // Prevent infinite ENRICH loops
    MAX_PRUNE_ATTEMPTS: 2,       // Prevent infinite PRUNE loops
    HERO_SLIDE_MIN_POINTS: 0,    // Hero slides can be just title + tagline (no bullets required)
    HERO_SLIDE_MAX_POINTS: 2,    // Hero slides should NOT have more than 2 points
    HERO_SLIDE_MAX_CHARS: 120    // Hero slides: short punchy text only
};

// =============================================================================
// LAYOUT-SPECIFIC QUALITY PROFILES
// =============================================================================
// Different layouts have different content expectations.
// Hero slides: LESS is MORE (Apple-style minimalism)
// Data slides: Dense but bounded (dashboard-tiles, bento-grid)

type LayoutQualityProfile = {
    minBullets: number;
    maxBullets: number;
    minTotalChars: number;
    maxTotalChars: number;
    minCharsPerPoint: number;
    maxCharsPerPoint: number;
    allowEmpty: boolean;  // Hero slides can have 0 bullets (just title)
};

const LAYOUT_QUALITY_PROFILES: Record<string, LayoutQualityProfile> = {
    'hero-centered': {
        minBullets: 0,           // Can be just a title
        maxBullets: 2,           // MAX 2 points for hero
        minTotalChars: 0,        // Title alone is fine
        maxTotalChars: 120,      // Short punchy text
        minCharsPerPoint: 10,
        maxCharsPerPoint: 60,
        allowEmpty: true
    },
    'split-left-text': {
        minBullets: 2,
        maxBullets: 4,
        minTotalChars: 80,
        maxTotalChars: 280,
        minCharsPerPoint: 20,
        maxCharsPerPoint: 70,
        allowEmpty: false
    },
    'split-right-text': {
        minBullets: 2,
        maxBullets: 4,
        minTotalChars: 80,
        maxTotalChars: 280,
        minCharsPerPoint: 20,
        maxCharsPerPoint: 70,
        allowEmpty: false
    },
    'bento-grid': {
        minBullets: 2,
        maxBullets: 3,           // Tight space
        minTotalChars: 60,
        maxTotalChars: 200,
        minCharsPerPoint: 15,
        maxCharsPerPoint: 50,
        allowEmpty: false
    },
    'dashboard-tiles': {
        minBullets: 2,
        maxBullets: 3,
        minTotalChars: 60,
        maxTotalChars: 180,
        minCharsPerPoint: 15,
        maxCharsPerPoint: 50,
        allowEmpty: false
    },
    'timeline-horizontal': {
        minBullets: 2,
        maxBullets: 4,
        minTotalChars: 80,
        maxTotalChars: 250,
        minCharsPerPoint: 15,
        maxCharsPerPoint: 60,
        allowEmpty: false
    },
    'asymmetric-grid': {
        minBullets: 2,
        maxBullets: 4,
        minTotalChars: 80,
        maxTotalChars: 280,
        minCharsPerPoint: 15,
        maxCharsPerPoint: 60,
        allowEmpty: false
    },
    'standard-vertical': {
        minBullets: 2,
        maxBullets: 5,
        minTotalChars: 100,
        maxTotalChars: 400,
        minCharsPerPoint: 20,
        maxCharsPerPoint: 80,
        allowEmpty: false
    },
    'metrics-rail': {
        minBullets: 1,
        maxBullets: 3,
        minTotalChars: 40,
        maxTotalChars: 200,
        minCharsPerPoint: 15,
        maxCharsPerPoint: 60,
        allowEmpty: false
    }
};

const getLayoutQualityProfile = (layoutId: string): LayoutQualityProfile => {
    return LAYOUT_QUALITY_PROFILES[layoutId] || LAYOUT_QUALITY_PROFILES['standard-vertical'];
};

// =============================================================================
// LAYOUT CONSTRAINTS (Character limits per layout) - For backward compat
// =============================================================================

export const LAYOUT_CONSTRAINTS: Record<string, {
    maxTitleChars: number;
    maxBullets: number;
    maxCharsPerBullet: number;
    minBullets: number;
}> = {
    'hero-centered': { maxTitleChars: 50, maxBullets: 2, maxCharsPerBullet: 50, minBullets: 0 },
    'split-left-text': { maxTitleChars: 40, maxBullets: 4, maxCharsPerBullet: 70, minBullets: 2 },
    'split-right-text': { maxTitleChars: 40, maxBullets: 4, maxCharsPerBullet: 70, minBullets: 2 },
    'bento-grid': { maxTitleChars: 45, maxBullets: 3, maxCharsPerBullet: 50, minBullets: 2 },
    'dashboard-tiles': { maxTitleChars: 50, maxBullets: 3, maxCharsPerBullet: 50, minBullets: 2 },
    'timeline-horizontal': { maxTitleChars: 50, maxBullets: 4, maxCharsPerBullet: 60, minBullets: 2 },
    'asymmetric-grid': { maxTitleChars: 50, maxBullets: 4, maxCharsPerBullet: 60, minBullets: 2 },
    'standard-vertical': { maxTitleChars: 60, maxBullets: 5, maxCharsPerBullet: 80, minBullets: 2 },
    'metrics-rail': { maxTitleChars: 50, maxBullets: 3, maxCharsPerBullet: 60, minBullets: 1 }
};

// =============================================================================
// CONTENT QUALITY EVALUATION (Bidirectional: THIN + FAT detection)
// =============================================================================

interface ContentQualityResult {
    passes: boolean;
    reason?: 'thin_content' | 'too_generic' | 'missing_specifics' | 'overflow' | 'too_many_points' | 'too_verbose';
    details?: string;
    suggestedQuery?: string;  // What to research if thin
    suggestedAction?: 'enrich' | 'prune' | 'summarize' | 'pass';
    overflowAmount?: number;  // For FAT content detection
}

/**
 * Evaluate content quality - BIDIRECTIONAL quality gate.
 * 
 * This is what makes Director non-linear:
 * - THIN content → triggers ENRICH loop (more research)
 * - FAT content → triggers PRUNE loop (summarization)
 * 
 * Layout-aware: Hero slides have INVERTED rules (less is more)
 */
function evaluateContentQuality(
    contentPlan: any,
    slideMeta: any,
    layoutId: string,
    isHeroSlide: boolean
): ContentQualityResult {
    const profile = getLayoutQualityProfile(layoutId);
    const keyPoints = contentPlan?.keyPoints || [];
    
    // Calculate content metrics
    const pointCount = keyPoints.length;
    const totalChars = keyPoints.reduce((sum: number, p: string) => sum + (p?.length || 0), 0);
    const avgCharsPerPoint = pointCount > 0 ? totalChars / pointCount : 0;
    const longestPoint = keyPoints.reduce((max: number, p: string) => Math.max(max, p?.length || 0), 0);

    // =========================================================================
    // HERO SLIDE: INVERTED RULES (Less is more, Apple-style)
    // =========================================================================
    if (isHeroSlide || layoutId === 'hero-centered') {
        // FAT CHECK: Hero slide has TOO MUCH content
        if (pointCount > profile.maxBullets) {
            return {
                passes: false,
                reason: 'too_many_points',
                details: `Hero slide has ${pointCount} points, max ${profile.maxBullets} for impact`,
                suggestedAction: 'prune'
            };
        }
        if (totalChars > profile.maxTotalChars) {
            return {
                passes: false,
                reason: 'too_verbose',
                details: `Hero slide has ${totalChars} chars, max ${profile.maxTotalChars} for punch`,
                suggestedAction: 'summarize',
                overflowAmount: totalChars - profile.maxTotalChars
            };
        }
        // Hero slides don't need THIN check - empty is OK
        return { passes: true, suggestedAction: 'pass' };
    }

    // =========================================================================
    // STANDARD SLIDES: BIDIRECTIONAL CHECKS
    // =========================================================================

    // FAT CHECK 1: Too many points (visual clutter)
    if (pointCount > profile.maxBullets) {
        return {
            passes: false,
            reason: 'too_many_points',
            details: `${pointCount} points exceeds ${profile.maxBullets} limit for ${layoutId}`,
            suggestedAction: 'prune'
        };
    }

    // FAT CHECK 2: Total content too long (overflow risk)
    if (totalChars > profile.maxTotalChars) {
        return {
            passes: false,
            reason: 'overflow',
            details: `${totalChars} chars exceeds ${profile.maxTotalChars} limit for ${layoutId}`,
            suggestedAction: 'summarize',
            overflowAmount: totalChars - profile.maxTotalChars
        };
    }

    // FAT CHECK 3: Individual points too long
    if (longestPoint > profile.maxCharsPerPoint) {
        return {
            passes: false,
            reason: 'too_verbose',
            details: `Longest point is ${longestPoint} chars, max ${profile.maxCharsPerPoint} for ${layoutId}`,
            suggestedAction: 'summarize'
        };
    }

    // THIN CHECK 1: Too few points
    if (pointCount < profile.minBullets && !profile.allowEmpty) {
        return {
            passes: false,
            reason: 'thin_content',
            details: `Only ${pointCount} points, need ${profile.minBullets} for ${layoutId}`,
            suggestedQuery: `specific details about ${slideMeta?.title || 'this topic'}`,
            suggestedAction: 'enrich'
        };
    }

    // THIN CHECK 2: Points too short (generic)
    if (avgCharsPerPoint < profile.minCharsPerPoint && pointCount > 0) {
        return {
            passes: false,
            reason: 'too_generic',
            details: `Average ${Math.round(avgCharsPerPoint)} chars/point, need ${profile.minCharsPerPoint}`,
            suggestedQuery: `detailed examples of ${slideMeta?.purpose || slideMeta?.title}`,
            suggestedAction: 'enrich'
        };
    }

    // THIN CHECK 3: Total content too sparse
    if (totalChars < profile.minTotalChars && !profile.allowEmpty) {
        return {
            passes: false,
            reason: 'missing_specifics',
            details: `Only ${totalChars} total chars, need ${profile.minTotalChars}`,
            suggestedQuery: `key facts and statistics about ${slideMeta?.title}`,
            suggestedAction: 'enrich'
        };
    }

    return { passes: true, suggestedAction: 'pass' };
}

// =============================================================================
// TARGETED RE-RESEARCH (Loop-back capability)
// =============================================================================

/**
 * Targeted research for a specific slide topic.
 * This is the KEY capability that makes Director non-linear.
 * Instead of re-running full research, we do a focused query.
 */
async function targetedResearch(
    query: string,
    existingFacts: ResearchFact[],
    costTracker: CostTracker
): Promise<ResearchFact[]> {
    console.log(`[DIRECTOR] Targeted re-research: "${query}"`);
    
    const { runResearcher } = await import('./agents/researcher');
    
    try {
        // Run focused research on the specific query
        const newFacts = await runResearcher(query, costTracker);
        
        // Merge with existing facts, avoiding duplicates
        const existingClaims = new Set(existingFacts.map(f => f.claim?.toLowerCase()));
        const uniqueNewFacts = newFacts.filter(f => 
            !existingClaims.has(f.claim?.toLowerCase())
        );
        
        console.log(`[DIRECTOR] Found ${uniqueNewFacts.length} new facts (${newFacts.length} total, ${newFacts.length - uniqueNewFacts.length} duplicates)`);
        
        return uniqueNewFacts;
    } catch (err: any) {
        console.warn(`[DIRECTOR] Targeted research failed: ${err.message}`);
        return [];
    }
}

// =============================================================================
// CONTENT PRUNING/SUMMARIZATION (Loop-back for OVERFLOW)
// =============================================================================

/**
 * Prune content when there are too many points.
 * Selects the most important points based on heuristics.
 */
function pruneContent(
    contentPlan: any,
    maxBullets: number,
    slideMeta: any
): any {
    const keyPoints = contentPlan?.keyPoints || [];
    if (keyPoints.length <= maxBullets) return contentPlan;

    console.log(`[DIRECTOR] Pruning ${keyPoints.length} points to ${maxBullets}`);

    // Heuristics for importance:
    // 1. Points with numbers/stats are usually more valuable
    // 2. Longer points are usually more substantive
    // 3. Points mentioning the slide title keywords are more relevant
    const titleKeywords = (slideMeta?.title || '').toLowerCase().split(/\s+/);
    
    const scored = keyPoints.map((point: string, idx: number) => {
        let score = 0;
        const lower = point.toLowerCase();
        
        // Stat detection (+3)
        if (/\d+%|\d+x|\$\d+|\d+\s*(million|billion|k\b)/i.test(point)) score += 3;
        
        // Keyword relevance (+2 per match)
        titleKeywords.forEach(kw => {
            if (kw.length > 3 && lower.includes(kw)) score += 2;
        });
        
        // Length bonus (longer = more substantive, up to +2)
        score += Math.min(2, Math.floor(point.length / 30));
        
        // First and last points often important (+1)
        if (idx === 0 || idx === keyPoints.length - 1) score += 1;
        
        return { point, score };
    });

    // Sort by score descending and take top N
    const pruned = scored
        .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
        .slice(0, maxBullets)
        .map((s: { point: string }) => s.point);

    return {
        ...contentPlan,
        keyPoints: pruned
    };
}

/**
 * Summarize content when text is too long.
 * Uses LLM to condense while preserving meaning.
 */
async function summarizeContent(
    contentPlan: any,
    profile: LayoutQualityProfile,
    costTracker: CostTracker
): Promise<any> {
    const keyPoints = contentPlan?.keyPoints || [];
    if (keyPoints.length === 0) return contentPlan;

    console.log(`[DIRECTOR] Summarizing content (target: ${profile.maxCharsPerPoint} chars/point)`);

    // For now, use a simple truncation + ellipsis approach
    // In production, you could call an LLM for smart summarization
    const summarized = keyPoints.map((point: string) => {
        if (point.length <= profile.maxCharsPerPoint) return point;
        
        // Smart truncation: try to break at word boundary
        const truncated = point.slice(0, profile.maxCharsPerPoint - 3);
        const lastSpace = truncated.lastIndexOf(' ');
        
        if (lastSpace > profile.maxCharsPerPoint * 0.7) {
            return truncated.slice(0, lastSpace) + '...';
        }
        return truncated + '...';
    });

    return {
        ...contentPlan,
        keyPoints: summarized
    };
}

// =============================================================================
// VISUAL VALIDATION (The "Eyes" - Visual Sensor Integration)
// =============================================================================

interface VisualValidationResult {
    fits: boolean;
    action?: 'prune' | 'summarize' | 'change_layout' | 'pass';
    reason?: string;
    failureCode?: VisualGateFailureCode;  // NEW: Structured failure code
}

/**
 * Visual Gate: Fast heuristic check using VisualSensor.quickFitCheck
 * 
 * This is the "Instrument Flight Rules" (IFR) check that catches
 * overflow issues that pure character counts might miss.
 * 
 * Returns structured failure codes for analytics and auto-remediation.
 * 
 * Example: "Configuration Management" might fit 25 chars but
 * "Configuration" wraps to a second line in narrow columns.
 */
function runVisualGate(
    contentPlan: any,
    layoutId: string,
    slideTitle: string,
    profile: LayoutQualityProfile
): VisualValidationResult {
    const keyPoints = contentPlan?.keyPoints || [];
    
    // Check title overflow first (common issue)
    if (slideTitle && slideTitle.length > profile.maxCharsPerPoint + 20) {
        return {
            fits: false,
            action: 'summarize',
            reason: `Title too long: ${slideTitle.length} chars (limit ~${profile.maxCharsPerPoint + 20})`,
            failureCode: 'TITLE_OVERFLOW'
        };
    }
    
    if (keyPoints.length === 0) {
        return { fits: true, action: 'pass' };
    }

    // Use VisualSensor's quickFitCheck for fast validation
    const fitResult = quickFitCheck(keyPoints, layoutId, profile.maxCharsPerPoint);

    if (!fitResult.fits) {
        // Parse reason to determine structured failure code
        const reason = fitResult.reason || '';
        let failureCode: VisualGateFailureCode = 'VISUAL_FIT_FAILED';
        let action: 'prune' | 'summarize' | 'change_layout' = 'summarize';
        
        if (reason.includes('bullets exceed') || reason.includes('bullet')) {
            failureCode = 'BULLET_TOO_LONG';
            action = 'summarize';
        } else if (reason.includes('chars exceed') || reason.includes('total')) {
            failureCode = 'TOTAL_CHARS_OVERFLOW';
            action = 'prune';
        } else if (reason.includes('exceed limit')) {
            failureCode = 'BODY_WRAP_EXCEEDED';
            action = 'prune';
        }
        
        console.log(`[DIRECTOR] Visual Gate FAILED: ${failureCode} - ${reason}`);
        return { fits: false, action, reason, failureCode };
    }

    return { fits: true, action: 'pass' };
}

/**
 * Determine if this slide should be visually validated.
 * 
 * RISK-BASED SAMPLING (fixes the "sampling gamble"):
 * - HIGH RISK layouts (bento-grid, dashboard-tiles): ALWAYS validate (100%)
 * - MEDIUM RISK layouts (standard-vertical, split-*): Use sampling rate
 * - LOW RISK layouts (hero-centered): Skip UNLESS title is very long (>40 chars)
 * 
 * This ensures complex layouts are always checked while simple ones don't waste time.
 */
function shouldValidateVisually(
    slideIndex: number,
    totalSlides: number,
    layoutId: string,
    slideTitle: string,
    config: DirectorConfig
): boolean {
    if (!config.enableVisualValidation) return false;
    
    const riskLevel = getLayoutRiskLevel(layoutId);
    
    // HIGH RISK: Always validate (100%)
    if (riskLevel === 'high') {
        console.log(`[DIRECTOR] Visual Gate: ALWAYS (high-risk layout: ${layoutId})`);
        return true;
    }
    
    // LOW RISK: Skip unless title is unusually long
    if (riskLevel === 'low') {
        const titleLength = slideTitle?.length || 0;
        if (titleLength > 40) {
            console.log(`[DIRECTOR] Visual Gate: YES (low-risk but long title: ${titleLength} chars)`);
            return true;
        }
        console.log(`[DIRECTOR] Visual Gate: SKIP (low-risk layout: ${layoutId})`);
        return false;
    }
    
    // MEDIUM RISK: Use sampling rate
    // Always validate first slide (title) and last slide (conclusion)
    if (slideIndex === 0 || slideIndex === totalSlides - 1) {
        console.log(`[DIRECTOR] Visual Gate: YES (first/last slide)`);
        return true;
    }
    
    // Sample based on config rate
    if (config.visualValidationSampling >= 1.0) return true;
    if (config.visualValidationSampling <= 0) return false;
    
    const sampleEvery = Math.ceil(1 / config.visualValidationSampling);
    const shouldValidate = slideIndex % sampleEvery === 0;
    console.log(`[DIRECTOR] Visual Gate: ${shouldValidate ? 'YES' : 'SKIP'} (medium-risk, sampling 1/${sampleEvery})`);
    return shouldValidate;
}

// =============================================================================
// EARLY ASSET EXTRACTION (Phase 4 - Latency Reduction)
// =============================================================================

/**
 * Generate a content ID for asset binding.
 * This prevents asset drift when Director modifies slides during drafting.
 * 
 * Content ID is based on slide title + purpose, so minor rewording still matches.
 * Major pivots (e.g., "Revenue Chart" → "Qualitative Goals") will NOT match.
 */
function generateContentId(title: string, purpose: string, slideType: string): string {
    // Normalize: lowercase, remove punctuation, take key words
    const normalize = (s: string) => (s || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 4)
        .sort()
        .join('_');
    
    return `${slideType}_${normalize(title)}_${normalize(purpose)}`;
}

/**
 * Check if two content IDs are semantically similar.
 * Allows for minor changes but catches major pivots.
 */
function contentIdMatches(originalId: string, finalId: string): boolean {
    if (originalId === finalId) return true;
    
    // Split into words and check overlap
    const originalWords = originalId.split('_').filter(w => w.length > 0);
    const finalWords = finalId.split('_').filter(w => w.length > 0);
    
    // Must have at least 50% word overlap to be considered a match
    const overlap = originalWords.filter(w => finalWords.includes(w)).length;
    const minRequired = Math.ceil(Math.max(originalWords.length, finalWords.length) * 0.5);
    
    return overlap >= minRequired;
}

interface AssetNeeds {
    imagePrompts: Array<{
        slideIndex: number;
        contentId: string;          // NEW: Content ID for drift detection
        prompt: string;
        style: string;
        originalTitle: string;      // NEW: For drift comparison
        originalPurpose: string;    // NEW: For drift comparison
    }>;
    chartSpecs: Array<{ slideIndex: number; contentId: string; type: string; data: any }>;
}

interface GeneratedAsset {
    imageUrl?: string;
    chartSvg?: string;
    contentId: string;              // NEW: Content ID for drift detection
    prompt: string;                 // NEW: For logging stale assets
}

/**
 * Extract image/chart needs from outline EARLY, before per-slide loop.
 * Now includes content IDs for drift detection.
 */
function extractAssetNeeds(
    outline: any,
    facts: ResearchFact[]
): AssetNeeds {
    const needs: AssetNeeds = { imagePrompts: [], chartSpecs: [] };
    
    const slides = outline.slides || [];
    slides.forEach((slide: any, idx: number) => {
        const slideType = slide.type || 'content-main';
        const title = slide.title || `Slide ${idx + 1}`;
        const purpose = slide.purpose || 'Content';
        const contentId = generateContentId(title, purpose, slideType);
        
        if (slideType === 'title-slide' || slideType === 'section-header') {
            needs.imagePrompts.push({
                slideIndex: idx,
                contentId,
                prompt: `Abstract professional background for: ${title}`,
                style: outline.styleGuide?.imageStyle || 'Corporate abstract',
                originalTitle: title,
                originalPurpose: purpose
            });
        }
        
        // Check if slide mentions data/stats that could be charts
        const purposeLower = purpose.toLowerCase();
        if (purposeLower.includes('data') || purposeLower.includes('stat') || purposeLower.includes('metric')) {
            const relevantFacts = facts.filter(f => 
                f.claim && /\d+%|\$\d+|\d+\s*(million|billion)/i.test(f.claim)
            ).slice(0, 4);
            
            if (relevantFacts.length >= 2) {
                needs.chartSpecs.push({
                    slideIndex: idx,
                    contentId,
                    type: 'bar-chart',
                    data: relevantFacts.map(f => ({
                        label: f.claim?.slice(0, 30) || 'Data',
                        value: f.claim?.match(/\d+/)?.[0] || '0'
                    }))
                });
            }
        }
    });

    console.log(`[DIRECTOR] Extracted asset needs: ${needs.imagePrompts.length} images, ${needs.chartSpecs.length} charts`);
    return needs;
}

// =============================================================================
// BACK-PRESSURE CONTROLLED IMAGE GENERATION
// =============================================================================

/**
 * Simple semaphore for concurrency control.
 * Prevents hitting API rate limits when generating many images.
 */
class Semaphore {
    private current = 0;
    private queue: Array<() => void> = [];
    
    constructor(private max: number) {}
    
    async acquire(): Promise<void> {
        if (this.current < this.max) {
            this.current++;
            return;
        }
        return new Promise<void>(resolve => {
            this.queue.push(resolve);
        });
    }
    
    release(): void {
        this.current--;
        const next = this.queue.shift();
        if (next) {
            this.current++;
            next();
        }
    }
}

/**
 * Generate assets in parallel with back-pressure control.
 * 
 * IMPROVEMENTS over original:
 * 1. Concurrency limit (maxConcurrent) prevents rate limiting
 * 2. Content IDs returned for drift detection at ASSEMBLE
 * 3. Promise returned early, can be awaited with timeout
 */
async function generateAssetsParallel(
    assetNeeds: AssetNeeds,
    costTracker: CostTracker,
    maxConcurrent: number = 3
): Promise<Map<number, GeneratedAsset>> {
    const results = new Map<number, GeneratedAsset>();
    
    if (assetNeeds.imagePrompts.length === 0 && assetNeeds.chartSpecs.length === 0) {
        return results;
    }

    console.log(`[DIRECTOR] Starting parallel asset generation (max ${maxConcurrent} concurrent)...`);
    const semaphore = new Semaphore(maxConcurrent);

    try {
        const { generateImageFromPrompt } = await import('./image/imageGeneration');
        
        const imagePromises = assetNeeds.imagePrompts.map(async (need) => {
            await semaphore.acquire();
            try {
                console.log(`[DIRECTOR] Generating image for slide ${need.slideIndex} (contentId: ${need.contentId.slice(0, 30)}...)`);
                const result = await generateImageFromPrompt(need.prompt, '16:9', costTracker);
                return {
                    slideIndex: need.slideIndex,
                    asset: {
                        imageUrl: result?.imageUrl,
                        contentId: need.contentId,
                        prompt: need.prompt
                    } as GeneratedAsset
                };
            } catch (err: any) {
                console.warn(`[DIRECTOR] Image generation failed for slide ${need.slideIndex}:`, err.message);
                return {
                    slideIndex: need.slideIndex,
                    asset: { contentId: need.contentId, prompt: need.prompt } as GeneratedAsset
                };
            } finally {
                semaphore.release();
            }
        });

        const imageResults = await Promise.all(imagePromises);
        imageResults.forEach(({ slideIndex, asset }) => {
            if (asset.imageUrl) {
                results.set(slideIndex, asset);
            }
        });

        console.log(`[DIRECTOR] Generated ${results.size}/${assetNeeds.imagePrompts.length} images`);
    } catch (err: any) {
        console.warn(`[DIRECTOR] Asset generation error:`, err.message);
    }

    return results;
}

/**
 * Wait for assets with timeout. Returns whatever is ready.
 * If timeout exceeded, returns partial results rather than blocking forever.
 */
async function waitForAssetsWithTimeout<T>(
    assetPromise: Promise<T>,
    timeoutMs: number,
    fallback: T
): Promise<{ result: T; timedOut: boolean }> {
    const timeoutPromise = new Promise<{ result: T; timedOut: true }>((resolve) => {
        setTimeout(() => resolve({ result: fallback, timedOut: true }), timeoutMs);
    });
    
    const resultPromise = assetPromise.then(result => ({ result, timedOut: false as const }));
    
    return Promise.race([resultPromise, timeoutPromise]);
}

// =============================================================================
// DIRECTOR ORCHESTRATOR (Non-Linear State Machine)
// =============================================================================

export interface DirectorOptions {
    topic: string;
    slideCount?: number;
    stylePreference?: 'corporate' | 'creative' | 'minimal' | 'data-heavy';
    config?: Partial<DirectorConfig>;  // Allow override of defaults
}

// =============================================================================
// PER-PHASE TIMING METRICS
// =============================================================================

interface PhaseTimings {
    research: number;     // Time in RESEARCH phase (ms)
    architect: number;    // Time in ARCHITECT phase (ms)
    assetExtract: number; // Time in ASSET_EXTRACTION phase (ms)
    perSlideLoop: number; // Total time in PER-SLIDE loop (ms)
    assemble: number;     // Time in ASSEMBLE phase (ms)
    assetWait: number;    // Time waiting for parallel assets (ms)
    total: number;        // Total end-to-end time (ms)
}

interface DirectorMetrics {
    totalEnrichments: number;
    slidesEnriched: number;
    totalPrunes: number;
    slidesPruned: number;
    visualValidations: number;
    visualFailures: number;
    visualGateFailures: VisualGateFailure[];  // NEW: Structured failure details
    assetsGenerated: number;
    assetsUsed: number;                       // NEW: Actually used (not stale)
    assetsStale: number;                      // NEW: Discarded due to drift
    enrichmentDetails: Array<{ slideIndex: number; reason: string; attempt: number }>;
    pruneDetails: Array<{ slideIndex: number; reason: string; attempt: number }>;
    slidePaths: Array<{ slideIndex: number; path: 'PASS' | 'ENRICH' | 'PRUNE' | 'SUMMARIZE' }>; // NEW: Path per slide
    timings: PhaseTimings;                    // NEW: Per-phase breakdown
}

/**
 * Run the Director - ADAPTIVE orchestrator with BIDIRECTIONAL loop-back.
 * 
 * Non-linear capabilities:
 * - THIN content → ENRICH loop (targeted re-research)
 * - FAT content → PRUNE/SUMMARIZE loop (content condensation)
 * - Layout-aware quality gates (hero slides have inverted rules)
 * - Visual Gate integration (quickFitCheck for overflow detection)
 * - Early asset extraction (parallel image generation)
 * - Risk-based visual sampling (high-risk layouts always validated)
 * - Asset drift detection (content IDs prevent stale image injection)
 * - Per-phase timing metrics (for latency optimization)
 */
export async function runDirector(
    options: DirectorOptions,
    costTracker: CostTracker,
    onProgress?: (status: string, percent?: number) => void
): Promise<DeckBlueprint> {
    const { topic, slideCount } = options;
    const config = resolveConfig(options.config);  // Use mode presets
    
    // Initialize timing tracker
    const phaseStart: Record<string, number> = {};
    const timings: PhaseTimings = {
        research: 0,
        architect: 0,
        assetExtract: 0,
        perSlideLoop: 0,
        assemble: 0,
        assetWait: 0,
        total: 0
    };
    const totalStartTime = Date.now();
    
    const metrics: DirectorMetrics = { 
        totalEnrichments: 0, 
        slidesEnriched: 0,
        totalPrunes: 0,
        slidesPruned: 0,
        visualValidations: 0,
        visualFailures: 0,
        visualGateFailures: [],
        assetsGenerated: 0,
        assetsUsed: 0,
        assetsStale: 0,
        enrichmentDetails: [],
        pruneDetails: [],
        slidePaths: [],
        timings
    };

    onProgress?.('Director: Starting adaptive orchestration...', 5);
    console.log(`[DIRECTOR] Adaptive orchestration for: "${topic}"`);
    console.log(`[DIRECTOR] Config: mode=${config.mode}, Visual=${config.enableVisualValidation}, Assets=${config.enableEarlyAssetExtraction}`);

    // Import existing agents (demoted to tools)
    const { runResearcher } = await import('./agents/researcher');
    const { runArchitect } = await import('./agents/architect');
    const { runRouter } = await import('./agents/router');
    const { runContentPlanner } = await import('./agents/contentPlanner');

    try {
        // =====================================================================
        // STATE: RESEARCH (Initial fact gathering)
        // =====================================================================
        phaseStart.research = Date.now();
        onProgress?.('Director: Researching topic...', 10);
        console.log(`[DIRECTOR] State: RESEARCH`);
        let facts = await runResearcher(topic, costTracker);
        timings.research = Date.now() - phaseStart.research;
        console.log(`[DIRECTOR] Initial research: ${facts.length} facts (${timings.research}ms)`);

        // =====================================================================
        // STATE: ARCHITECT (Plan narrative structure)
        // =====================================================================
        phaseStart.architect = Date.now();
        onProgress?.('Director: Planning narrative structure...', 25);
        console.log(`[DIRECTOR] State: ARCHITECT`);
        const outline = await runArchitect(topic, facts, costTracker);
        timings.architect = Date.now() - phaseStart.architect;
        console.log(`[DIRECTOR] Planned ${outline.slides?.length || 0} slides (${timings.architect}ms)`);

        // Enforce slide count if specified
        let slidesToGenerate = outline.slides || [];
        if (slideCount && slidesToGenerate.length !== slideCount) {
            slidesToGenerate = slidesToGenerate.slice(0, slideCount);
            while (slidesToGenerate.length < slideCount) {
                slidesToGenerate.push({
                    order: slidesToGenerate.length + 1,
                    type: 'content-main',
                    title: `Additional Slide ${slidesToGenerate.length + 1}`,
                    purpose: 'Supporting content'
                });
            }
        }

        // =====================================================================
        // STATE: EARLY ASSET EXTRACTION (Phase 4 - Parallel Generation)
        // =====================================================================
        let assetPromise: Promise<Map<number, GeneratedAsset>> | null = null;
        let extractedAssetNeeds: AssetNeeds | null = null;
        
        if (config.enableEarlyAssetExtraction) {
            phaseStart.assetExtract = Date.now();
            onProgress?.('Director: Extracting asset needs...', 28);
            console.log(`[DIRECTOR] State: ASSET_EXTRACTION (non-blocking)`);
            
            extractedAssetNeeds = extractAssetNeeds(outline, facts);
            timings.assetExtract = Date.now() - phaseStart.assetExtract;
            
            // Start asset generation in parallel with back-pressure control
            if (extractedAssetNeeds.imagePrompts.length > 0 || extractedAssetNeeds.chartSpecs.length > 0) {
                assetPromise = generateAssetsParallel(
                    extractedAssetNeeds,
                    costTracker,
                    config.maxConcurrentImages
                );
                metrics.assetsGenerated = extractedAssetNeeds.imagePrompts.length + extractedAssetNeeds.chartSpecs.length;
            }
        }

        // =====================================================================
        // STATE: PER-SLIDE LOOP (with quality-driven loop-back)
        // =====================================================================
        phaseStart.perSlideLoop = Date.now();
        const plannedSlides: any[] = [];
        const totalSlides = slidesToGenerate.length;

        for (let i = 0; i < totalSlides; i++) {
            const slideMeta = slidesToGenerate[i];
            const slideTitle = slideMeta?.title || `Slide ${i + 1}`;
            const isHeroSlide = i === 0 || i === totalSlides - 1 || slideMeta?.type === 'title-slide';
            
            const progressPct = totalSlides > 0
                ? 30 + Math.floor((i / totalSlides) * 50)
                : 30;
            onProgress?.(`Director: Processing slide ${i + 1}/${totalSlides}...`, progressPct);
            console.log(`[DIRECTOR] State: DRAFTING slide ${i + 1} "${slideTitle}"`);

            // -----------------------------------------------------------------
            // SUB-STATE: ROUTE (Select layout)
            // -----------------------------------------------------------------
            let routerDecision;
            try {
                routerDecision = await runRouter(slideMeta, costTracker);
            } catch (routeErr: any) {
                console.warn(`[DIRECTOR] Router failed for slide ${i + 1}:`, routeErr.message);
                routerDecision = { layoutVariant: 'standard-vertical' };
            }
            const layoutId = routerDecision?.layoutVariant || 'standard-vertical';
            const constraints = LAYOUT_CONSTRAINTS[layoutId] || LAYOUT_CONSTRAINTS['standard-vertical'];

            // -----------------------------------------------------------------
            // SUB-STATE: PLAN + EVALUATE + BIDIRECTIONAL LOOP
            // This is the NON-LINEAR part:
            // - THIN content → ENRICH (more research)
            // - FAT content → PRUNE/SUMMARIZE (condensation)
            // -----------------------------------------------------------------
            let contentPlan: any = null;
            let enrichmentAttempts = 0;
            let pruneAttempts = 0;
            let qualityResult: ContentQualityResult = { passes: false };
            const profile = getLayoutQualityProfile(layoutId);

            // BIDIRECTIONAL LOOP: Keep adjusting until quality passes or limits hit
            let totalAttempts = 0;
            const MAX_TOTAL_ATTEMPTS = 4; // Safety valve

            while (totalAttempts < MAX_TOTAL_ATTEMPTS) {
                totalAttempts++;

                // PLAN: Generate content (only on first attempt or after enrichment)
                if (!contentPlan || qualityResult.suggestedAction === 'enrich') {
                    try {
                        contentPlan = await runContentPlanner(
                            slideMeta,
                            factsToContext(facts, slideMeta),
                            costTracker,
                            [],
                            { maxBullets: constraints.maxBullets, maxCharsPerBullet: constraints.maxCharsPerBullet }
                        );
                    } catch (planErr: any) {
                        console.warn(`[DIRECTOR] ContentPlanner failed for slide ${i + 1}:`, planErr.message);
                        contentPlan = { keyPoints: [slideMeta?.purpose || 'Content'] };
                    }
                }

                // EVALUATE: Check content quality (bidirectional)
                qualityResult = evaluateContentQuality(contentPlan, slideMeta, layoutId, isHeroSlide);

                // VISUAL GATE: Risk-based visual validation
                // HIGH RISK layouts always validated; MEDIUM uses sampling; LOW skipped unless long title
                if (qualityResult.passes && shouldValidateVisually(i, totalSlides, layoutId, slideTitle, config)) {
                    metrics.visualValidations++;
                    const visualResult = runVisualGate(contentPlan, layoutId, slideTitle, profile);
                    
                    if (!visualResult.fits) {
                        console.log(`[DIRECTOR] Slide ${i + 1} FAILED Visual Gate: ${visualResult.failureCode} - ${visualResult.reason}`);
                        metrics.visualFailures++;
                        
                        // Record structured failure for analytics
                        if (visualResult.failureCode) {
                            // Map 'pass' to 'summarize' for the action field (should never happen but type safety)
                            const actionForLog = visualResult.action === 'pass' ? 'summarize' : (visualResult.action || 'summarize');
                            metrics.visualGateFailures.push({
                                code: visualResult.failureCode,
                                slideIndex: i + 1,
                                layoutId,
                                details: visualResult.reason || 'Unknown',
                                action: actionForLog as 'prune' | 'summarize' | 'change_layout'
                            });
                        }
                        
                        // Map visual action to quality action (change_layout → prune)
                        const mappedAction = visualResult.action === 'change_layout' ? 'prune' : visualResult.action;
                        
                        // Override quality result with visual failure
                        qualityResult = {
                            passes: false,
                            reason: 'overflow',
                            details: `Visual Gate: ${visualResult.reason}`,
                            suggestedAction: mappedAction || 'summarize'
                        };
                    } else {
                        console.log(`[DIRECTOR] Slide ${i + 1} PASSES Visual Gate`);
                    }
                }

                if (qualityResult.passes) {
                    console.log(`[DIRECTOR] Slide ${i + 1} content PASSES all quality gates`);
                    break; // Exit loop - content is good
                }

                // Handle based on suggested action
                const action = qualityResult.suggestedAction;
                
                // -------------------------------------------------------------
                // PATH A: ENRICH (Content too thin)
                // -------------------------------------------------------------
                if (action === 'enrich' && enrichmentAttempts < QUALITY_THRESHOLDS.MAX_ENRICHMENT_ATTEMPTS) {
                    console.log(`[DIRECTOR] Slide ${i + 1} content THIN: ${qualityResult.details}`);
                    console.log(`[DIRECTOR] State: ENRICH (attempt ${enrichmentAttempts + 1})`);
                    
                    const newFacts = await targetedResearch(
                        qualityResult.suggestedQuery || slideTitle,
                        facts,
                        costTracker
                    );
                    
                    if (newFacts.length > 0) {
                        facts = [...facts, ...newFacts];
                        metrics.totalEnrichments++;
                        metrics.enrichmentDetails.push({
                            slideIndex: i + 1,
                            reason: qualityResult.reason || 'unknown',
                            attempt: enrichmentAttempts + 1
                        });
                        enrichmentAttempts++;
                        continue; // Re-plan with enriched facts
                    } else {
                        console.log(`[DIRECTOR] No new facts found, accepting current content`);
                        break;
                    }
                }

                // -------------------------------------------------------------
                // PATH B: PRUNE (Too many points)
                // -------------------------------------------------------------
                if (action === 'prune' && pruneAttempts < QUALITY_THRESHOLDS.MAX_PRUNE_ATTEMPTS) {
                    console.log(`[DIRECTOR] Slide ${i + 1} content FAT: ${qualityResult.details}`);
                    console.log(`[DIRECTOR] State: PRUNE (attempt ${pruneAttempts + 1})`);
                    
                    contentPlan = pruneContent(contentPlan, profile.maxBullets, slideMeta);
                    metrics.totalPrunes++;
                    metrics.pruneDetails.push({
                        slideIndex: i + 1,
                        reason: qualityResult.reason || 'unknown',
                        attempt: pruneAttempts + 1
                    });
                    pruneAttempts++;
                    continue; // Re-evaluate after pruning
                }

                // -------------------------------------------------------------
                // PATH C: SUMMARIZE (Text too long)
                // -------------------------------------------------------------
                if (action === 'summarize' && pruneAttempts < QUALITY_THRESHOLDS.MAX_PRUNE_ATTEMPTS) {
                    console.log(`[DIRECTOR] Slide ${i + 1} content VERBOSE: ${qualityResult.details}`);
                    console.log(`[DIRECTOR] State: SUMMARIZE (attempt ${pruneAttempts + 1})`);
                    
                    contentPlan = await summarizeContent(contentPlan, profile, costTracker);
                    metrics.totalPrunes++;
                    metrics.pruneDetails.push({
                        slideIndex: i + 1,
                        reason: qualityResult.reason || 'unknown',
                        attempt: pruneAttempts + 1
                    });
                    pruneAttempts++;
                    continue; // Re-evaluate after summarizing
                }

                // No more actions available, accept current content
                console.log(`[DIRECTOR] Slide ${i + 1} reached action limits, accepting content`);
                break;
            }

            // Track if this slide was enriched or pruned
            if (enrichmentAttempts > 0 && metrics.enrichmentDetails.some(d => d.slideIndex === i + 1)) {
                metrics.slidesEnriched++;
                metrics.slidePaths.push({ slideIndex: i + 1, path: 'ENRICH' });
            } else if (pruneAttempts > 0 && metrics.pruneDetails.some(d => d.slideIndex === i + 1)) {
                metrics.slidesPruned++;
                // Determine if it was PRUNE or SUMMARIZE based on last action
                const lastAction = metrics.pruneDetails.filter(d => d.slideIndex === i + 1).pop();
                metrics.slidePaths.push({ slideIndex: i + 1, path: lastAction?.reason === 'too_verbose' ? 'SUMMARIZE' : 'PRUNE' });
            } else {
                metrics.slidePaths.push({ slideIndex: i + 1, path: 'PASS' });
            }

            // Log final quality status
            if (!qualityResult.passes) {
                const actionsTaken = [];
                if (enrichmentAttempts > 0) actionsTaken.push(`${enrichmentAttempts} enrichments`);
                if (pruneAttempts > 0) actionsTaken.push(`${pruneAttempts} prunes`);
                console.warn(`[DIRECTOR] Slide ${i + 1} accepted after ${actionsTaken.join(' + ') || 'no actions'}`);
            }

            // -----------------------------------------------------------------
            // ASSEMBLE: Add slide to output (with content ID for drift detection)
            // -----------------------------------------------------------------
            const slideType = slideMeta?.type || 'content-main';
            const finalContentId = generateContentId(slideTitle, slideMeta?.purpose || 'Content', slideType);
            
            plannedSlides.push({
                order: i + 1,
                layoutId,
                title: slideTitle,
                purpose: slideMeta?.purpose || 'Content',
                components: contentPlanToComponents(contentPlan),
                imagePrompts: [],
                speakerNotes: '',
                enrichmentAttempts,
                _contentId: finalContentId  // Internal: for asset drift detection
            });
        }
        
        timings.perSlideLoop = Date.now() - phaseStart.perSlideLoop;
        console.log(`[DIRECTOR] Per-slide loop complete (${timings.perSlideLoop}ms)`);

        // =====================================================================
        // STATE: ASSEMBLE (Final blueprint with asset drift detection)
        // =====================================================================
        phaseStart.assemble = Date.now();
        onProgress?.('Director: Assembling blueprint...', 90);
        console.log(`[DIRECTOR] State: ASSEMBLE`);
        
        // Collect parallel-generated assets with timeout (handles race condition)
        let generatedAssets: Map<number, GeneratedAsset> = new Map();
        if (assetPromise) {
            phaseStart.assetWait = Date.now();
            console.log(`[DIRECTOR] Waiting for parallel assets (timeout: ${config.assetGenerationTimeout}ms)...`);
            
            const { result, timedOut } = await waitForAssetsWithTimeout(
                assetPromise,
                config.assetGenerationTimeout,
                new Map<number, GeneratedAsset>()
            );
            
            timings.assetWait = Date.now() - phaseStart.assetWait;
            generatedAssets = result;
            
            if (timedOut) {
                console.warn(`[DIRECTOR] ⚠️ Asset generation timed out after ${config.assetGenerationTimeout}ms. Proceeding with ${generatedAssets.size} ready assets.`);
            } else {
                console.log(`[DIRECTOR] Collected ${generatedAssets.size} pre-generated assets (${timings.assetWait}ms)`);
            }
        }

        // Inject assets into slides WITH DRIFT DETECTION
        // Compare final slide content ID vs original asset content ID
        for (const slide of plannedSlides) {
            const asset = generatedAssets.get(slide.order - 1);
            if (asset?.imageUrl) {
                const finalContentId = slide._contentId;
                const assetContentId = asset.contentId;
                
                // Check if content has drifted (slide was significantly modified during drafting)
                if (contentIdMatches(assetContentId, finalContentId)) {
                    slide.imagePrompts = [asset.imageUrl];
                    metrics.assetsUsed++;
                    console.log(`[DIRECTOR] Slide ${slide.order}: Asset matched ✓`);
                } else {
                    // STALE ASSET: Content drifted, discard the pre-generated image
                    metrics.assetsStale++;
                    console.warn(`[DIRECTOR] Slide ${slide.order}: Asset STALE (drift detected)`);
                    console.warn(`  Original: ${assetContentId.slice(0, 50)}...`);
                    console.warn(`  Final:    ${finalContentId.slice(0, 50)}...`);
                    console.warn(`  Discarding pre-generated image. Slide will render without background.`);
                    // Don't inject the stale image - leave imagePrompts empty
                }
            }
            
            // Clean up internal content ID (not needed in final output)
            delete slide._contentId;
        }
        
        timings.assemble = Date.now() - phaseStart.assemble;
        timings.total = Date.now() - totalStartTime;

        // Log comprehensive metrics with timing breakdown
        console.log(`[DIRECTOR] ═══════════════════════════════════════════════════════`);
        console.log(`[DIRECTOR] Quality Loop Summary:`);
        console.log(`  - Enrichments: ${metrics.totalEnrichments} across ${metrics.slidesEnriched} slides`);
        console.log(`  - Prunes/Summarizations: ${metrics.totalPrunes} across ${metrics.slidesPruned} slides`);
        console.log(`  - Visual validations: ${metrics.visualValidations} (${metrics.visualFailures} failures)`);
        console.log(`  - Visual gate failures: ${metrics.visualGateFailures.map(f => f.code).join(', ') || 'none'}`);
        console.log(`  - Slide paths: ${metrics.slidePaths.map(s => `${s.slideIndex}:${s.path}`).join(', ')}`);
        console.log(`[DIRECTOR] Asset Summary:`);
        console.log(`  - Generated: ${metrics.assetsGenerated}`);
        console.log(`  - Used: ${metrics.assetsUsed}`);
        console.log(`  - Stale (discarded): ${metrics.assetsStale}`);
        console.log(`[DIRECTOR] Timing Breakdown:`);
        console.log(`  - Research: ${timings.research}ms`);
        console.log(`  - Architect: ${timings.architect}ms`);
        console.log(`  - Asset Extract: ${timings.assetExtract}ms`);
        console.log(`  - Per-Slide Loop: ${timings.perSlideLoop}ms`);
        console.log(`  - Asset Wait: ${timings.assetWait}ms`);
        console.log(`  - Assemble: ${timings.assemble}ms`);
        console.log(`  - TOTAL: ${timings.total}ms`);
        console.log(`[DIRECTOR] ═══════════════════════════════════════════════════════`);

        const blueprint: DeckBlueprint = {
            narrativeGoal: outline.narrativeGoal || `Inform about ${topic}`,
            title: outline.title || topic,
            styleGuide: outline.styleGuide || getDefaultStyleGuide(),
            slides: plannedSlides,
            researchSummary: `Facts: ${facts.length}. Loops: ${metrics.totalEnrichments} enrichments, ${metrics.totalPrunes} prunes. Visual checks: ${metrics.visualValidations} (${metrics.visualFailures} failures). Assets: ${metrics.assetsUsed}/${metrics.assetsGenerated} used (${metrics.assetsStale} stale). Total: ${timings.total}ms.`,
            metrics: {
                totalEnrichments: metrics.totalEnrichments,
                slidesEnriched: metrics.slidesEnriched
            }
        };

        // Validate blueprint
        const parseResult = DeckBlueprintSchema.safeParse(blueprint);
        if (parseResult.success) {
            onProgress?.('Director: Complete!', 100);
            console.log(`[DIRECTOR] Blueprint complete: ${parseResult.data.slides.length} slides`);
            return parseResult.data;
        }
        
        console.warn('[DIRECTOR] Blueprint validation failed, using fallback');
        return createFallbackBlueprint(topic);

    } catch (error: any) {
        console.error('[DIRECTOR] Orchestration failed:', error.message);
        return createFallbackBlueprint(topic);
    }
}

/**
 * Convert facts to context string for content planner
 */
function factsToContext(facts: ResearchFact[], slideMeta: any): string {
    if (!facts || facts.length === 0) return '';

    // Get relevant facts based on slide title/purpose
    const keywords = (slideMeta.title + ' ' + slideMeta.purpose).toLowerCase().split(/\s+/);
    const relevant = facts.filter(f =>
        keywords.some(kw => f.claim?.toLowerCase().includes(kw))
    ).slice(0, 4);

    if (relevant.length === 0) {
        return facts.slice(0, 3).map(f => `- ${f.claim}`).join('\n');
    }

    return relevant.map(f => `- ${f.claim}`).join('\n');
}

/**
 * Convert ContentPlanResult to component array
 */
function contentPlanToComponents(contentPlan: any): any[] {
    if (!contentPlan) return [];

    const components: any[] = [];

    if (contentPlan.keyPoints?.length > 0) {
        components.push({
            type: 'text-bullets',
            zoneId: 'body',
            content: { items: contentPlan.keyPoints }
        });
    }

    if (contentPlan.dataPoints?.length > 0) {
        components.push({
            type: 'metric-cards',
            zoneId: 'metrics',
            content: {
                metrics: contentPlan.dataPoints.map((dp: any) => ({
                    label: dp.label,
                    value: String(dp.value)
                }))
            }
        });
    }

    return components.length > 0 ? components : [{
        type: 'text-bullets',
        zoneId: 'body',
        content: { items: ['Content'] }
    }];
}

function getDefaultStyleGuide() {
    return {
        themeName: 'Corporate Navy',
        fontFamilyTitle: 'Inter',
        fontFamilyBody: 'Inter',
        colorPalette: {
            primary: '#10b981',
            secondary: '#3b82f6',
            background: '#0f172a',
            text: '#f8fafc',
            accent: '#f59e0b'
        },
        imageStyle: 'Clean abstract',
        layoutStrategy: 'Balanced'
    };
}

function createFallbackBlueprint(topic: string): DeckBlueprint {
    return {
        narrativeGoal: `About ${topic}`,
        title: topic,
        styleGuide: getDefaultStyleGuide(),
        slides: [
            { order: 1, layoutId: 'hero-centered', title: topic, purpose: 'Title', components: [] },
            { order: 2, layoutId: 'standard-vertical', title: 'Overview', purpose: 'Content', components: [] },
            { order: 3, layoutId: 'hero-centered', title: 'Conclusion', purpose: 'End', components: [] }
        ]
    };
}

export function extractSlideCount(topic: string): number | undefined {
    const match = topic.match(/(\d{1,2})\s*(slides?|pages?)/i);
    return match ? Math.min(15, Math.max(4, parseInt(match[1], 10))) : undefined;
}
