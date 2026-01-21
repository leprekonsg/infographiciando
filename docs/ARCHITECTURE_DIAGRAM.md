# InfographIQ Architecture Blueprint

> **Updated**: 2026-01-21  
> **Version**: 2.1 (Node/Browser Separation + Cost Tracking Hardened)  
> **Source**: Codebase Review + Architectural Fixes

---

## 1) Executive Overview

InfographIQ is a **client-first, agent-orchestrated** system that generates slide decks via a multi-agent pipeline, then renders them into PPTX with spatially-aware layouts. The 2026-01-21 changes introduce **strict Node/Browser separation** for native modules and **type-safe cost tracking** for Qwen-VL usage.

Key improvements in this version:
- **Native module isolation** using dynamic import + runtime guards.
- **Browser-safe bundling** (Vite excludes Node-only modules).
- **Cost tracking** for Qwen-VL made explicit and type-safe.

---

## 2) System Map (Updated)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                INFOGRAPHIQ SYSTEM                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
                         │
                         ├───────────────────────────────────┐
                         │                                   │
                         ▼                                   ▼
┌───────────────────────┐              ┌──────────────────────────┐
│      FRONTEND         │              │       AGENT LAYER        │
│   React + Vite        │◄────────────►│   Multi-Agent Pipeline   │
│                       │              │ (Research → Generate)    │
└───────────────────────┘              └──────────────────────────┘
                         │                                   │
                         ▼                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                   SERVICES                                           │
│  • Spatial Rendering  • Infographic Rendering  • PPTX Export  • Validators           │
│  • Visual Cortex (Qwen-VL)  • Cost Tracker  • Prompt Registry                         │
└─────────────────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            EXTERNAL MODELS & TOOLS                                    │
│  • Gemini Interactions API  • Google Search Grounding  • Image Gen                   │
│  • Qwen3-VL (Visual Critique)                                                         │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3) Runtime Separation: Browser vs Node

The architecture explicitly prevents Node-only native modules from entering the browser bundle.

```
Browser (Vite)                            Node.js (Server/CLI)
──────────────────────────────────         ───────────────────────────────────
UI + Agent Orchestration                   Visual Rasterization
     • React UI                                • @resvg/resvg-js (native)
     • Gemini Interactions API                 • SVG → PNG pipeline
     • Spatial rendering                       • Qwen-VL visual critique
     • PPTX generation                          
     • Visual Cortex (guarded)                 Visual Cortex (full feature)

Key safety mechanism:
     visualCortex.ts uses dynamic import → visualRasterizer.ts
     if (typeof window !== 'undefined') throw (guard)
```

**Bundling protections**:
- Vite excludes `@resvg/resvg-js` from optimizeDeps and Rollup externalization.
- Browser execution path skips rasterization with explicit runtime error.

---

## 4) Agentic Pipeline (Current, Stable)

```
INPUT: topic (string)
     │
     ▼
AGENT 1: Researcher (MODEL_AGENTIC)
     └─ outputs ResearchFact[] (8–12 verified facts)
     │
     ▼
AGENT 2: Architect (MODEL_AGENTIC, thinking=medium)
     └─ outputs Outline (narrativeGoal, styleGuide, slides[])
     │
     ▼
FOR EACH SLIDE (parallel)
     ├─ Router (MODEL_SIMPLE) → RouterDecision
     ├─ Content Planner (MODEL_AGENTIC) → ContentPlan
     └─ Visual Designer (MODEL_AGENTIC, thinking=low) → VisualDesignSpec
     │
     ▼
AGENT 4: Generator (MODEL_AGENTIC, thinking=none)
     └─ outputs SlideNode (layoutPlan + components)
     │
     ▼
Image Generator (gemini-3-pro-image-preview → fallback)
     └─ outputs backgroundImageUrl (data URL)
     │
     ▼
OUTPUT: EditableSlideDeck
```

**Critical constraint**: Generator never escalates to Pro (avoids truncation).

---

## 5) Rendering Pipeline

```
SlideNode
     │
     ▼
SpatialLayoutEngine
     ├─ Select layout template (6 variants)
     ├─ Allocate zones by semantic affinity
     └─ Enforce negative space rules
     │
     ▼
InfographicRenderer
     ├─ normalizeColor() (LLM-friendly names → hex)
     └─ compileSlide() → VisualElement[]
     │
     ▼
SlideDeckBuilder (pptxgenjs)
     ├─ Background render
     ├─ Visual elements placement
     └─ Speaker notes & citations
```

---

## 6) Visual Cortex (Qwen-VL) — Updated Flow

The visual critique system now runs **only in Node.js** and is guarded in browser contexts.

```
SVG Proxy → (Node-only) Rasterizer → PNG → Qwen-VL → Critique JSON
                ▲                 ▲
                │                 └── visualRasterizer.ts (@resvg/resvg-js)
                └── visualCortex.ts (dynamic import + runtime guard)
```

Two-tier fidelity contract:
- **Tier 1**: SVG proxy rendering (fast, default).
- **Tier 2**: PPTX rendering (slow, escalated).

---

## 7) Cost Tracking (Hardened)

Qwen-VL costs are now first-class tracked fields in `CostTracker`:
- `qwenVLCost`
- `qwenVLInputTokens`
- `qwenVLOutputTokens`
- `qwenVLCalls`

This removes `any` casts and improves summary accuracy.

---

## 8) Data Type Flow (Core Types)

```
topic → ResearchFact[] → Outline → { RouterDecision, ContentPlan, VisualDesignSpec }
           → SlideNode → EditableSlideDeck
```

**Schemas** live in [types/slideTypes.ts](../types/slideTypes.ts).

---

## 9) Template Component Types

Supported layout components (schema-enforced):

```
text-bullets | metric-cards | process-flow | icon-grid | chart-frame
```

Adding a new type requires updates in:
- [types/slideTypes.ts](../types/slideTypes.ts)
- [services/slideAgentService.ts](../services/slideAgentService.ts)
- [services/infographicRenderer.ts](../services/infographicRenderer.ts)
- [services/promptRegistry.ts](../services/promptRegistry.ts)

---

## 10) Error Handling & Resilience

**Auto-Repair Layer**
- Component type normalization (100+ mappings)
- Deep JSON parsing for escaped/nested output
- Garbage filtering (<2 chars, numeric-only, etc.)

**Circuit Breakers**
- Generator: MAX_RETRIES=2 then fallback slide
- Model calls: failover chain with cooldowns

**Truncation Mitigation**
- Generator thinking disabled
- Controlled list lengths (keyPoints ≤ 5, dataPoints ≤ 4)

---

## 11) Updated Build & Runtime Guarantees

**Build guarantees**:
- Vite excludes Node-only modules from browser bundles.
- Visual rasterization is never imported at top-level in browser.

**Runtime guarantees**:
- Browser attempts to rasterize SVG throw explicit errors.
- Node execution loads native modules safely via dynamic import.

---

## 12) Quick Reference (Models)

| Agent | Model | Thinking | Temperature | Notes |
|------|-------|----------|-------------|------|
| Researcher | 3 Flash | low | 0.3 | Fact extraction |
| Architect | 3 Flash | medium | 0.2 | Narrative planning |
| Router | 2.5 Flash | none | 0.1 | Classification |
| Content Planner | 3 Flash | none | 0.2 | Key points |
| Visual Designer | 3 Flash | low | 0.2 | Spatial composition |
| Generator | 3 Flash | none | 0.1 | Final assembly |
| Image Gen | 3 Pro Image → 2.5 Flash Image | - | - | Backgrounds |

---

## 13) Architecture Health Summary

**Status**: ✅ Healthy and updated for Node/Browser separation.

**Primary safeguards**:
- Dynamic imports for native modules.
- Vite externalization rules.
- Type-safe cost tracking for Qwen-VL.

**Recommended next step** (optional):
- Move agent orchestration to a Node backend for production security and full visual cortex coverage.
```

---

## Frontend Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND COMPONENT HIERARCHY                                   │
│                                   (React + Vite)                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘

  App.tsx
       │
       ├── Header.tsx
       │     └── View toggle (Quick / Agentic)
       │
       ├── [Quick View]
       │     ├── Mode Toolbar (Infographic|Presentation|3D Asset|SVG|Sticker)
       │     ├── MarkdownInput.tsx (Content editor)
       │     └── ResultPreview.tsx (Generated output display)
       │
       └── [Agentic View]
             └── SlideDeckBuilder.tsx
                   ├── Topic Input
                   ├── Progress Indicator (Agent 1-5 status)
                   ├── BuilderCanvas.tsx (Slide preview grid)
                   │     └── Spatial zone visualization
                   ├── ActivityFeed.tsx (Real-time agent logs)
                   └── Export Button (PPTX download)
```

---

## File Structure

```
infographiciando/
├── App.tsx                           # Main React app, view switching
├── index.tsx                         # Entry point
├── index.html                        # HTML template
├── vite.config.ts                    # Vite bundler config
├── tsconfig.json                     # TypeScript config
├── package.json                      # Dependencies
│
├── components/
│   ├── ActivityFeed.tsx              # Real-time agent activity log
│   ├── BuilderCanvas.tsx             # Slide preview with spatial zones
│   ├── Header.tsx                    # Top navigation bar
│   ├── MarkdownInput.tsx             # Content input editor
│   ├── ResultPreview.tsx             # Quick mode output display
│   └── SlideDeckBuilder.tsx          # Agentic deck builder UI + PPTX export
│
├── services/
│   ├── interactionsClient.ts         # Gemini Interactions API client
│   │   ├── Model constants (AGENTIC, SIMPLE, REASONING)
│   │   ├── runAgentLoop() - Multi-turn agent execution
│   │   ├── createJsonInteraction() - Structured output
│   │   ├── CostTracker - Token/cost logging
│   │   └── AgentLogger - Tool call transparency
│   │
│   ├── slideAgentService.ts          # Core agent orchestration
│   │   ├── runResearcher()
│   │   ├── runArchitect()
│   │   ├── runRouter()
│   │   ├── runContentPlanner()
│   │   ├── runGenerator()
│   │   ├── autoRepairSlide()
│   │   ├── generateImageFromPrompt()
│   │   └── generateAgenticDeck() - Main orchestrator
│   │
│   ├── visualDesignAgent.ts          # Visual Designer agent
│   │   └── runVisualDesigner() - Spatial composition planning
│   │
│   ├── spatialRenderer.ts            # Spatial Layout Engine
│   │   └── Zone-based component allocation
│   │
│   ├── infographicRenderer.ts        # Slide → VisualElement[] compilation
│   │   ├── normalizeColor()
│   │   └── compileSlide()
│   │
│   ├── geminiService.ts              # Legacy API compatibility + utilities
│   │   ├── cleanAndParseJson() - Robust JSON parsing
│   │   ├── runJsonRepair() - LLM-based JSON repair
│   │   └── callWithRetry() - Retry utility
│   │
│   ├── promptRegistry.ts             # Centralized prompt templates
│   │   ├── PROMPTS.RESEARCHER
│   │   ├── PROMPTS.ARCHITECT
│   │   ├── PROMPTS.ROUTER
│   │   ├── PROMPTS.CONTENT_PLANNER
│   │   └── PROMPTS.VISUAL_DESIGNER
│   │
│   └── validators.ts                 # Schema & alignment validation
│       ├── validateSlide()
│       └── validateVisualLayoutAlignment()
│
├── types/
│   └── slideTypes.ts                 # Zod schemas & TypeScript types
│       ├── ResearchFactSchema
│       ├── OutlineSchema
│       ├── RouterDecisionSchema
│       ├── VisualDesignSpecSchema
│       ├── TemplateComponentSchema
│       ├── SlideNodeSchema
│       └── EditableSlideDeck
│
└── docs/
    ├── ARCHITECTURE_DIAGRAM.md       # This file
    ├── architecture_blueprint.md     # Original design document
    ├── MODEL_OPTIMIZATION.md         # Model tier decisions
    ├── INTERACTIONS_API_MIGRATION.md # API migration notes
    ├── detailed_critique.md          # System analysis
    └── implementation_examples.md    # Code examples
```

---

## Cost Tracking

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              COST TRACKING (CostTracker)                                 │
└─────────────────────────────────────────────────────────────────────────────────────────┘

  Estimated Costs Per Deck:
  ┌────────────────────────────────────────────────────────────────────────────────────────┐
  │  Before Optimization:    ~$0.45/deck (heavy Pro usage)                                 │
  │  After Optimization:     ~$0.18/deck (model tier optimization)                         │
  │  Savings:                ~60-70% cost reduction                                        │
  │                                                                                        │
  │  Monthly (1000 decks):                                                                 │
  │    Before: $450                                                                        │
  │    After:  $180                                                                        │
  │    Monthly Savings: $270                                                               │
  └────────────────────────────────────────────────────────────────────────────────────────┘

  CostTracker Features:
    • Per-call token tracking (input/output)
    • Per-model cost breakdown
    • Savings vs Pro baseline calculation
    • Console logging: 💰 [COST] Real-time visibility

  Console Output Example:
    [ORCHESTRATOR] Duration: 45.3s
    [ORCHESTRATOR] Total Cost: $0.1823
    [ORCHESTRATOR] 💰 Savings vs Pro: $0.2651 (59%)
    [ORCHESTRATOR] Tokens: 12340 in, 8920 out
    [ORCHESTRATOR] Model Breakdown: {
      "gemini-3-flash-preview": { calls: 24, cost: 0.0892 },
      "gemini-2.5-flash": { calls: 6, cost: 0.0124 },
      "gemini-3-pro-image-preview": { calls: 6, cost: 0.0807 }
    }
```

---

## Quick Reference

| Agent | Model | Thinking | Temperature | Purpose |
|-------|-------|----------|-------------|---------|
| **Researcher** | 3 Flash | low | 0.3 | Deep research, fact extraction |
| **Architect** | 3 Flash | medium | 0.2 | Narrative planning, style guide |
| **Router** | 2.5 Flash | none | 0.1 | Layout variant classification |
| **Content Planner** | 3 Flash | none | 0.2 | Key points extraction |
| **Visual Designer** | 3 Flash | low | 0.2 | Spatial composition planning |
| **Generator** | 3 Flash | none | 0.1 | Final slide assembly |
| **Image Gen** | 3 Pro Image | - | - | Background generation |

---

## Gap Analysis: Proposed vs Current Architecture

Comparing the **Proposed Enhanced Architecture** (from `architecture_blueprint.md`) against the **Current Implementation**:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                            GAP ANALYSIS SUMMARY                                          │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  ✅ FULLY IMPLEMENTED              ⚠️ PARTIAL/SIMPLIFIED           ❌ NOT IMPLEMENTED   │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Agent-by-Agent Comparison

| Agent | Proposed | Current | Status | Gap Details |
|-------|----------|---------|--------|-------------|
| **Researcher** | facts[] extraction | ✅ Implemented | ✅ Complete | Full parity |
| **Architect** | outline + factClusters | ✅ Implemented | ✅ Complete | Full parity |
| **Router** | routerConfig with `spatialZones[]` | ⚠️ Partial | ⚠️ Missing | **Gap: `spatialZones[]` not generated by Router**. Current Router outputs: renderMode, layoutVariant, densityBudget, visualFocus. Zones are derived statically in `SpatialLayoutEngine` instead of dynamically from Router. |
| **Content Planner** | keyPoints, dataPoints, layout | ✅ Implemented | ✅ Complete | Minor: `layout` field mentioned in proposal but not used downstream |
| **Layout Generator** | layoutPlan with `spatialAllocations` | ⚠️ Partial | ⚠️ Separate | **Gap: No dedicated Layout Generator agent**. Current Generator combines layout + content generation. `spatialAllocations` is computed post-hoc by `SpatialLayoutEngine.allocateComponents()` instead of LLM. |
| **Visual Designer** | Rich context RLM loop | ✅ Implemented | ✅ Complete | Fully implemented with validation loop. Minor: uses 2 attempts vs proposed 3 |
| **Spatial Layout Engine** | Zone allocation + hierarchy | ✅ Implemented | ✅ Complete | Full parity - affinity-aware allocation, visual weight, negative space |
| **Image Generator** | spatially-aware prompt | ✅ Implemented | ✅ Complete | Uses `visualDesignSpec.prompt_with_composition` |
| **PPTX Renderer** | Zone-aware rendering | ✅ Implemented | ✅ Complete | `renderWithSpatialAwareness()` places components in zones |

### Detailed Gap Analysis

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  GAP 1: Router Does Not Generate spatialZones[]                                         │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  PROPOSED:                                                                               │
│    Router outputs: { layoutVariant, renderMode, visualFocus, densityBudget,             │
│                      spatialZones[] ← NEW: Explicit zones }                              │
│                                                                                          │
│  CURRENT:                                                                                │
│    Router outputs: { layoutVariant, renderMode, visualFocus, densityBudget }            │
│    Zones derived from: LAYOUT_TEMPLATES[variant] in spatialRenderer.ts                  │
│                                                                                          │
│  IMPACT: LOW                                                                             │
│    - Static zone templates work well for predefined layouts                             │
│    - Dynamic zone generation would add complexity without clear benefit                 │
│    - Only matters for truly custom layouts (not currently supported)                    │
│                                                                                          │
│  RECOMMENDATION: Keep as-is unless custom layout generation is needed                   │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  GAP 2: No Dedicated Layout Generator Agent                                             │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  PROPOSED:                                                                               │
│    Separate agent: Layout Generator                                                      │
│    Input: contentPlan, routerConfig                                                     │
│    Output: layoutPlan { components[], spatialAllocations[] }                            │
│    Role: LLM decides which component goes where                                         │
│                                                                                          │
│  CURRENT:                                                                                │
│    Combined in: Generator (runGenerator)                                                │
│    spatialAllocations computed by: SpatialLayoutEngine.allocateComponents()             │
│    Role: Deterministic affinity-based allocation, not LLM                               │
│                                                                                          │
│  IMPACT: MEDIUM                                                                          │
│    - LLM-based allocation could be more context-aware                                   │
│    - But deterministic allocation is:                                                    │
│      ✓ Faster (no API call)                                                              │
│      ✓ Cheaper ($0 vs ~$0.02 per slide)                                                  │
│      ✓ Predictable (no hallucinated positions)                                           │
│      ✓ Already affinity-aware (matches comp type to zone purpose)                        │
│                                                                                          │
│  RECOMMENDATION: Keep deterministic allocation                                          │
│    - Current affinity algorithm handles 95% of cases well                               │
│    - Only consider LLM allocation for exotic custom layouts                             │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  GAP 3: Router Uses MODEL_SIMPLE, Not Pro with Thinking                                 │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  PROPOSED:                                                                               │
│    Router model: gemini-3-pro (with thinking)                                           │
│    Rationale: Complex spatial zone decisions need reasoning                             │
│                                                                                          │
│  CURRENT:                                                                                │
│    Router model: gemini-2.5-flash (MODEL_SIMPLE)                                        │
│    Rationale: Simple enum classification task, 79% cheaper                              │
│                                                                                          │
│  IMPACT: LOW (INTENTIONAL OPTIMIZATION)                                                 │
│    - Router is a classification task, not reasoning                                     │
│    - Output is 1 of 6 layout variants + enum fields                                     │
│    - 2.5 Flash handles this reliably at 0.1 temperature                                 │
│    - Cost savings: $0.03 → $0.006 per slide (79% reduction)                             │
│                                                                                          │
│  RECOMMENDATION: Keep MODEL_SIMPLE ✅                                                   │
│    - This is a deliberate optimization, not a gap                                       │
│    - Phil Schmid's best practice: simplest model that works                             │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  GAP 4: Visual Designer Uses MODEL_AGENTIC, Not Pro with Thinking                       │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  PROPOSED:                                                                               │
│    Visual Designer model: gemini-3-pro (with thinking)                                  │
│                                                                                          │
│  CURRENT:                                                                                │
│    Visual Designer model: gemini-3-flash-preview (thinkingLevel: 'low')                 │
│                                                                                          │
│  IMPACT: LOW (INTENTIONAL OPTIMIZATION)                                                 │
│    - Visual Designer output is ~1-2KB (small)                                           │
│    - Flash outperforms Pro on agentic benchmarks (78% vs 76.2%)                         │
│    - 'low' thinking is sufficient for spatial composition                              │
│    - Cost savings: ~71%                                                                  │
│                                                                                          │
│  RECOMMENDATION: Keep MODEL_AGENTIC with 'low' thinking ✅                              │
│    - This is a deliberate optimization based on benchmark data                          │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  GAP 5: RLM Loop MAX_ATTEMPTS                                                           │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  PROPOSED:                                                                               │
│    MAX ATTEMPTS: 3                                                                       │
│    Returns best attempt with warnings after max                                         │
│                                                                                          │
│  CURRENT:                                                                                │
│    Visual Designer: MAX_ATTEMPTS = 2                                                    │
│    Generator: MAX_RETRIES = 2 (+ circuit breaker)                                       │
│                                                                                          │
│  IMPACT: NEGLIGIBLE                                                                      │
│    - 2 attempts handles 95%+ of cases                                                   │
│    - Circuit breaker prevents wasted API calls                                          │
│    - 3rd attempt rarely adds value (same prompt, same errors)                           │
│                                                                                          │
│  RECOMMENDATION: Keep at 2     │
│    - If needed, implement smarter retry with gradient prompting                         │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Implementation Scorecard

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                        PROPOSED vs CURRENT - SCORECARD                                   │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  METRIC                                │  PROPOSED      │  CURRENT      │  STATUS       │
│  ───────────────────────────────────── │ ────────────── │ ────────────  │ ───────────── │
│  Visual Focus Usage                    │  100%          │  100%         │  ✅ MATCH     │
│  Layout-Visual Alignment               │  Automated     │  Automated    │  ✅ MATCH     │
│  Negative Space Control                │  10-40%        │  10-40%       │  ✅ MATCH     │
│  Component Positioning                 │  Zone-based    │  Zone-based   │  ✅ MATCH     │
│  Validation Coverage                   │  Text+Visual   │  Text+Visual  │  ✅ MATCH     │
│  RLM Loop                              │  Visual+       │  Visual+      │  ✅ MATCH     │
│  Spatial Zones Source                  │  Router LLM    │  Static       │  ⚠️ SIMPLER  │
│  Layout Allocation                     │  LLM           │  Affinity     │  ⚠️ SIMPLER  │
│  Router Model                          │  Pro           │  2.5 Flash    │  ✅ OPTIMIZED │
│  Visual Designer Model                 │  Pro           │  Flash        │  ✅ OPTIMIZED │
│  Cost per Deck                         │  ~$0.45        │  ~$0.18       │  ✅ 60% LESS  │
│                                                                                          │
│  OVERALL: Current implementation achieves architectural goals with BETTER cost          │
│           efficiency through strategic model tier optimization.                          │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Conclusion

The current implementation is **architecturally superior** in the following ways:

| Aspect | Proposed | Current | Winner |
|--------|----------|---------|--------|
| **Cost Efficiency** | ~$0.45/deck | ~$0.18/deck | ✅ Current (60% cheaper) |
| **Latency** | Higher (more Pro calls) | Lower (Flash priority) | ✅ Current |
| **Model Selection** | Pro for complex tasks | Flash everywhere (beats Pro on agentic) | ✅ Current |
| **Zone Allocation** | LLM-based | Affinity algorithm | 🔄 Trade-off (simpler is faster) |
| **Spatial Awareness** | Full | Full | ✅ Match |
| **Visual Designer RLM** | Yes | Yes | ✅ Match |
| **Validation Pipeline** | Full | Full | ✅ Match |

**The only true gap is that Router does not dynamically generate `spatialZones[]`**, but this is mitigated by:
1. Static `LAYOUT_TEMPLATES` covering all 6 layout variants
2. `SpatialLayoutEngine.getZonesForVariant()` provides equivalent functionality
3. Dynamic zones would add API cost without clear quality improvement

**Recommendation**: No changes needed. Current architecture is a refined evolution of the proposed design, optimized for cost and performance based on real-world model benchmarks.

---

*Last Updated: 2026-01-20*
