# InfographIQ

**AI-Powered Slide Deck Generation with Adaptive Director Orchestration**

InfographIQ transforms a topic into a professional presentation using an adaptive Director agent that orchestrates specialized tools. Built on Google's Gemini Interactions API with strategic model tier optimization.

---

## Architecture

### Director Pipeline (v3.1)

The system uses a **non-linear state machine** where the Director can loop back to earlier tools when quality gates fail:

```
Topic → Director [
          RESEARCH → ARCHITECT → Per-Slide { ROUTE → PLAN → EVALUATE → (ENRICH?) }
                                                              ↑___________|
                                                        (loop back if thin)
       ] → PPTX
```

**Key Capability**: If slide content is thin, the Director triggers *targeted re-research* on that specific topic, enriches the fact pool, and retries content planning. This is the "Manus-level" non-linear orchestration.

### Agent Tools

| Tool | Model | Role |
|------|-------|------|
| **Researcher** | Gemini 3 Flash | Extracts 8-12 verified facts via Google Search grounding |
| **Architect** | Gemini 3 Flash | Structures narrative arc, clusters facts, defines style guide |
| **Router** | Gemini 2.5 Flash | Classifies layout variant and render mode per slide |
| **Content Planner** | Gemini 3 Flash | Extracts key points and data from assigned fact clusters |
| **Visual Designer** | Gemini 3 Flash | Creates spatial composition spec with color harmony |
| **Image Generator** | Gemini 3 Pro Image | Renders background visuals from composed prompts |

### Model Strategy

Based on [Phil Schmid's agent best practices](https://www.philschmid.de/building-agents), we use Gemini 3 Flash for most agents—it outperforms Pro on agentic benchmarks (78% vs 76.2% SWE-bench) while being 71% cheaper.

| Tier | Model | Use Case |
|------|-------|----------|
| `MODEL_AGENTIC` | gemini-3-flash-preview | Agent workflows, spatial reasoning |
| `MODEL_SIMPLE` | gemini-2.5-flash | Classification, JSON structuring |
| `MODEL_REASONING` | gemini-3-pro-preview | Reserved for >1M token context |

---

## Features

- **Adaptive Director** — Non-linear orchestration with quality-driven loop-back and targeted re-research
- **Silent Fallback** — Director failures silently route to legacy pipeline (zero user-facing errors)
- **Layered Spatial Engine** — Background → Decorative → Content → Overlay stack
- **Visual Architect (Qwen-VL)** — Vision-first critique and repair loop with SVG-to-PNG proxy
- **Auto-Repair Pipeline** — Deterministic JSON normalization with context-aware fallback recovery
- **PPTX Export** — Native PowerPoint output preserving layouts, images, and speaker notes
- **Cost Optimized** — ~$0.18/deck (60% savings vs naive Pro usage)

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript, Vite |
| AI SDK | `@google/genai` (Interactions API) |
| Validation | Zod (runtime schema validation) |
| Export | pptxgenjs (client-side PPTX generation) |
| Icons | Lucide React |

---

## Quick Start

```bash
npm install
echo "GEMINI_API_KEY=your_key_here" > .env
npm run dev
```

Open `http://localhost:5173`, enter a topic, and watch the Director work.

### Enable Director Mode

Set in `slideAgentService.ts`:
```typescript
export const ENABLE_DIRECTOR_MODE = true;  // Use adaptive Director
export const ENABLE_DIRECTOR_MODE = false; // Use legacy sequential pipeline
```

---

## Qwen-VL Visual Architect (Optional)

Qwen-VL powers the visual critique/repair loop. Requires Node backend for SVG → PNG rasterization.

```bash
# Set environment variables
DASHSCOPE_API_KEY=your_key_here
QWEN_VL_PROXY_URL=http://localhost:8787

# Start proxy server
npm run qwen:server
```

---

## Project Structure

```
├── services/
│   ├── DirectorAgent.ts        # Adaptive orchestrator (state machine)
│   ├── slideAgentService.ts    # Entry point + legacy pipeline
│   ├── interactionsClient.ts   # Gemini Interactions API client
│   ├── spatialRenderer.ts      # Zone-based layout engine
│   └── agents/                 # Tool implementations
│       ├── researcher.ts
│       ├── architect.ts
│       ├── router.ts
│       └── contentPlanner.ts
├── components/
│   ├── SlideDeckBuilder.tsx    # Builder UI + PPTX export
│   └── ActivityFeed.tsx        # Real-time agent logs
├── types/
│   └── slideTypes.ts           # Zod schemas
└── docs/
    ├── ARCHITECTURE_DIAGRAM.md # Full system blueprint
    └── MODEL_OPTIMIZATION.md   # Model tier decisions
```

---

## Quality Gates

The Director evaluates content at each slide:

| Gate | Threshold | Action on Fail |
|------|-----------|----------------|
| MIN_KEY_POINTS | 2 (1 for hero) | Targeted re-research |
| MIN_CHARS_PER_POINT | 20 | Targeted re-research |
| MIN_TOTAL_CHARS | 80 | Targeted re-research |
| MAX_ENRICHMENT_ATTEMPTS | 2 | Accept and continue |

---

## License

MIT
