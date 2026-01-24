# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**InfographIQ** is an AI-powered slide deck generation platform. It transforms a topic into professional presentations using a coordinated swarm of 6 specialized LLM agents, each optimized for specific tasks. The system emphasizes cost efficiency (60% cheaper than naive Pro usage) through strategic model tier selection based on Phil Schmid's agent best practices.

**Core Architecture**: Topic → Researcher → Architect → (Router/Content Planner/Visual Designer in parallel) → Generator → Image Generator → PPTX Export

## Commands

### Development
```bash
npm run dev          # Start dev server on http://localhost:3000
npm run build        # Production build (outputs to dist/)
npm run preview      # Preview production build locally
```

### Environment Setup
```bash
# Create .env file in project root
echo "GEMINI_API_KEY=your_api_key_here" > .env

# Get API key from: https://aistudio.google.com/app/apikey
# The app will not run without this key configured
```

### Quick Local Testing
- Open http://localhost:3000 after running `npm run dev`
- Test "Agentic View" with a sample topic (e.g., "quantum computing", "history of aviation")
- Watch real-time agent logs in ActivityFeed
- Export generated deck as PPTX

## High-Level Architecture

The system is organized into three layers:

### 1. **Agent Orchestration** (services/slideAgentService.ts)
Sequential agent pipeline executed via `generateAgenticDeck()`:
- **Researcher** (Gemini 3 Flash, thinking='low'): Extracts 8-12 verified facts via Google Search grounding
- **Architect** (Gemini 3 Flash, thinking='medium'): Plans narrative arc, clusters facts, defines global style guide
- **Router** (Gemini 2.5 Flash, thinking=none): Classifies layout variant for each slide (6 options)
- **Content Planner** (Gemini 3 Flash): Extracts key points and data from fact clusters
- **Composition Architect** (Gemini 3 Flash): Plans layer stack and "surprise slots" (badges, accents)
- **Visual Designer** (Gemini 3 Flash): Plans spatial composition with color harmony and RLM loop
- **Generator** (Gemini 3 Flash): Produces final slide JSON with component layout (5 component types)
- **Image Generator** (Gemini 3 Pro Image): Renders background visuals from composed prompts

**Key Principle**: Flash outperforms Pro on agentic benchmarks (78% vs 76.2% SWE-bench), so Flash is used everywhere except image generation.

### 2. **Data Flow** (types/slideTypes.ts)
Zod schemas define the shape of data at each pipeline stage:
- `ResearchFact[]` → `Outline` (with `factClusters`, `styleGuide`, `slides[]`)
- `Outline` → Per-slide: `RouterDecision`, `ContentPlan`, `VisualDesignSpec`
- All above → `SlideNode` (with `layoutPlan` containing 5 component types)
- `SlideNode[]` → `EditableSlideDeck` (exported as PPTX)

### 3. **Spatial Rendering** (services/spatialRenderer.ts + services/infographicRenderer.ts)
Zone-based layout engine converts component data to visual elements:
- 6 layout templates (standard-vertical, split-left-text, split-right-text, hero-centered, bento-grid, timeline-horizontal)
- Affinity-based allocation: semantic components → matching zones (e.g., titles to hero zones)
- Color normalization handles LLM creative color names ("Electric Violet" → hex)
- Compiled to VisualElement[] for PPTX rendering

## Component Types

The Generator outputs slides using 5 primitives (enforced via schema):

| Type | Description | Max Items | Example |
|------|-------------|-----------|---------|
| `text-bullets` | Bulleted list with optional title | 5 bullets | • Point 1, • Point 2 |
| `metric-cards` | Stat cards with value, label, icon, trend | 2-6 cards | "42M users" with 📈 icon |
| `process-flow` | Horizontal steps with descriptions | 3-5 steps | Step 1 → Step 2 → Step 3 |
| `icon-grid` | Icon grid with labels and descriptions | 3-8 items | 2-4 column layout |
| `chart-frame` | Bar, pie, line, or doughnut chart | 1 per slide | Sales trend over 12 months |

## Model Tier Strategy

```
MODEL_AGENTIC   = gemini-3-flash-preview    ($0.15/$3.50 per 1M tokens)
MODEL_SIMPLE    = gemini-2.5-flash          ($0.075/$0.30 per 1M tokens)
MODEL_REASONING = gemini-3-pro-preview      ($2.00/$12.00 per 1M tokens - rarely used)
```

**Assignment Logic**:
- Agentic workflows (reasoning, multi-step): `MODEL_AGENTIC`
- Classification/JSON structuring: `MODEL_SIMPLE`
- Never escalate to Pro for slide generation (output truncation risk)

**Cost Per Deck**: ~$0.18 (vs $0.45 naive Pro usage = 60% savings)

## Key Files & Their Roles

### Core Pipeline
- **slideAgentService.ts** — Orchestrator: `generateAgenticDeck()`, `runResearcher()`, `runArchitect()`, `runRouter()`, `runContentPlanner()`, `runGenerator()`, `autoRepairSlide()`
- **interactionsClient.ts** — Gemini Interactions API wrapper: `runAgentLoop()`, `createJsonInteraction()`, `CostTracker`, `AgentLogger`
- **visualDesignAgent.ts** — Visual Designer agent with RLM validation loop: `runVisualDesigner()`

### Data & Validation
- **types/slideTypes.ts** — All Zod schemas (ResearchFact, Outline, RouterDecision, SlideNode, etc.) and type exports
- **validators.ts** — `validateSlide()` (schema + alignment), `validateVisualLayoutAlignment()`, density/overflow checks

### Rendering
- **spatialRenderer.ts** — Layout templates, `allocateComponents()` (affinity algorithm), zone management
- **infographicRenderer.ts** — `compileSlide()`, color normalization, VisualElement compilation
- **promptRegistry.ts** — Centralized prompt templates for each agent (PROMPTS.RESEARCHER, etc.)

### UI Components
- **App.tsx** — View switching (Quick/Agentic), mode toolbar
- **SlideDeckBuilder.tsx** — Agentic workflow UI, progress tracking, PPTX export via pptxgenjs
- **BuilderCanvas.tsx** — Slide grid preview with spatial zones
- **ActivityFeed.tsx** — Real-time agent logs
- **Header.tsx, MarkdownInput.tsx, ResultPreview.tsx** — Quick mode UI

## Error Handling Patterns

### Auto-Repair Pipeline
Slides undergo deterministic normalization before validation:
1. **Component Type Mapping** — `autoRepairSlide()` normalizes LLM-generated type names (100+ mappings: 'text-block' → 'text-bullets', 'stats' → 'metric-cards', etc.)
2. **Deep JSON Parsing** — Handles nested JSON strings and malformed objects
3. **Garbage Removal** — Strips text <2 chars, numeric-only items, etc.
4. **Schema Validation** — Zod validation with actionable errors

### Circuit Breaker Pattern
- **Generator**: MAX_RETRIES=2. On failure → text-bullets fallback, never breaks entire deck
- **Model Failures**: Tracks failures per model, 60s cooldown for Pro, fallback chain (Pro → Flash → 2.0 Flash → Lite)
- **Orchestrator**: Each slide has try/catch. Failed slides → fallback slide with warning, deck generation continues

### JSON Truncation Mitigation
Root cause: Thinking level consumes output tokens. Solutions applied:
- Generator: No thinking level (output ~3-5KB)
- Architect: thinking='medium' (output ~1KB = safe)
- Pre-truncation: keyPoints limited to 5, dataPoints to 4
- String-array fallback: Detects ["item1", "item2"] and converts to text-bullets

## Common Development Tasks

### Adding a New Agent
1. Create `runNewAgent()` function in slideAgentService.ts
2. Define Zod schema for output in types/slideTypes.ts
3. Add prompt template in promptRegistry.ts
4. Call via `runAgentLoop()` (Interactions API) or `createJsonInteraction()` (structured output)
5. Integrate into `generateAgenticDeck()` orchestrator
6. Add activity logging: `agentLogger.logAgentStep()`

### Modifying Component Types
1. Add new type to `TemplateComponentSchema` discriminated union in types/slideTypes.ts
2. Add mapping in `COMPONENT_TYPE_MAP` in slideAgentService.ts
3. Add rendering logic in infographicRenderer.ts: `compileSlide()` switch statement
4. Add layout zone in spatialRenderer.ts: update `LAYOUT_TEMPLATES` if needed
5. Update Generator prompt in promptRegistry.ts: add component examples

### Tuning Model Selection
All model assignments are in interactionsClient.ts (MODEL_AGENTIC, MODEL_SIMPLE, MODEL_REASONING constants) and agent invocations use `modelConfig` parameter. Changes apply globally.

### Debugging Agent Behavior
- ActivityFeed component displays real-time agent logs via agentLogger
- CostTracker logs token usage and cost breakdown to console
- Each agent call is wrapped in try/catch with descriptive error messages
- PROMPTS registry centralizes all LLM instructions for easy inspection

## Testing Notes

- **No test suite**: Project focuses on integration testing via real API calls
- **Manual testing**: Use dev server with sample topics to verify end-to-end flow
- **Cost tracking**: Every deck generation logs cost breakdown and savings vs Pro baseline
- **Validation**: Run `npm run build` to catch TypeScript errors early (strict mode enabled)

## Important Gotchas

1. **API Key Required**: App crashes at runtime without GEMINI_API_KEY. Set via .env, not hardcoded.
2. **Interactions API**: Uses multi-turn conversation (not generateContent). Client-side tool execution loop required for web_search.
3. **Flash Preference**: Never escalate Generator to Pro (risks truncation). Flash + deterministic repair handles 99% of cases.
4. **Thinking Levels**: Only use thinking on small outputs (<1KB expected). Generator disabled thinking entirely.
5. **Model Tier Optimization**: Router uses MODEL_SIMPLE intentionally (79% cheaper, classification task). Not a bug.
6. **Component Type Normalization**: Rely on auto-repair first. Only fix in COMPONENT_TYPE_MAP if pattern is systematic.
7. **Spatial Zones**: Static templates (6 layouts) cover 95% of use cases. Dynamic zone generation adds cost without clear benefit.

## Code Style & Patterns

- **TypeScript with strict mode**: tsconfig.json has strict checking enabled
- **Zod for runtime validation**: All external data validated before use (api responses, user input)
- **Error messages**: Actionable, suggest fixes (e.g., "API_KEY is not configured. Set in .env")
- **Comments**: Minimal. Code structure and Zod schemas are self-documenting
- **Path alias**: Use `@/` for imports (e.g., `@/types/slideTypes` = `./types/slideTypes`)

## Documentation References

- **ARCHITECTURE_DIAGRAM.md** — Full system blueprint with gap analysis vs proposed design
- **MODEL_OPTIMIZATION.md** — Model tier decisions and cost analysis
- **README.md** — User-facing overview
