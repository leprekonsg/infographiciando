# InfographIQ Architecture (Current)

> **Updated**: 2026-01-22  
> **Version**: 3.0 (Current Implementation)

---

## 1) Executive Overview

InfographIQ is a **client-first, agent-orchestrated** slide generation system. It uses a multi-agent pipeline to transform a topic into a structured deck, then renders slides with spatially-aware layouts and optional visual critique.

Key characteristics:
- **Agentic orchestration** with Interactions API and structured JSON outputs.
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
│      FRONTEND         │              │       AGENT LAYER        │
│   React + Vite        │◄────────────►│   Multi-Agent Pipeline   │
│                       │              │  (Research → Generate)   │
└───────────────────────┘              └──────────────────────────┘
                         │                                   │
                         ▼                                   ▼
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
- Agent orchestration
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

## 4) Agentic Pipeline (Current)

```
INPUT: topic (string)
     │
     ▼
AGENT 1: Researcher (MODEL_AGENTIC, Interactions API)
     └─ outputs ResearchFact[] (8–12 facts)
     │
     ▼
AGENT 2: Architect (MODEL_AGENTIC, thinking=medium)
     └─ outputs Outline (narrativeGoal, styleGuide, slides[])
     │
     ▼
FOR EACH SLIDE (sequential, with context folding)
     ├─ Router (MODEL_SIMPLE) → RouterDecision
     ├─ Content Planner (MODEL_AGENTIC, thinking=low) → ContentPlan
     ├─ Composition Architect (MODEL_AGENTIC) → CompositionPlan
     ├─ Qwen Layout Selector (optional, Node-only) → RouterDecision override
     ├─ Visual Designer (MODEL_AGENTIC, thinking=low) → VisualDesignSpec
     └─ Generator (MODEL_AGENTIC, thinking=none)
           ├─ auto-repair + schema validation
           ├─ System 2 visual critique (optional)
           └─ circuit-breaker reroute (max 2)
     │
     ▼
Image Generator (Gemini Image: 2.5 Flash → Pro fallback)
     └─ outputs backgroundImageUrl (data URL)
     │
     ▼
OUTPUT: EditableSlideDeck
```

**Context Folding:** The last 2 slides are passed into content planning and generation as narrative trail.

**Serendipity DNA:** On first slide, the Architect's styleGuide is converted to `SerendipityDNA` (motifs, texture, gridRhythm) which governs the variation strategy for the entire deck.

**Variation Budgeting:** Each slide is assigned a `VariationBudget` (computeDetailedVariationBudget) based on its index and type, controlling how much the Composition Architect can deviate from standard patterns.

**Circuit Breaker:** Low fit score or critical validation issues trigger reroute with layout constraints.

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
