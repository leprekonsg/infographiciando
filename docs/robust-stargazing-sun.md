# System 2 Visual-Aware Architecture Enhancement Plan

## Executive Summary

Upgrade the existing System 2 implementation from single-shot visual critique to true recursive refinement with high-fidelity spatial analysis.

**Current State:** System 2 runs once per slide, SVG proxy shows only zone boxes with type codes
**Target State:** Recursive visual critique loop with content-aware SVG proxies showing actual text/metrics

**Impact:**
- Cost: +$0.008-$0.012 per deck (4-7% increase, down from projected 8%)
- Quality: 15-25% improvement in visual alignment scores
- Recursion depth: 2-3 rounds average (controlled by score threshold)

---

## Critical Files

| File | Changes | LoC Impact |
|------|---------|------------|
| `services/visualDesignAgent.ts` | Enhanced SVG proxy generation, critique loop | +120, ~30 modified |
| `services/slideAgentService.ts` | Recursive System 2 integration, metrics tracking | ~50 modified |
| `types/slideTypes.ts` | Threshold constants, critique result types | +15 |
| `services/interactionsClient.ts` | Model constant export consolidation | ~5 modified |
| `services/validators.ts` | Zod post-validation wrapper | +25 |

---

## Architecture Decisions

### Decision 1: SVG Proxy Fidelity - Content-Aware Rendering

**Problem:** Current SVG proxy only shows zone bounding boxes with component type codes (TB, MC, etc.), preventing effective spatial critique.

**Solution:** Generate SVG proxy from compiled VisualElement[] instead of raw zone templates.

**Approach:**
```typescript
// BEFORE (current):
svg += `<text>${compCode}</text>`  // Just "TB" for text-bullets

// AFTER (proposed):
const elements = layoutEngine.renderWithSpatialAwareness(slide, styleGuide, getIconUrl);
elements.forEach(el => {
  if (el.type === 'text') {
    svg += `<text x="${el.x*100}" fontSize="${el.fontSize}" fill="${el.color}">${truncate(el.content, 50)}</text>`;
  } else if (el.type === 'shape') {
    svg += `<rect x="${el.x*100}" fill="${el.fill?.color}"/>`;
  }
});
```

**Rationale:**
- VisualElement[] already contains exact positions, font sizes, colors, text content
- Compiled by SpatialLayoutEngine after affinity allocation (same rendering engine used for PPTX export)
- Critique agent can assess actual overlap, contrast, density, not hypothetical zones

**Trade-offs:**
- **Pro:** Critique sees what user sees; detects real layout issues
- **Pro:** Reuses existing rendering logic (no duplication)
- **Con:** SVG proxy grows 3-5x larger (~2KB → 8KB per slide)
- **Con:** Requires IconCache initialization for icon rendering (adds dependency)

**Decision:** Proceed with content-aware approach. 8KB SVG is trivial cost vs critique accuracy.

---

### Decision 2: Recursion Strategy - Bounded Loop with Score Convergence

**Problem:** Current implementation runs visual critique once, no recursion.

**Solution:** Implement bounded recursive loop (MAX_ROUNDS=3) until score ≥ threshold or exhaustion.

**Approach:**
```typescript
const MAX_VISUAL_ROUNDS = 3;
const TARGET_SCORE = 85;
let round = 0;

while (round < MAX_VISUAL_ROUNDS && validation.score < TARGET_SCORE) {
  round++;
  const critique = await runVisualCritique(candidate, svgProxy, costTracker);

  if (critique.overallScore >= TARGET_SCORE) break;

  if (critique.hasCriticalIssues || critique.overallScore < REPAIR_THRESHOLD) {
    candidate = await runLayoutRepair(candidate, critique, svgProxy, costTracker);
    candidate = autoRepairSlide(candidate);
    validation = validateSlide(candidate);
    svgProxy = generateSvgProxy(candidate);  // Re-render after repair
  } else {
    break;  // No critical issues, acceptable score
  }
}
```

**Rationale:**
- Matches established MAX_ATTEMPTS pattern (runVisualDesigner uses 2, runGenerator uses 2)
- Score-based convergence prevents infinite loops
- Re-generates SVG proxy after each repair (crucial for accurate re-critique)
- Tracks round count for metrics

**Trade-offs:**
- **Pro:** True recursive refinement, can fix issues iteratively
- **Pro:** Fails gracefully (returns best attempt after MAX_ROUNDS)
- **Con:** 3x API calls on worst-case path (critique → repair → critique → repair → critique)
- **Con:** Adds 0.5-1.5s latency per slide

**Decision:** MAX_ROUNDS=3 balances quality vs cost. Most slides converge in 1-2 rounds.

---

### Decision 3: Threshold System - Tiered Activation Hierarchy

**Problem:** Three overlapping thresholds create dead zones (scores 70-84 trigger critique but not repair).

**Current State:**
```typescript
const VISUAL_CRITIQUE_THRESHOLD = 85;      // Trigger critique
if (critique.overallScore < 70 || ...) {   // Trigger repair
```

**Solution:** Define clear threshold hierarchy with semantic meaning.

**Proposed Constants:**
```typescript
// System 2 Activation Thresholds
const THRESHOLDS = {
  EXCELLENT: 95,        // No critique needed (rare, ~5% of slides)
  TARGET: 85,           // Critique activation point
  REPAIR_REQUIRED: 70,  // Force repair attempt
  CRITICAL: 60,         // Multiple critical issues, aggressive repair
  FALLBACK: 50          // Give up, use text-bullets fallback
};

// Activation logic
if (score >= THRESHOLDS.TARGET) {
  // Skip System 2
} else if (score >= THRESHOLDS.REPAIR_REQUIRED) {
  // Critique only, no repair (informational warnings)
} else if (score >= THRESHOLDS.CRITICAL) {
  // Standard repair
} else {
  // Aggressive repair or fallback
}
```

**Rationale:**
- Eliminates 70-84 dead zone (now critique-only range)
- Clear semantic boundaries for each action level
- Documented constants prevent magic numbers

**Trade-offs:**
- **Pro:** Predictable behavior, easier debugging
- **Pro:** Can tune thresholds based on metrics
- **Con:** More branching logic (but clearer intent)

**Decision:** Implement tiered system. Critique-only range (70-84) reduces wasted repairs.

---

### Decision 4: Validation Strategy - Post-API Zod Validation

**Problem:** Critique/repair schemas are simplified JSON objects (not Zod) to avoid 4-level nesting limit. API may return invalid data.

**Solution:** Apply Zod validation AFTER API call, before business logic.

**Approach:**
```typescript
// In runVisualCritique:
const rawResult = await createJsonInteraction<any>(MODEL_SIMPLE, prompt, simpleSchema, ...);

// Post-validate against full Zod schema
const validated = VisualCritiqueReportSchema.safeParse(rawResult);
if (!validated.success) {
  console.error('[VISUAL CRITIQUE] Invalid response:', validated.error.format());
  return { issues: [], overallScore: 75, hasCriticalIssues: false };  // Safe fallback
}

return validated.data;
```

**Rationale:**
- Gemini Interactions API enforces simple schema (4-level max)
- Zod validation adds runtime type safety for business logic
- Graceful fallback prevents cascade failures

**Trade-offs:**
- **Pro:** Catches schema drift, enum violations, missing fields
- **Pro:** Actionable error messages (Zod error.format())
- **Con:** Duplicate validation (API + Zod)
- **Con:** ~5ms overhead per critique

**Decision:** Implement post-validation. Type safety worth minor overhead.

---

### Decision 5: Cost Tracking Enhancement

**Problem:** System 2 costs (visual critique + repair) not tracked separately from primary generation.

**Solution:** Add System 2 cost breakdown to metrics.

**Approach:**
```typescript
// In DeckMetrics
interface DeckMetrics {
  // ... existing fields
  system2Cost?: number;              // Total System 2 API cost
  system2TokensInput?: number;       // Critique + repair input tokens
  system2TokensOutput?: number;      // Critique + repair output tokens
}

// Track in orchestrator
let system2Cost = 0;
const preSystem2Cost = costTracker.getSummary().totalCost;
// ... run System 2 ...
system2Cost += costTracker.getSummary().totalCost - preSystem2Cost;
```

**Rationale:**
- Isolates System 2 cost impact for A/B testing
- Validates ~$0.015 projection claim
- Enables cost-based feature flagging

**Trade-offs:**
- **Pro:** Precise cost attribution
- **Pro:** Can disable System 2 if costs spike
- **Con:** Slightly more bookkeeping

**Decision:** Implement separate tracking. Essential for cost optimization.

---

## Implementation Strategy

### Phase 1: Core Infrastructure (Tier 1 - Critical)

#### Task 1.1: Enhanced SVG Proxy Generation
**File:** `services/visualDesignAgent.ts`
**Lines:** 230-289 (replace `generateSvgProxy` function)

**Changes:**
1. Import SpatialLayoutEngine, InfographicRenderer, getIconUrl
2. Compile slide to VisualElement[] using existing rendering pipeline
3. Render VisualElements to SVG with truncated content
4. Include color information from visualDesignSpec
5. Add density metadata (total text chars, component counts)

**New Function Signature:**
```typescript
export function generateSvgProxy(
  slide: SlideNode,
  styleGuide: GlobalStyleGuide,
  getIconUrl: (name: string) => string | undefined
): string
```

**Validation:**
- SVG output size < 15KB (prevents prompt bloat)
- Valid XML structure (xmlns, viewBox)
- Contains at least 1 <text> or <rect> element per component

---

#### Task 1.2: Recursive Visual Critique Loop
**File:** `services/slideAgentService.ts`
**Lines:** 1093-1153 (replace System 2 block)

**Changes:**
1. Extract System 2 logic into separate function `runRecursiveVisualCritique()`
2. Implement bounded while loop (MAX_ROUNDS=3)
3. Re-generate SVG proxy after each repair
4. Track round count, convergence status
5. Return enhanced metrics: rounds, finalScore, issueHistory

**New Function:**
```typescript
async function runRecursiveVisualCritique(
  candidate: SlideNode,
  validation: ValidationResult,
  costTracker: CostTracker,
  styleGuide: GlobalStyleGuide,
  getIconUrl: (name: string) => string | undefined
): Promise<{
  slide: SlideNode;
  rounds: number;
  finalScore: number;
  repairSucceeded: boolean;
}>
```

**Edge Cases:**
- If candidate lacks layoutPlan, skip System 2 (no components to critique)
- If SVG generation throws, log error and skip critique
- If repair worsens score, keep original candidate

---

#### Task 1.3: Zod Post-Validation Wrappers
**File:** `services/validators.ts`
**Lines:** Add new functions after line 292

**Changes:**
1. Create `validateCritiqueResponse(rawResult: any): VisualCritiqueReport | null`
2. Create `validateRepairResponse(rawResult: any): SlideLayoutPlan | null`
3. Apply in runVisualCritique and runLayoutRepair

**Implementation:**
```typescript
import { VisualCritiqueReportSchema, SlideLayoutPlanSchema } from '../types/slideTypes';

export function validateCritiqueResponse(raw: any): VisualCritiqueReport | null {
  const result = VisualCritiqueReportSchema.safeParse(raw);
  if (!result.success) {
    console.error('[VALIDATOR] Critique response invalid:', result.error.format());
    return null;
  }
  return result.data;
}

export function validateRepairResponse(raw: any): SlideLayoutPlan | null {
  const result = SlideLayoutPlanSchema.safeParse(raw);
  if (!result.success) {
    console.error('[VALIDATOR] Repair response invalid:', result.error.format());
    return null;
  }
  return result.data;
}
```

**Integration:**
- Call in `runVisualCritique()` after API response
- Call in `runLayoutRepair()` after API response
- Return safe fallback on validation failure

---

### Phase 2: Robustness & Optimization (Tier 2)

#### Task 2.1: Unified Threshold System
**File:** `types/slideTypes.ts`
**Lines:** Add after line 84 (after VisualCritiqueReport types)

**Changes:**
```typescript
// System 2 Visual Critique Thresholds
export const VISUAL_THRESHOLDS = {
  EXCELLENT: 95,        // No critique needed
  TARGET: 85,           // Critique activation point
  REPAIR_REQUIRED: 70,  // Force repair attempt
  CRITICAL: 60,         // Aggressive repair
  FALLBACK: 50          // Give up
} as const;

export type VisualThreshold = typeof VISUAL_THRESHOLDS[keyof typeof VISUAL_THRESHOLDS];
```

**Usage:**
- Replace hardcoded 85 in slideAgentService.ts line 1096
- Replace hardcoded 70 in slideAgentService.ts line 1118
- Document threshold semantics in PROMPTS.LAYOUT_CRITIC

---

#### Task 2.2: Model Constant Consolidation
**File:** `services/visualDesignAgent.ts`
**Lines:** 329 (runVisualCritique model parameter)

**Changes:**
```typescript
// BEFORE:
'gemini-2.5-flash',

// AFTER:
MODEL_SIMPLE,  // Import from interactionsClient.ts line 10
```

**Validation:**
- Grep for hardcoded model strings: `rg '"gemini-[0-9]' services/`
- Replace all occurrences with constants
- Run TypeScript compiler to verify imports

---

#### Task 2.3: Strict Repair Success Criteria
**File:** `services/slideAgentService.ts`
**Lines:** 1131-1137 (repair success check)

**Changes:**
```typescript
// BEFORE:
if (repairedValidation.passed && repairedValidation.score >= validation.score) {

// AFTER:
const MIN_IMPROVEMENT_DELTA = 5;  // Require meaningful improvement
if (repairedValidation.passed &&
    repairedValidation.score > validation.score &&
    repairedValidation.score - validation.score >= MIN_IMPROVEMENT_DELTA) {
```

**Rationale:**
- Prevents accepting repair with score 70.1 over original 70.0 (trivial improvement)
- Requires ≥5 point improvement to justify API cost
- Still accepts repair if score crosses threshold (69 → 71 is valid)

---

#### Task 2.4: System 2 Cost Breakdown
**File:** `types/slideTypes.ts` + `services/slideAgentService.ts`

**Changes:**
1. Add to DeckMetrics interface (slideTypes.ts line 334):
```typescript
system2Cost?: number;
system2TokensInput?: number;
system2TokensOutput?: number;
```

2. Track in orchestrator (slideAgentService.ts line 1500):
```typescript
const preSystem2Cost = costTracker.getSummary().totalCost;
const preSystem2Tokens = costTracker.getSummary();

// ... run System 2 ...

const postSystem2Cost = costTracker.getSummary().totalCost;
const system2Cost = postSystem2Cost - preSystem2Cost;
```

3. Report in final metrics (line 1640):
```typescript
console.log(`[ORCHESTRATOR]   - System 2 Cost: $${system2Cost.toFixed(4)} (${(system2Cost/totalCost*100).toFixed(1)}%)`);
```

---

## Caveats & Risk Mitigation

### Caveat 1: IconCache Dependency
**Issue:** Enhanced SVG proxy needs IconCache.getIconUrl() for icon rendering
**Mitigation:** Initialize IconCache in orchestrator, pass to generateSvgProxy
**Fallback:** If icon lookup fails, render placeholder icon code ("IC") instead of skipping

### Caveat 2: SVG Size Explosion
**Issue:** Content-aware SVG could exceed 15KB, bloating prompts
**Mitigation:**
- Truncate text content to 50 chars per element
- Limit to first 20 VisualElements per slide
- Skip image elements (data URLs are large)

### Caveat 3: Recursion Cost Spiral
**Issue:** 3 rounds × N slides could double System 2 cost
**Mitigation:**
- Track system2Cost separately for monitoring
- Add feature flag `ENABLE_RECURSIVE_CRITIQUE` (default: true)
- Circuit breaker: if system2Cost > $0.05, disable for remaining slides

### Caveat 4: Critique Prompt Quality
**Issue:** Critique agent may misinterpret SVG syntax
**Mitigation:**
- Add SVG legend to prompt: "Zone codes: H=hero, S=secondary"
- Include example annotated SVG in system prompt
- Test with complex layouts (bento-grid, timeline)

### Caveat 5: Repair Degradation
**Issue:** Repair might remove critical content to fix overlap
**Mitigation:**
- PROMPTS.LAYOUT_REPAIRER explicitly forbids content removal
- Validate repair output against original (component count must match)
- If repair removes components, reject and keep original

---

## Testing & Verification

### Unit Tests (Manual)

1. **SVG Proxy Fidelity**
   ```typescript
   const slide = createMockSlide('metric-cards', 3);
   const svg = generateSvgProxy(slide, styleGuide, getIconUrl);
   assert(svg.includes('42M'));  // Contains actual metric value
   assert(svg.includes('<text'));  // Has text elements
   assert(svg.length < 15000);  // Size constraint
   ```

2. **Recursion Convergence**
   ```typescript
   // Mock slide with validation.score = 60
   const result = await runRecursiveVisualCritique(lowScoreSlide, ...);
   assert(result.rounds >= 1);  // At least 1 critique ran
   assert(result.finalScore >= 60);  // Score improved or stayed same
   ```

3. **Threshold Logic**
   ```typescript
   // Score 84 → critique only, no repair
   // Score 68 → critique + repair
   // Score 95 → skip System 2
   ```

### Integration Tests (End-to-End)

**Test Case 1: Complex Layout Deck**
```bash
npm run dev
# Generate deck: "History of quantum computing with 8 key milestones"
# Expected: bento-grid or timeline layouts trigger System 2
# Verify: visualCritiqueAttempts > 0 in console logs
```

**Test Case 2: Cost Validation**
```bash
# Generate 3 decks with System 2 enabled
# Record: system2Cost from each deck
# Assert: $0.008 < system2Cost < $0.015 per deck
```

**Test Case 3: Recursion Depth**
```bash
# Generate deck with deliberately dense content (maxChars violation)
# Expected: 2-3 rounds of visual critique
# Verify: "System 2 repair succeeded (new score: XX)" in logs
```

### Metrics Validation

After 10 deck generations, verify:
- `visualCritiqueAttempts / totalSlides` ≈ 30-50% (not all slides need critique)
- `visualRepairSuccess / visualCritiqueAttempts` ≈ 60-80% (repairs should succeed most of the time)
- `system2Cost / totalCost` ≈ 4-7% (cost projection validated)

---

## Rollout Plan

### Stage 1: Core Implementation (Days 1-2)
- Implement Tasks 1.1, 1.2, 1.3 (Enhanced SVG, Recursion, Validation)
- Manual testing with 5 diverse topics
- Verify no regressions in existing System 1 path

### Stage 2: Refinements (Day 3)
- Implement Tasks 2.1, 2.2, 2.3, 2.4 (Thresholds, Constants, Success Criteria, Cost Tracking)
- Integration testing with 10 decks
- Tune thresholds based on metrics

### Stage 3: Production Hardening (Day 4)
- Add feature flag `process.env.SYSTEM2_RECURSIVE` (default: "true")
- Cost monitoring dashboard
- Circuit breaker testing (deliberate overload scenario)

### Stage 4: Metrics Collection (Week 2)
- Collect 100 deck generations with metrics
- A/B test: Recursive vs Single-shot System 2
- Tune MAX_ROUNDS based on diminishing returns analysis

---

## Success Criteria

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| SVG Proxy Fidelity | Type codes only | Actual content | Manual inspection |
| Recursion Depth | 0-1 rounds | 1-3 rounds | Metrics: avg rounds per slide |
| Critique Accuracy | Unknown | 80%+ issues detected | Manual review of 20 slides |
| Repair Success Rate | ~50% | 70%+ | visualRepairSuccess / visualCritiqueAttempts |
| System 2 Cost | $0.015-$0.020 | $0.008-$0.012 | system2Cost in DeckMetrics |
| Quality Improvement | N/A | +15-25% avg score | Compare before/after repair scores |

---

## Open Questions

1. **Icon Rendering:** Should SVG proxy include actual icon PNGs or just icon codes?
   - **Recommendation:** Icon codes only (avoid base64 bloat in SVG)

2. **Fallback Threshold:** At what score should we give up and use text-bullets fallback?
   - **Recommendation:** 50 (current circuit breaker already uses fallback slides)

3. **Max Rounds Tuning:** Should MAX_ROUNDS be configurable per layout variant?
   - **Recommendation:** Start with global constant, tune based on metrics

4. **Critique Agent Temperature:** Should temperature be lowered for deterministic critique?
   - **Recommendation:** Keep at 0.1 (some variance helps catch edge cases)

---

## Files Modified Summary

```
types/slideTypes.ts
  + VISUAL_THRESHOLDS constants
  + DeckMetrics.system2Cost fields
  ~ 20 lines added

services/validators.ts
  + validateCritiqueResponse()
  + validateRepairResponse()
  ~ 25 lines added

services/visualDesignAgent.ts
  ~ generateSvgProxy() - complete rewrite (90 lines)
  ~ runVisualCritique() - add Zod validation (5 lines)
  ~ runLayoutRepair() - add Zod validation (5 lines)
  ~ 100 lines changed

services/slideAgentService.ts
  + runRecursiveVisualCritique() function (60 lines)
  ~ System 2 integration (30 lines modified)
  ~ Cost tracking (10 lines)
  ~ 100 lines changed

services/interactionsClient.ts
  ~ Export MODEL_SIMPLE constant (1 line)
  ~ 1 line changed

Total: ~250 lines added/modified across 5 files
```
