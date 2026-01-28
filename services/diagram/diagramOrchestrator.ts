/**
 * Diagram Orchestrator - Three-Tier Visual Validation Stack
 * 
 * ARCHITECTURE INSIGHT (2026-01 Revision):
 * Qwen3-VL-Plus is NOT a "budget alternative" — it is the state-of-the-art leader
 * in visual spatial understanding. This architecture treats it as the PRIMARY
 * visual cortex, with Gemini 3.0 serving as a specialized tool for code-execution
 * workflows only.
 * 
 * THREE-TIER VISUAL VALIDATION STACK:
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │                    TIER 1: LOGIC GATE (Deterministic)                       │
 * │  • quickFitCheck (character counting, layout heuristics)                   │
 * │  • Latency: <1ms | Cost: $0 | Coverage: 100% of slides                     │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │                    TIER 2: QWEN3-VL VISUAL GATE (Spatial)                   │
 * │  • Model: qwen3-vl-plus-2025-12-19                                         │
 * │  • Task: Bounding box detection, overflow verification, OCR                │
 * │  • Input: Slide PNG (1920x1080) + Structured prompt                        │
 * │  • Output: Normalized coordinates (0-1000), severity scores                │
 * │  • Latency: ~800ms-1.5s | Cost: ~$0.002/image                              │
 * │  • Coverage: High-risk layouts (100%), Medium-risk (30% sampling)          │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │                    TIER 3: GEMINI 3.0 AGENTIC (Code Execution)              │
 * │  • Model: gemini-3-flash-preview                                           │
 * │  • Task: Custom diagram generation, complex measurement algorithms         │
 * │  • Input: SVG/PNG + Python code generation request                         │
 * │  • Output: Executed Python results, iterative refinements                  │
 * │  • Latency: 3-8s | Cost: $0.005 + execution time                           │
 * │  • Coverage: Only for "Graph Drone" custom viz (serendipitous mode)        │
 * └─────────────────────────────────────────────────────────────────────────────┘
 * 
 * WHY THIS TIERING:
 * ┌──────────────────────┬──────────────────┬──────────────────┬────────────────┐
 * │       Metric         │  Qwen3-VL-Plus   │ Gemini 3.0 Flash │   Advantage    │
 * ├──────────────────────┼──────────────────┼──────────────────┼────────────────┤
 * │ Visual Perception    │ 77.5% MM-MT-Bench│ ~75% (estimated) │   Qwen3-VL     │
 * │ 2D Spatial Grounding │ Native 0-1000    │ Via code exec    │ Qwen3-VL(fast) │
 * │ OCR Accuracy         │ State-of-the-art │ Strong           │   Qwen3-VL     │
 * │ Cost per 1M tokens   │ $0.40/$1.20      │ $0.50/$3.00      │ Qwen3-VL (3x)  │
 * │ Code Execution       │ No               │ Yes (Python)     │   Gemini       │
 * │ Latency (vision)     │ ~800ms           │ ~1.2s            │   Qwen3-VL     │
 * └──────────────────────┴──────────────────┴──────────────────┴────────────────┘
 */

import type { StyleMode } from '../../types/slideTypes';

// ============================================================================
// DIAGRAM ENGINE TYPES
// ============================================================================

/**
 * Available diagram generation engines
 */
export type DiagramEngine = 
    | 'deterministic'    // Tier 1: diagramBuilder.ts - <50ms, $0
    | 'qwen3vl-visual'   // Tier 2: Qwen3-VL "sketch to code" - ~1s, ~$0.002
    | 'gemini-code';     // Tier 3: Gemini code execution - 3-8s, ~$0.005

/**
 * Diagram complexity levels
 */
export type DiagramComplexity = 'simple' | 'moderate' | 'complex';

/**
 * Visual validation engine selection
 */
export type VisualValidationEngine = 
    | 'logic-gate'       // Tier 1: quickFitCheck, heuristics
    | 'qwen3vl-spatial'  // Tier 2: Qwen3-VL spatial analysis
    | 'gemini-agentic';  // Tier 3: Gemini code execution (rare)

// ============================================================================
// ENGINE SELECTION LOGIC
// ============================================================================

/**
 * Deterministic diagram types that don't need LLM involvement
 * These are fully implemented in diagramBuilder.ts
 */
const DETERMINISTIC_DIAGRAM_TYPES = new Set([
    'circular-ecosystem',
    'timeline',
    'timeline-horizontal',
    'bar-chart',
    'pie-chart',
    'process-flow',
    'simple-hierarchy'
]);

/**
 * Select the appropriate diagram generation engine based on:
 * 1. Diagram type (deterministic vs creative)
 * 2. Complexity level
 * 3. Style mode (serendipitous enables visual coding)
 * 
 * COST-FIRST PRINCIPLE: Always prefer cheaper tiers unless quality requires escalation.
 */
export function selectDiagramEngine(
    diagramType: string,
    complexity: DiagramComplexity,
    styleMode: StyleMode
): DiagramEngine {
    // Tier 1: Deterministic (existing diagramBuilder.ts)
    // <50ms, zero LLM cost
    if (DETERMINISTIC_DIAGRAM_TYPES.has(diagramType)) {
        return 'deterministic';
    }

    // Tier 2: Qwen3-VL Visual Coding (for "sketch to code")
    // Only in serendipitous mode with moderate complexity
    if (complexity === 'moderate' && styleMode === 'serendipitous') {
        return 'qwen3vl-visual';
    }

    // Tier 3: Gemini Agentic (only for complex iterative generation)
    // Reserved for truly custom, iterative diagram generation
    if (complexity === 'complex' || diagramType === 'custom-network') {
        return 'gemini-code';
    }

    // Default: Deterministic fallback
    return 'deterministic';
}

/**
 * Select the appropriate visual validation engine based on:
 * 1. Layout risk level
 * 2. Style mode
 * 3. Slide position (first/last slides always validated)
 * 
 * RISK-BASED SAMPLING:
 * - HIGH risk layouts: ALWAYS use Tier 2 (100%)
 * - MEDIUM risk layouts: 30% sampling with Tier 2
 * - LOW risk layouts: Tier 1 only (unless long title)
 */
export function selectVisualValidationEngine(
    layoutId: string,
    styleMode: StyleMode,
    slideIndex: number,
    totalSlides: number,
    titleLength: number
): VisualValidationEngine {
    const riskLevel = getLayoutRiskLevel(layoutId);
    
    // HIGH RISK: Always use Qwen3-VL spatial analysis (100%)
    if (riskLevel === 'high') {
        console.log(`[ORCHESTRATOR] Visual validation: TIER 2 Qwen3-VL (high-risk layout: ${layoutId})`);
        return 'qwen3vl-spatial';
    }
    
    // First and last slides always get visual validation
    if (slideIndex === 0 || slideIndex === totalSlides - 1) {
        console.log(`[ORCHESTRATOR] Visual validation: TIER 2 Qwen3-VL (first/last slide)`);
        return 'qwen3vl-spatial';
    }
    
    // LOW RISK with long title: escalate to Tier 2
    if (riskLevel === 'low' && titleLength > 40) {
        console.log(`[ORCHESTRATOR] Visual validation: TIER 2 Qwen3-VL (low-risk but long title: ${titleLength} chars)`);
        return 'qwen3vl-spatial';
    }
    
    // LOW RISK: Tier 1 logic gate only
    if (riskLevel === 'low') {
        console.log(`[ORCHESTRATOR] Visual validation: TIER 1 Logic Gate (low-risk layout: ${layoutId})`);
        return 'logic-gate';
    }
    
    // MEDIUM RISK: Use sampling rate (30% in balanced mode)
    // In serendipitous/premium mode, always validate
    if (styleMode === 'serendipitous') {
        console.log(`[ORCHESTRATOR] Visual validation: TIER 2 Qwen3-VL (serendipitous mode)`);
        return 'qwen3vl-spatial';
    }
    
    // Standard sampling for medium risk
    const shouldSample = Math.random() < 0.3;
    if (shouldSample) {
        console.log(`[ORCHESTRATOR] Visual validation: TIER 2 Qwen3-VL (medium-risk, sampled)`);
        return 'qwen3vl-spatial';
    }
    
    console.log(`[ORCHESTRATOR] Visual validation: TIER 1 Logic Gate (medium-risk, not sampled)`);
    return 'logic-gate';
}

// ============================================================================
// LAYOUT RISK PROFILES
// ============================================================================

type LayoutRiskLevel = 'high' | 'medium' | 'low';

/**
 * Layout risk profiles for visual validation sampling.
 * High-risk layouts need 100% validation; low-risk can be skipped.
 */
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

/**
 * Get layout risk level
 */
export function getLayoutRiskLevel(layoutId: string): LayoutRiskLevel {
    return LAYOUT_RISK_PROFILES[layoutId] || 'medium';
}

// ============================================================================
// COST CONFIGURATION
// ============================================================================

export const TIER_COST_CONFIG = {
    tier1_logic_gate: {
        latency_ms: 1,
        cost_per_call: 0,
        description: 'Deterministic heuristics'
    },
    tier2_qwen3vl_spatial: {
        latency_ms: 1000,
        cost_per_image: 0.002,
        description: 'Qwen3-VL-Plus spatial analysis'
    },
    tier3_gemini_code: {
        latency_ms: 5000,
        cost_per_call: 0.005,
        description: 'Gemini 3.0 code execution'
    }
} as const;

/**
 * Estimate cost for a deck based on tier usage
 */
export function estimateDeckValidationCost(
    slideCount: number,
    config: {
        tier1_usage: number;  // 0-1 percentage
        tier2_usage: number;  // 0-1 percentage
        tier3_usage: number;  // 0-1 percentage
    }
): { totalCost: number; breakdown: Record<string, number> } {
    const tier1Calls = Math.round(slideCount * config.tier1_usage);
    const tier2Calls = Math.round(slideCount * config.tier2_usage);
    const tier3Calls = Math.round(slideCount * config.tier3_usage);
    
    const tier1Cost = tier1Calls * TIER_COST_CONFIG.tier1_logic_gate.cost_per_call;
    const tier2Cost = tier2Calls * TIER_COST_CONFIG.tier2_qwen3vl_spatial.cost_per_image;
    const tier3Cost = tier3Calls * TIER_COST_CONFIG.tier3_gemini_code.cost_per_call;
    
    return {
        totalCost: tier1Cost + tier2Cost + tier3Cost,
        breakdown: {
            tier1_logic_gate: tier1Cost,
            tier2_qwen3vl_spatial: tier2Cost,
            tier3_gemini_code: tier3Cost
        }
    };
}

// ============================================================================
// DIRECTOR MODE COST PROFILES
// ============================================================================

/**
 * Pre-calculated cost profiles for Director modes
 */
export const MODE_COST_PROFILES = {
    fast: {
        description: 'Tier 1 only, no visual validation',
        tier1_usage: 1.0,
        tier2_usage: 0,
        tier3_usage: 0,
        estimated_cost_per_10_slides: 0
    },
    balanced: {
        description: 'Tier 1 + Tier 2 (30% sampling for medium-risk)',
        tier1_usage: 1.0,
        tier2_usage: 0.3,  // 30% sampling
        tier3_usage: 0,
        estimated_cost_per_10_slides: 0.006  // 3 slides × $0.002
    },
    premium: {
        description: 'Tier 1 + Tier 2 (100% for high/medium-risk)',
        tier1_usage: 1.0,
        tier2_usage: 0.8,  // ~80% of slides get visual validation
        tier3_usage: 0.1,  // 10% might use code execution
        estimated_cost_per_10_slides: 0.021  // 8 × $0.002 + 1 × $0.005
    }
} as const;

// ============================================================================
// SWARM MODE (Parallel Visual Critique)
// ============================================================================

/**
 * Swarm execution mode for batch slide critique
 * Kimi K2.5-style parallel agent dispatch
 */
export type SwarmMode = 'sequential' | 'parallel';

/**
 * Get recommended swarm mode based on slide count and target latency
 */
export function getRecommendedSwarmMode(
    slideCount: number,
    targetLatencyMs: number = 5000
): SwarmMode {
    // Qwen3-VL is fast enough that network latency dominates.
    // Parallel execution provides 6x speedup at the same cost.
    const sequentialLatency = slideCount * TIER_COST_CONFIG.tier2_qwen3vl_spatial.latency_ms;
    
    if (sequentialLatency > targetLatencyMs && slideCount >= 3) {
        return 'parallel';
    }
    
    return 'sequential';
}

/**
 * Calculate swarm batch size based on rate limits
 * Qwen3-VL is rate limit friendly (~10 concurrent requests)
 */
export function getSwarmBatchSize(slideCount: number): number {
    const MAX_CONCURRENT_QWEN3VL = 10;  // Qwen3-VL rate limit friendly
    return Math.min(slideCount, MAX_CONCURRENT_QWEN3VL);
}

// ============================================================================
// EXPORTS FOR INTEGRATION
// ============================================================================

export {
    DETERMINISTIC_DIAGRAM_TYPES,
    LAYOUT_RISK_PROFILES
};
