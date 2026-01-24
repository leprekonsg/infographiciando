# InfographIQ Architecture (Current)

> **Updated**: 2026-01-24  
> **Version**: 3.4 (Risk-Based Sampling + Asset Drift Protection + Timing Metrics)

---

## 1) Executive Overview

InfographIQ is a **client-first, agent-orchestrated** slide generation system. It uses a multi-agent pipeline to transform a topic into a structured deck, then renders slides with spatially-aware layouts and optional visual critique.

Key characteristics:
- **Adaptive Director orchestration** with non-linear state machine (loop-back on thin content).
- **Risk-based visual sampling** (high-risk layouts always validated, low-risk skipped).
- **Asset drift protection** via content IDs (prevents stale image injection).
- **Back-pressure controlled** parallel asset generation (max 3 concurrent).
- **Per-phase timing metrics** for latency optimization.
- **Deterministic spatial rendering** using predefined layout templates + affinity mapping.
- **System 2 visual critique** with optional Qwen-VL external validation (Node-only).
- **Cost-aware model tiering** (Flash-first; Pro reserved only where required).

---

## 2) System Map

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                INFOGRAPHIQ SYSTEM                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌───────────────────────┐              ┌──────────────────────────┐
│      FRONTEND         │              │     DIRECTOR AGENT       │
│   React + Vite        │◄────────────►│  Adaptive Orchestrator   │
│                       │              │  (Non-Linear Pipeline)   │
└───────────────────────┘              └──────────────────────────┘
                         │                         │
                         ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            AGENT TOOLS (demoted from agents)                          │
│  • Researcher  • Architect  • Router  • ContentPlanner                                │
│  (Director invokes as needed, including targeted re-research)                         │
└─────────────────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                   SERVICES                                           │
│  • Spatial Renderer   • Infographic Renderer • Validators                            │
│  • Visual Design Agent • Visual Cortex (Qwen-VL) • Cost Tracker                       │
│  • Prompt Registry     • Auto-Repair • Diagram Builder                                │
└─────────────────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            EXTERNAL MODELS & TOOLS                                    │
│  • Gemini Interactions API  • Gemini Image Gen  • Qwen3-VL (optional)                  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3) Runtime Separation: Browser vs Node

**Browser (Vite / Client):**
- Director orchestration + agent tool invocation
- Spatial rendering + PPTX layout
- SVG proxy generation
- Image generation (Gemini Image models)

**Node-only (Guarded):**
- SVG rasterization via `@resvg/resvg-js`
- Qwen-VL visual critique (requires rasterized PNG)

**Guardrails (enforced at runtime):**
- `visualCortex.ts` dynamically imports `visualRasterizer.ts` and throws in browser.
- `visualRasterizer.ts` hard-checks `typeof window === 'undefined'`.

---

## 4) Director Pipeline (Bidirectional State Machine)

**Key Innovation**: The Director is NOT a sequential pipeline. It's an adaptive
orchestrator with **bidirectional** quality loops:
- **THIN content** → ENRICH (targeted re-research)
- **FAT content** → PRUNE/SUMMARIZE (condensation)

**Layout-Aware Quality Gates**: Hero slides have INVERTED rules (less is more).

```
INPUT: topic (string)
     │
     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  DIRECTOR AGENT (DirectorAgent.ts)                                          │
│  Bidirectional State Machine with Layout-Aware Quality Gates                │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  STATE: RESEARCH ──► runResearcher() ──► facts[]                           │
│       │                                                                     │
│       ▼                                                                     │
│  STATE: ARCHITECT ──► runArchitect() ──► outline + styleGuide               │
│       │                                                                     │
│       ▼                                                                     │
│  STATE: PER-SLIDE LOOP (bidirectional quality control)                      │
│       │                                                                     │
│       ├──► ROUTE ──► runRouter() ──► layoutId                              │
│       │                                                                     │
│       ├──► PLAN ──► runContentPlanner() ──► contentPlan                    │
│       │                                                                     │
│       ├──► EVALUATE ──► evaluateContentQuality(layoutId)                   │
│       │       │                                                             │
│       │       ├── PASSES ──────────────────────────────► NEXT SLIDE        │
│       │       │                                                             │
│       │       ├── THIN ──► ENRICH (loop back to PLAN)                      │
│       │       │       │                                                     │
│       │       │       ▼                                                     │
│       │       │   targetedResearch(query) ──► merge facts                  │
│       │       │                                                             │
│       │       └── FAT ──► PRUNE/SUMMARIZE (loop back to EVALUATE)          │
│       │               │                                                     │
│       │               ▼                                                     │
│       │           pruneContent() or summarizeContent()                     │
│       │                                                                     │
│       └──────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  STATE: ASSEMBLE ──► DeckBlueprint                                          │
│                                                                             │
└────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
OUTPUT: DeckBlueprint → blueprintToEditableDeck() → EditableSlideDeck
```

### 4.1) Layout-Specific Quality Profiles

Each layout has different content expectations:

| Layout | Min Bullets | Max Bullets | Min Chars | Max Chars | Allow Empty |
|--------|-------------|-------------|-----------|-----------|-------------|
| `hero-centered` | 0 | 2 | 0 | 120 | ✅ (title-only OK) |
| `bento-grid` | 2 | 3 | 60 | 200 | ❌ |
| `dashboard-tiles` | 2 | 3 | 60 | 180 | ❌ |
| `standard-vertical` | 2 | 5 | 100 | 400 | ❌ |
| `split-left/right-text` | 2 | 4 | 80 | 280 | ❌ |

### 4.2) Quality Gate Actions

**THIN Content Detection** (under-generation):
- `thin_content`: Too few key points
- `too_generic`: Points too short (avg < 20 chars)
- `missing_specifics`: Total chars below minimum

→ Action: **ENRICH** via `targetedResearch(suggestedQuery)`

**FAT Content Detection** (over-generation/overflow):
- `too_many_points`: Exceeds layout's maxBullets
- `overflow`: Total chars exceed layout's maxTotalChars
- `too_verbose`: Individual points exceed maxCharsPerPoint

→ Action: **PRUNE** (remove low-value points) or **SUMMARIZE** (condense text)

### 4.3) Loop Limits (Circuit Breakers)

- `MAX_ENRICHMENT_ATTEMPTS`: 2 (prevents infinite research)
- `MAX_PRUNE_ATTEMPTS`: 2 (prevents over-condensation)
- `MAX_TOTAL_ATTEMPTS`: 4 (safety valve per slide)

### 4.4) Two-Tier Validation (IFR + VFR) with Risk-Based Sampling

The Director uses **two validation tiers** for comprehensive quality control:

**Tier 1: Logic Gate (Fast - Always On)**
- Character counts + layout-specific limits
- `evaluateContentQuality()` with bidirectional checks
- Instant, deterministic, no external calls

**Tier 2: Visual Gate (Risk-Based Sampling)**
- `quickFitCheck()` from VisualSensor
- Catches overflow issues that character counts miss
- Example: "Configuration" fits 13 chars but wraps in narrow columns

**Risk-Based Sampling** (replaces flat 30%):

| Layout Risk | Layouts | Validation Rate |
|-------------|---------|-----------------|
| **HIGH** | `bento-grid`, `dashboard-tiles`, `metrics-rail`, `asymmetric-grid` | 100% (always) |
| **MEDIUM** | `split-left-text`, `split-right-text`, `standard-vertical`, `timeline-horizontal` | 30% + first/last |
| **LOW** | `hero-centered` | 0% unless title > 40 chars |

**Structured Failure Codes** (for analytics/auto-remediation):
- `TITLE_OVERFLOW`: Title text exceeds zone width
- `BODY_WRAP_EXCEEDED`: Body text wraps beyond acceptable lines
- `BULLET_TOO_LONG`: Individual bullet exceeds char limit
- `TOTAL_CHARS_OVERFLOW`: Total content chars exceed layout limit
- `ELEMENT_DENSITY_HIGH`: Too many visual elements in zone

```
EVALUATE (Logic Gate)
       │
       ▼
  [passes?] ──No──► ENRICH/PRUNE
       │
      Yes
       │
       ▼
  [risk-based sample?]
       │
       ├── HIGH RISK ──► Always validate
       │
       ├── MEDIUM RISK ──► Sample 30%
       │
       └── LOW RISK ──► Skip (unless long title)
       │
       ▼
VISUAL GATE (quickFitCheck)
       │
       ▼
  [fits?] ──No──► PRUNE/SUMMARIZE (+ log failure code)
```
       │
      Yes
       │
       ▼
    NEXT SLIDE
```

### 4.5) Phase 4: Early Asset Extraction (Parallelism + Drift Protection)

**Key Insight**: Image generation is slow (~5s/image) but independent of slide planning.
Extract asset needs AFTER architecture, generate in parallel DURING per-slide loop.

**Asset Drift Problem**: Outline says "Slide 4: Q4 Revenue Chart". During drafting, Director
pivots to "Q4 Qualitative Achievements". Pre-generated chart is now stale.

**Solution: Content ID Binding**
- Each slide gets a `contentId` based on normalized title + purpose
- At ASSEMBLE, compare final `contentId` vs asset's original `contentId`
- If mismatch (< 50% word overlap), discard stale asset

```
STATE: ARCHITECT ──► outline
       │
       ▼
STATE: ASSET_EXTRACT ──► extractAssetNeeds(outline, facts)
       │                    + Generate contentId per slide
       │
       │──────► [Background Task] generateAssetsParallel()
       │                               │ (max 3 concurrent, back-pressure)
       ▼                               ▼
STATE: PER-SLIDE LOOP            (images generating...)
       │                               │
       ▼                               ▼
STATE: ASSEMBLE ◄─────────────── waitForAssetsWithTimeout()
       │                               │
       │                               ▼
       │                          Drift Detection:
       │                          contentIdMatches(original, final)?
       │                               │
       │                    ┌──────────┴──────────┐
       │                   Yes                    No
       │                    │                      │
       │               Inject image          Discard (stale)
       │                                     Log warning
```

**Back-Pressure Control**: `Semaphore` limits concurrent image generations (default: 3).
Prevents rate limiting while still achieving parallelism.

**Timeout Handling**: `waitForAssetsWithTimeout()` (default: 15s) returns partial results
rather than blocking forever. If images aren't ready, deck renders without them.

**Configuration** (`DirectorConfig` + Mode Presets):
```typescript
// Mode presets (avoid combinatorial config explosion)
type DirectorMode = 'fast' | 'balanced' | 'premium';

// 'fast' mode: Skip visual validation, 5s timeout, 5 concurrent images
// 'balanced' mode: 30% sampling, 15s timeout, 3 concurrent images
// 'premium' mode: 100% validation, 30s timeout, 2 concurrent images

{
  mode: 'balanced',                  // Use preset (overrides individual flags)
  enableVisualValidation: true,
  visualValidationSampling: 0.3,
  enableParallelPlanning: false,
  enableEarlyAssetExtraction: true,
  assetGenerationTimeout: 15000,     // NEW: Max wait time (ms)
  maxConcurrentImages: 3             // NEW: Back-pressure limit
}
```

### 4.6) Per-Phase Timing Metrics

Track latency breakdown for optimization:

```typescript
interface PhaseTimings {
    research: number;     // Time in RESEARCH phase (ms)
    architect: number;    // Time in ARCHITECT phase (ms)
    assetExtract: number; // Time in ASSET_EXTRACTION phase (ms)
    perSlideLoop: number; // Total time in PER-SLIDE loop (ms)
    assemble: number;     // Time in ASSEMBLE phase (ms)
    assetWait: number;    // Time waiting for parallel assets (ms)
    total: number;        // Total end-to-end time (ms)
}
```

**Example Output**:
```
[DIRECTOR] Timing Breakdown:
  - Research: 8234ms
  - Architect: 4521ms
  - Asset Extract: 12ms
  - Per-Slide Loop: 24103ms
  - Asset Wait: 3201ms (images ready before loop finished)
  - Assemble: 89ms
  - TOTAL: 40160ms
```

### 4.7) Targeted Re-Research (Loop-back Capability)
When content is thin, the Director calls `targetedResearch(suggestedQuery)` which:
1. Runs a focused research query on the specific slide topic
2. Merges new facts with existing facts (deduplicating)
3. Retries content planning with enriched context

This is the **Manus-level capability** that makes the Director non-linear.

**Feature Flag**: Set `ENABLE_DIRECTOR_MODE = true` in `slideAgentService.ts` to use Director pipeline (with silent fallback to legacy on failure).

**Legacy Pipeline**: Still available when `ENABLE_DIRECTOR_MODE = false`, using the original multi-agent sequential approach.

---

## 5) System 2 Visual Critique (Current)

**Vision-First Interior Designer (Qwen-VL Architect):**
- `runQwenVisualArchitectLoop()` → Multi-turn visual optimization (Node-only)
- SVG Proxy → PNG (resvg) → Qwen-VL → `RepairAction[]`
- `applyRepairsToSlide()` → Normalizes repairs and injects layout hints (`_hintY`, `_hintPadding`, etc.)
- Bounded recursion (MAX_ROUNDS=3) with improvement-delta tracking

**Internal QA Guard (always available):**
- `runVisualCritique()` → Lightweight semantic/layout critique (MODEL_SIMPLE)
- `ContentPlan` alignment verification and fit-score calculation
- Circuit-breaker triggers on `ERR_ITEM_COUNT_CRITICAL` or low fit-score

**Fidelity Contract:**
- Critique and repair use `svg-proxy` for speed and determinism
- Final rendering uses `pptx-render` logic inside components
- Spatial engine respects `RepairAction` hints to fix overlap/spacing issues

---

## 6) Rendering Pipeline (Current)

```
SlideNode
     │
     ▼
SpatialLayoutEngine
     ├─ Select layout template (9 variants)
     ├─ Allocate zones by component affinity
     ├─ Track warnings (truncation/unplaced)
     │
     ▼
InfographicRenderer
     ├─ normalizeColor() (LLM-friendly → hex)
     ├─ Diagram rendering (diagram-svg) via SVG → PNG (Node) or SVG data URL (Browser)
     └─ compileSlide() → VisualElement[]
     │
     ▼
SlideDeckBuilder (pptxgenjs)
     ├─ Background image
     ├─ Visual elements placement
     └─ Speaker notes + citations
```

**Layout variants:**
- `standard-vertical`
- `split-left-text`
- `split-right-text`
- `hero-centered`
- `bento-grid`
- `timeline-horizontal`
- `dashboard-tiles`
- `metrics-rail`
- `asymmetric-grid`

---

## 7) Visual Cortex (Qwen-VL)

```
SVG Proxy → (Node-only) Rasterizer → PNG → Qwen-VL → Critique JSON
                ▲                 ▲
                │                 └── visualRasterizer.ts (@resvg/resvg-js)
                └── visualCortex.ts (dynamic import + runtime guard)
```

**Render Fidelity Contract:**
- Tier 1: `svg-proxy` (fast, deterministic)
- Tier 2: `pptx-render` (future escalation path; not wired by default)

---

## 8) Data Type Flow (Current)

```
topic → ResearchFact[] → Outline → { RouterDecision, ContentPlan, VisualDesignSpec }
           → SlideNode → EditableSlideDeck
```

**Schemas** live in [types/slideTypes.ts](../types/slideTypes.ts).

---

## 9) Template Component Types

Current generator component types (schema-enforced):

```
text-bullets | metric-cards | process-flow | icon-grid | chart-frame | diagram-svg
```

---

## 10) Cost Tracking (Current)

Cost tracking is centralized in `CostTracker`:
- Per-call token tracking
- Per-model cost breakdown
- Savings vs Pro baseline
- Qwen-VL costs tracked explicitly

---

## 11) Key Files (Current)

| File | Purpose |
|------|---------|
| [services/slideAgentService.ts](../services/slideAgentService.ts) | Orchestrator: `generateAgenticDeck()`, reroute logic, System 2 loop |
| [services/agents/compositionArchitect.ts](../services/agents/compositionArchitect.ts) | Composition Architect: Layer planning & surprise allocation |
| [services/interactionsClient.ts](../services/interactionsClient.ts) | Interactions API client + CostTracker |
| [services/visualDesignAgent.ts](../services/visualDesignAgent.ts) | Visual Designer + Critique + Repair |
| [services/spatialRenderer.ts](../services/spatialRenderer.ts) | Layout templates + zone allocation |
| [services/infographicRenderer.ts](../services/infographicRenderer.ts) | Slide compilation + color normalization |
| [services/cardRenderer.ts](../services/cardRenderer.ts) | Glass card rendering logic |
| [services/decorativeRenderer.ts](../services/decorativeRenderer.ts) | Badges, dividers, and accent shapes rendering |
| [services/visualCortex.ts](../services/visualCortex.ts) | Qwen-VL integration (Node-only) |
| [services/visualRasterizer.ts](../services/visualRasterizer.ts) | resvg-based SVG → PNG rasterization |
| [services/image/imageGeneration.ts](../services/image/imageGeneration.ts) | Gemini Image generation (Flash → Pro fallback) |
| [types/slideTypes.ts](../types/slideTypes.ts) | Zod schemas + shared types |
| [types/serendipityTypes.ts](../types/serendipityTypes.ts) | Serendipity engine types & schemas |

---

## 12) Model Allocation (Current)

| Agent/Task | Model | Thinking | Notes |
|------------|-------|----------|------|
| Researcher | gemini-3-flash-preview | low | Agentic research + grounding |
| Architect | gemini-3-flash-preview | medium | Narrative + outline planning |
| Router | gemini-2.5-flash | none | Enum classification |
| Content Planner | gemini-3-flash-preview | low | Key points & data points |
| Composition Architect | gemini-3-flash-preview | low | Layered structure & surprises |
| Visual Designer | gemini-3-flash-preview | low | Visual composition |
| Generator | gemini-3-flash-preview | none | Final slide assembly |
| Image Gen | gemini-2.5-flash-image → gemini-3-pro-image-preview | - | Background-only images |
| Qwen-VL | qwen3-vl-plus-2025-12-19 | - | Optional visual critique |

---

## 13) Frontend Component Architecture (Current)

```
App.tsx
  ├── Header.tsx (view toggle)
  ├── Quick View
  │     ├── MarkdownInput.tsx
  │     └── ResultPreview.tsx
  └── Agentic View
        └── SlideDeckBuilder.tsx
              ├── BuilderCanvas.tsx (spatial preview)
              └── ActivityFeed.tsx (agent logs)
```

---

## 14) Serendipity Engine: Layered Composition

The system has evolved from flat templates to a **Layered Composition Model** managed by the Composition Architect.

### 14.1) Explicit Layer Stack
1. **Background Layer**: Solid, gradients, or mesh patterns (generated via Image Gen).
2. **Decorative Layer**: Non-content elements like **Badges**, **Dividers**, **Accent Shapes**, and **Glows**.
3. **Content Layer**: The core data viz, cards, and text blocks.
4. **Overlay Layer**: Floating highlights or micro-annotations.

### 14.2) Surprise Slot System
Based on the `VariationBudget`, slides are allocated "surprise slots" where specialized elements (like category badges or asymmetric spacing) are injected to break repetition.

### 14.3) Compositional Primitives
Moving beyond 6 rigid types to a vocabulary of atoms:
- **Badge**: { icon, label, color } for categorization.
- **Card**: { style: glass|solid|outline } with structured headers.
- **Divider**: Gradient or glowing separators.
- **IconContainer**: Circle, square, or rounded-square containers.

---

**Status**: ✅ Current implementation documented. Only active architecture is retained.
