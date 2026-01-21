# Visual Cortex Setup - Qwen-VL Integration

## Overview

The Visual Cortex service provides external visual validation using Qwen3-VL-Plus for:
- Bounding box detection
- Spatial issue identification
- Contrast analysis (WCAG compliance)
- Empty region detection

## Important: Node.js Only

The Visual Cortex uses `@resvg/resvg-js` for SVG rasterization, which is a **Node.js-only native module**. It **cannot run in the browser**.

**Current Architecture**: If running agents in the browser (via Vite), visual cortex features will be skipped with a warning. For full functionality, run the agent orchestration server-side.

See [ARCHITECTURE_NODE_BROWSER_SEPARATION.md](./ARCHITECTURE_NODE_BROWSER_SEPARATION.md) for details.

## Architecture: Two-Tier Rendering Pipeline

### Tier 1: Fast Path (Default) - SVG Proxy Rendering

**Pipeline**: SVG proxy → PNG (resvg-js) → Qwen-VL

**Performance**: ~200-500ms per critique

**Use For**:
- Iterative refinement in System 2 loop
- All standard slide generation

**Advantages**:
- ✅ Deterministic and fast
- ✅ No Chromium/browser dependency
- ✅ Works server-side in Node.js
- ✅ Perfectly aligned with existing SVG proxy architecture

**Limitations**:
- SVG rendering may differ slightly from PPTX text wrapping
- Font metrics approximated

**Render Fidelity**: `svg-proxy`

### Tier 2: Slow Path (Escalation) - PPTX Rendering

**Pipeline**: PPTX → LibreOffice → PDF → PNG → Qwen-VL

**Performance**: ~2-5s per critique

**Use For**:
- Persistent issues after 2+ SVG-based repairs
- Final quality gate before delivery
- When exact PPTX fidelity is critical

**Advantages**:
- ✅ Validates actual PPTX rendering
- ✅ Catches PPTX-specific text wrapping/font issues

**Limitations**:
- Requires LibreOffice + Ghostscript pipeline
- Slower (2-5s vs 200-500ms)
- More ops complexity

**Render Fidelity**: `pptx-render`

## Installation

### 1. Install Dependencies

```bash
npm install
```

This will install `@resvg/resvg-js` (added to package.json).

### 2. Configure Qwen-VL API Key

Set your DashScope API key as an environment variable:

```bash
# In .env file
DASHSCOPE_API_KEY=your_api_key_here

# OR alternative name
QWEN_API_KEY=your_api_key_here
```

Get your API key from: https://dashscope.console.aliyun.com/

### 3. Verify Setup

The Visual Cortex will automatically activate when:
- API key is configured
- System 2 visual critique is enabled
- A slide needs spatial validation

Check logs for:
```
[QWEN-VL] Fast path: SVG proxy → PNG → Qwen-VL
[SVG→PNG] Rasterized SVG to PNG (1920x1080), size: 245KB
[SYSTEM 2] Qwen-VL critique: score=85, verdict=accept, fidelity=svg-proxy
```

## Model & Pricing

**Model**: `qwen3-vl-plus-2025-12-19`
**Pricing**:
- Input: $0.2 per 1M tokens
- Output: $1.6 per 1M tokens

**Estimated Cost per Critique**:
- ~$0.002-0.005 per slide (typical)
- Includes image input tokens + JSON output tokens

## Integration Points

### System 2 Visual Critique Loop

Located in `services/slideAgentService.ts` → `runRecursiveVisualCritique()`

```typescript
// Automatic integration - no code changes needed
// Visual Cortex activates when Qwen-VL is available
if (isQwenVLAvailable()) {
    const critique = await getVisualCritiqueFromSvg(svgProxy, costTracker);
    // Uses critique results for repair decisions
}
```

### Manual Usage (Advanced)

```typescript
import { getVisualCritiqueFromSvg, getVisualCritiqueFromImage } from './services/visualCortex';

// Fast path: SVG proxy
const svgString = generateSvgProxy(slide, styleGuide);
const critique = await getVisualCritiqueFromSvg(svgString, costTracker);

// Slow path: Pre-rendered PPTX image
const pptxImageBase64 = await renderPptxToImage(slide);
const critique = await getVisualCritiqueFromImage(pptxImageBase64, 1920, 1080, costTracker);

// Check render fidelity
console.log(critique.renderFidelity); // "svg-proxy" or "pptx-render"
```

## Render Fidelity Contract

All critique results include a `renderFidelity` field:

```typescript
interface VisualCritiqueResult {
    overall_score: number;
    issues: Array<...>;
    empty_regions: Array<...>;
    renderFidelity: 'svg-proxy' | 'pptx-render';  // ← Render fidelity contract
}
```

This allows you to:
- Debug rendering mismatches
- Tune thresholds based on render method
- Escalate to PPTX rendering when needed

## Escalation Strategy (Future)

When to escalate from SVG proxy to PPTX rendering:

1. **Persistent Issues**: Same issue category appears 2+ times
2. **Critical Fit Score**: fit_score < 0.5 after max reroutes
3. **User Request**: Explicit PPTX-fidelity validation needed

```typescript
// Escalation logic (future enhancement)
if (truncationCount >= 2 && round >= 2) {
    console.warn('[SYSTEM 2] Escalating to PPTX render for fidelity validation');
    const pptxCritique = await getVisualCritiqueFromImage(...);
    // Use PPTX critique as authoritative
}
```

## Troubleshooting

### Qwen-VL Not Activating

Check:
1. API key is set: `echo $DASHSCOPE_API_KEY`
2. Logs show: `[QWEN-VL] Fast path: SVG proxy → PNG → Qwen-VL`
3. If you see `[QWEN-VL] Skipping visual critique - API not configured`, set the API key

### SVG Rasterization Fails

Check:
1. `@resvg/resvg-js` is installed: `npm list @resvg/resvg-js`
2. SVG has valid viewBox: `viewBox="0 0 1000 563"`
3. Logs show: `[SVG→PNG] Rasterized SVG to PNG`

### High Costs

Monitor costs with:
```typescript
const summary = costTracker.getSummary();
console.log('Qwen-VL cost:', summary.qwenVL?.cost || 0);
console.log('Qwen-VL calls:', summary.qwenVL?.calls || 0);
```

Optimize by:
- Using SVG proxy path (Tier 1) for iterative refinement
- Only using PPTX render path (Tier 2) for final validation
- Adjusting `VISUAL_REPAIR_ENABLED` threshold

## Performance Benchmarks

| Operation | Time | Cost |
|-----------|------|------|
| SVG → PNG (resvg) | ~50-100ms | Free |
| Qwen-VL Critique (SVG) | ~200-400ms | $0.002-0.004 |
| Qwen-VL Critique (PPTX) | ~2-5s | $0.003-0.006 |
| Full System 2 Loop (3 rounds) | ~1-2s | $0.006-0.012 |

## References

- Qwen-VL Documentation: https://help.aliyun.com/zh/model-studio/developer-reference/qwen-vl-plus
- DashScope API: https://dashscope.console.aliyun.com/
- resvg-js: https://github.com/yisibl/resvg-js
