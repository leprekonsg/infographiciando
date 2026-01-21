# InfographIQ

**AI-Powered Slide Deck Generation with Autonomous Agents**

InfographIQ transforms a simple topic into a professional, data-driven presentation using a coordinated swarm of specialized AI agents. Built on Google's Gemini Interactions API with strategic model tier optimization.

---

## Architecture

The system employs a multi-agent pipeline where each agent has a focused responsibility:

```
Topic → Researcher → Architect → Router → Content Planner → Visual Designer → Generator → Renderer → PPTX
```

### Agent Pipeline

| Agent | Model | Role |
|-------|-------|------|
| **Researcher** | Gemini 3 Flash | Extracts 8-12 verified facts via Google Search grounding |
| **Architect** | Gemini 3 Flash | Structures narrative arc, clusters facts, defines style guide |
| **Router** | Gemini 2.5 Flash | Classifies layout variant and render mode per slide |
| **Content Planner** | Gemini 3 Flash | Extracts key points and data from assigned fact clusters |
| **Visual Designer** | Gemini 3 Flash | Creates spatial composition spec with color harmony |
| **Generator** | Gemini 3 Flash | Produces final slide JSON with component layout |
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

- **Agentic Generation** — Full deck creation with real-time agent activity feed
- **Spatial Layout Engine** — Zone-based component allocation with affinity matching
- **Visual Design RLM Loop** — Iterative refinement with validation feedback
- **Auto-Repair Pipeline** — Deterministic JSON normalization and component type mapping
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
# Install dependencies
npm install

# Set API key in .env
echo "GEMINI_API_KEY=your_key_here" > .env

# Start development server
npm run dev
```

Open `http://localhost:5173`, enter a topic, and watch the agents work.

---

## Qwen-VL Visual Architect (Optional)

Qwen-VL powers the visual critique/repair loop. It requires a small Node backend for SVG → PNG rasterization and the DashScope API call.

### Environment Variables
- `GEMINI_API_KEY` — Required for Gemini Interactions API
- `DASHSCOPE_API_KEY` or `QWEN_API_KEY` — Required for Qwen-VL
- `QWEN_VL_PROXY_URL` — Base URL of the local Qwen-VL proxy (e.g., `http://localhost:8787`)

### Local Setup
```bash
# Terminal 1: start Qwen-VL proxy server (Node-only)
npm run qwen:server

# Terminal 2: start the Vite app
npm run dev
```

If `QWEN_VL_PROXY_URL` is not set, the app will fall back to the internal visual critique only.

---

## Project Structure

```
├── App.tsx                     # Main application
├── components/
│   ├── SlideDeckBuilder.tsx    # Agentic builder UI + PPTX export
│   ├── BuilderCanvas.tsx       # Slide preview with spatial zones
│   └── ActivityFeed.tsx        # Real-time agent logs
├── services/
│   ├── interactionsClient.ts   # Gemini Interactions API client
│   ├── slideAgentService.ts    # Agent orchestration
│   ├── visualDesignAgent.ts    # Visual composition agent
│   ├── spatialRenderer.ts      # Zone-based layout engine
│   └── validators.ts           # Schema + alignment validation
├── types/
│   └── slideTypes.ts           # Zod schemas
└── docs/
    ├── ARCHITECTURE_DIAGRAM.md # Full system blueprint
    └── MODEL_OPTIMIZATION.md   # Model tier decisions
```

---

## Component Types

The generator produces slides using these component primitives:

| Type | Description |
|------|-------------|
| `text-bullets` | Bulleted list with optional title |
| `metric-cards` | 2-6 stat cards with value, label, icon |
| `process-flow` | 3-5 step horizontal flow |
| `icon-grid` | 2-4 column grid with icons |
| `chart-frame` | Bar, pie, line, or doughnut chart |

---

## Validation

Each slide passes through:

1. **Schema Validation** — Zod parsing against `SlideNodeSchema`
2. **Auto-Repair** — Component type normalization, deduplication, garbage removal
3. **Visual Alignment** — Spatial zone compatibility check
4. **Density Check** — Text overflow and item count limits

Failed validation triggers the RLM loop for targeted regeneration.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture Diagram](docs/ARCHITECTURE_DIAGRAM.md) | Full system blueprint with gap analysis |
| [Model Optimization](docs/MODEL_OPTIMIZATION.md) | Model tier decisions and cost tracking |

---

## License

MIT
