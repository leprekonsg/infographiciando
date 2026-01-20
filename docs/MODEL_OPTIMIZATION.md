# InfographIQ Model Optimization Summary

## Overview

Based on [Phil Schmid's Agent Best Practices](https://www.philschmid.de/building-agents) and Gemini benchmark data, we've optimized the model selection across all agents in the InfographIQ pipeline.

**Key Insight**: Gemini 3 Flash **outperforms** 3 Pro on agentic benchmarks (78% vs 76.2% SWE-bench) while being 71% cheaper and 3x faster.

## Model Tiers

| Tier | Model | Use Case | Cost (Input/Output per 1M tokens) |
|------|-------|----------|-----------------------------------|
| `MODEL_AGENTIC` | gemini-3-flash-preview | Agent workflows, spatial reasoning, coding | $0.15 / $3.50 |
| `MODEL_SIMPLE` | gemini-2.5-flash | Classification, JSON structuring, pattern matching | $0.075 / $0.30 |
| `MODEL_REASONING` | gemini-3-pro-preview | Long-context synthesis (>1M tokens) - rarely needed | $2.00 / $12.00 |

## Agent Model Assignments (After Optimization)

| Agent | Previous Model | New Model | Savings | Rationale |
|-------|---------------|-----------|---------|-----------|
| **Researcher** | 3 Flash | 3 Flash ✓ | 0% | Already optimal for agentic search loops |
| **Architect** | 3 Pro | 3 Flash ↓ | **71%** | Structure planning is agentic workflow, Flash beats Pro |
| **Router** | 3 Flash | 2.5 Flash ↓ | **79%** | Simple enum classification, no deep reasoning needed |
| **Content Planner** | 3 Pro | 3 Flash ↓ | **71%** | Moderate reasoning for keyPoints extraction |
| **Generator** | 3 Pro | 3 Flash ↓ | **71%** | Agentic task with iterative validation |
| **Visual Designer** | 3 Pro | 3 Flash ↓ | **71%** | Spatial reasoning = agentic task, Flash excels |
| **JSON Repairer** | 3 Pro | 2.5 Flash ↓ | **95%** | Pattern repair, not synthesis - simplest tier sufficient |

## Configuration Changes

### Thinking Level Strategy (Carefully Analyzed)

The key insight: **thinkingLevel consumes output tokens**. We must assign thinking capability where it matters most:

| Agent | Thinking | Rationale |
|-------|----------|-----------|
| **Architect** | `'medium'` ✅ | **Strategic brain** of pipeline. Designs narrative arc, clusters facts, plans flow. Small output (~1KB) = thinking won't truncate |
| **Researcher** | `'low'` | Search/extraction task. Moderate complexity but mainly information retrieval |
| **Visual Designer** | `'low'` | Spatial composition is template-based, not deep reasoning |
| **Generator** | **None** ❌ | Formatting task, not reasoning. Large output (~3-5KB) = thinking was causing truncation |
| **Content Planner** | None | Simple summarization |
| **Router** | None | Simple enum classification |
| **JSON Repairer** | None | Pattern matching |

### Generator: Fixed JSON Truncation Issue
**Root Cause**: `thinkingLevel: 'medium'` was consuming output tokens, leaving only ~1000 chars for actual JSON.

- **Before**: `thinkingLevel: 'medium'`, `maxOutputTokens: 8192`
- **After**: No thinkingLevel (removed), `maxOutputTokens: 4096`
- **Schema**: Added explicit component type enum to prevent model improvisation
- **Prompt**: Added explicit component structure examples

### Generator: Explicit Component Schema
Added component type enum in schema to prevent model from generating invalid types:
```typescript
type: { 
    type: "string", 
    enum: ["text-bullets", "metric-cards", "process-flow", "icon-grid", "chart-frame"]
}
```

### Router: Reduced temperature
- **Before**: `temperature: 0.2`
- **After**: `temperature: 0.1` (more deterministic routing)

### JSON Repairer: Deterministic repair
- **Before**: `temperature: 0.1`
- **After**: `temperature: 0.0` (fully deterministic for pattern matching)

## Cost Impact (Estimated)

```
Previous: ~$0.45/deck (heavy Pro usage)
Optimized: ~$0.18/deck (model tier optimization)
Savings: ~60-70% cost reduction

Monthly (1000 decks):
  Before: $450
  After: $180
  Monthly Savings: $270
```

## Enhanced Cost Tracking

The `CostTracker` class now includes:
- **Savings calculation**: Tracks savings vs Pro baseline per API call
- **Model breakdown**: Shows calls and cost per model used
- **Console logging**: Real-time visibility into cost savings (`💰 [COST] ...`)

## Files Modified

1. **`services/interactionsClient.ts`**
   - Added `MODEL_AGENTIC`, `MODEL_SIMPLE`, `MODEL_REASONING` constants
   - Added `selectModelForTask()` utility function
   - Enhanced `CostTracker` with savings tracking

2. **`services/slideAgentService.ts`**
   - Imported model tiers from interactionsClient
   - Updated Architect, Router, Content Planner, Generator models
   - Reduced Generator thinkingLevel from 'high' to 'medium'
   - Enhanced orchestrator logging with savings breakdown

3. **`services/visualDesignAgent.ts`**
   - Updated to use `MODEL_AGENTIC`

4. **`services/geminiService.ts`**
   - Added `MODEL_SIMPLE` constant
   - Updated JSON Repairer to use `MODEL_SIMPLE`

## Validation

- ✅ TypeScript compilation passes (`npx tsc --noEmit`)
- ✅ All model constants properly exported and imported
- ✅ Cost tracking enhanced with savings calculation

## Best Practices Applied (Phil Schmid)

1. **Tool Definition & Ergonomics**: ✅ Already implemented (clear naming, meaningful errors)
2. **Context Engineering**: ✅ Already implemented (just-in-time loading, targeted queries)
3. **Don't Over-Engineer**: 
   - ✅ `max_iterations` escape hatch (15 iterations)
   - ✅ System instructions for guardrails
   - ✅ Logging for transparency
   - ⚠️ Future consideration: Consolidate agents (Architect + Content Planner?)

## JSON Truncation Bug Fixes (2026-01-20, Updated)

### Root Cause
The Generator agent was hitting `maxOutputTokens` mid-object, causing truncated JSON. Initial fix (model escalation to Pro) backfired because Pro uses reasoning tokens that reduce output budget, making truncation *worse*.

### Current Fixes

| Fix | Description |
|-----|-------------|
| **Ultra-Simple Schema** | Reduced `generatorSchema` nesting from 4+ levels to 2. Moved validation to `autoRepairSlide` post-hoc |
| **Compact Prompt** | Reduced componentExamples from 400+ chars to ~200 chars to save output tokens |
| **Always Flash** | Removed model escalation to Pro. Flash is faster, cheaper, and doesn't truncate |
| **Token Budget** | `maxOutputTokens`: 4096 (attempt 1) → 6144 (retries) |
| **Pre-Truncation** | Limits `keyPoints` to 5, `dataPoints` to 4 before prompt construction |
| **String-Array Fallback** | If JSON repair fails, detect `["item1", "item2"]` pattern and convert to text-bullets |
| **Circuit Breaker** | After 2+ failures, uses text-bullets fallback |

### Key Learning
**Do NOT use Pro for JSON generation.** Pro's reasoning tokens consume output budget, increasing truncation risk. Flash is better for structured output tasks.

### String-Array Fallback
When LLM returns `{"items": ["LLM = CPU", "Context = RAM"]}` instead of proper objects, the fallback catches it:
```typescript
// Detected pattern: ["item1", "item2", ...]
// Converted to:
{ layoutPlan: { components: [{ type: "text-bullets", content: [...] }] } }
```

## LLM Color Normalization (2026-01-20)

### Problem
The LLM generates creative color names that pptxgenjs can't parse:
- `"Slate Grey (708090)"` → pptx error: invalid color
- `"Electric Cyan and Neon Amber"` → pptx error: invalid color
- `"Electric Violet"` → pptx error: invalid color

### Solution
Added `normalizeColor()` function that:
1. **Extracts hex from parentheses**: `"Slate Grey (708090)"` → `"708090"`
2. **Finds hex in strings**: `"color #10B981 here"` → `"10B981"`
3. **Maps 100+ color names**: `"electricviolet"` → `"8B00FF"`
4. **Partial matching**: `"electric cyan and amber"` → extracts first valid color
5. **Graceful fallback**: Logs warning and uses default if unrecognized

### Files Modified
- `services/infographicRenderer.ts`: Added `normalizeColor()` with `COLOR_NAME_MAP`
- `services/spatialRenderer.ts`: Uses `normalizeColor()` for all palette colors
- `components/SlideDeckBuilder.tsx`: Uses `normalizeColor()` for PPTX background

### Example Transformations

| LLM Output | Normalized |
|------------|------------|
| `"Slate Grey (708090)"` | `"708090"` |
| `"Electric Violet"` | `"8B00FF"` |
| `"#10b981"` | `"10B981"` |
| `"Electric Cyan and Amber"` | `"00FFFF"` (first match) |

## Next Steps (For Review)

1. **Run end-to-end test** to verify pipeline functionality with new models
2. **Monitor production** for any quality regression
3. **Consider agent consolidation** to reduce API calls and latency
4. **Track truncation frequency** via `[JSON REPAIR]` log patterns
5. **Expand COLOR_NAME_MAP** if new LLM color names appear in logs
