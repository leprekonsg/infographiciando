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

**Circuit Breaker:** Low fit score or critical validation issues trigger reroute with layout constraints.

---

## 5) System 2 Visual Critique (Current)

**Internal Critique (always available):**
- `runVisualCritique()` → lightweight layout critique (MODEL_SIMPLE)

**External Critique (optional, Node-only):**
- `visualCortex.getVisualCritiqueFromSvg()`
- SVG proxy → PNG (resvg) → Qwen3-VL
- Used for richer issue detection and spatial diagnostics

**Repair loop:**
- Critique issues inform `runLayoutRepair()` when needed
- Bounded recursion (MAX_ROUNDS=3) with persistent-issue detection

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
| [services/interactionsClient.ts](../services/interactionsClient.ts) | Interactions API client + CostTracker |
| [services/visualDesignAgent.ts](../services/visualDesignAgent.ts) | Visual Designer + Critique + Repair |
| [services/spatialRenderer.ts](../services/spatialRenderer.ts) | Layout templates + zone allocation |
| [services/infographicRenderer.ts](../services/infographicRenderer.ts) | Slide compilation + color normalization |
| [services/visualCortex.ts](../services/visualCortex.ts) | Qwen-VL integration (Node-only) |
| [services/visualRasterizer.ts](../services/visualRasterizer.ts) | resvg-based SVG → PNG rasterization |
| [services/image/imageGeneration.ts](../services/image/imageGeneration.ts) | Gemini Image generation (Flash → Pro fallback) |
| [types/slideTypes.ts](../types/slideTypes.ts) | Zod schemas + shared types |

---

## 12) Model Allocation (Current)

| Agent/Task | Model | Thinking | Notes |
|------------|-------|----------|------|
| Researcher | gemini-3-flash-preview | low | Agentic research + grounding |
| Architect | gemini-3-flash-preview | medium | Narrative + outline planning |
| Router | gemini-2.5-flash | none | Enum classification |
| Content Planner | gemini-3-flash-preview | low | Key points & data points |
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

**Status**: ✅ Current implementation documented. Only active architecture is retained.
