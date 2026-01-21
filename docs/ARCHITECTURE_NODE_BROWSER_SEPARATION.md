# Architecture: Node.js vs Browser Code Separation

## Problem Statement

This codebase runs LLM agent logic (Gemini API, Qwen-VL) directly in the browser via Vite. This creates architectural constraints when using Node.js-only dependencies like `@resvg/resvg-js` (native modules).

## Current Architecture

```
Browser (Vite Bundle)
  └─ SlideDeckBuilder.tsx
     └─ slideAgentService.ts (generateAgenticDeck)
        └─ visualCortex.ts (dynamic import)
           └─ visualRasterizer.ts (dynamic import)
              └─ @resvg/resvg-js (Node-only native module)
```

## File Separation Strategy

### Node-Only Files

**`services/visualRasterizer.ts`**
- Uses `@resvg/resvg-js` (native C++ bindings)
- Runtime guard: `if (typeof window !== 'undefined') throw`
- Only imported dynamically via `await import()`

### Hybrid Files (Work in Both)

**`services/visualCortex.ts`**
- No direct imports of Node-only modules
- Dynamically imports `visualRasterizer.ts` when needed
- Runtime guard before calling rasterization

**`services/slideAgentService.ts`**
- Dynamically imports `visualCortex.ts`
- Works in browser (Gemini API calls)
- Visual cortex features only activate in Node context

### Browser-Safe Files

**`components/SlideDeckBuilder.tsx`**
- Pure React component
- No direct Node module dependencies
- Calls service layer agnostic to runtime

## How Dynamic Imports Protect Against Bundling

### Problem: Static Imports
```typescript
// ❌ BAD: Vite tries to bundle this immediately
import { svgToPngBase64 } from './visualRasterizer';
// Vite sees @resvg/resvg-js import → tries to bundle → FAILS
```

### Solution: Dynamic Imports
```typescript
// ✅ GOOD: Vite defers loading until runtime
const { svgToPngBase64 } = await import('./visualRasterizer');
// Vite creates separate chunk, only loads if code path executes
```

### Runtime Guards
```typescript
// Double protection
if (typeof window !== 'undefined') {
    throw new Error('This code requires Node.js');
}
const { svgToPngBase64 } = await import('./visualRasterizer');
```

## Vite Configuration

```typescript
// vite.config.ts
optimizeDeps: {
  exclude: ['@resvg/resvg-js'] // Don't pre-bundle
},
build: {
  rollupOptions: {
    external: ['@resvg/resvg-js'] // Don't include in final bundle
  }
}
```

## When Code Runs Where

| Feature | Browser | Node.js | Notes |
|---------|---------|---------|-------|
| Gemini API calls | ✅ | ✅ | Uses fetch, works everywhere |
| Qwen-VL API calls | ✅ | ✅ | Uses fetch, works everywhere |
| SVG generation | ✅ | ✅ | Pure string manipulation |
| SVG → PNG rasterization | ❌ | ✅ | Requires native modules |
| Visual critique (without raster) | ✅ | ✅ | Can work with pre-rendered images |
| Visual critique (SVG path) | ❌ | ✅ | Needs rasterization |

## Call Flow Example

### Scenario: User generates deck in browser

```
1. Browser: User clicks "Generate Deck"
   └─ SlideDeckBuilder.tsx calls generateAgenticDeck()

2. Browser: Agent orchestration runs
   └─ slideAgentService.ts executes (in browser!)
   └─ Researcher, Architect, Router agents call Gemini (via fetch)

3. Browser: Visual critique attempted
   └─ System 2 loop tries: await import('./visualCortex')
   └─ visualCortex.ts loads successfully
   └─ Calls svgToPngBase64()
   └─ Runtime guard detects window !== undefined
   └─ Throws error: "Requires Node.js environment"
   └─ Caught, logged, generation continues without visual critique

4. Browser: Deck completes
   └─ Slides generated using internal validation only
   └─ Visual critique skipped (no rasterization)
```

### Scenario: Backend server generates deck (future)

```
1. Server: API receives POST /api/generate-deck
   └─ Node.js service calls generateAgenticDeck()

2. Server: Agent orchestration runs
   └─ slideAgentService.ts executes (in Node!)
   └─ All agents call Gemini APIs

3. Server: Visual critique runs fully
   └─ System 2 imports visualCortex.ts
   └─ Calls svgToPngBase64()
   └─ Runtime guard passes (window === undefined)
   └─ Dynamic import loads visualRasterizer.ts
   └─ Rasterization succeeds
   └─ PNG sent to Qwen-VL for analysis

4. Server: Returns complete deck with visual validation
```

## Future Architectural Improvements

### Option 1: Backend API (Recommended)

Create a separate Node.js server:

```
/api/generate-deck
  └─ Node.js Express/Fastify server
  └─ Calls slideAgentService.ts (server-side)
  └─ Full visual cortex features available
  └─ Returns completed deck to browser

Browser:
  └─ Calls /api/generate-deck via fetch
  └─ Shows progress via streaming/polling
  └─ No agent logic in browser bundle
```

Benefits:
- Full feature support (rasterization, native modules)
- Smaller browser bundle
- Better security (API keys on server)
- Easier rate limiting and caching

### Option 2: Conditional Features

Keep current architecture, document limitations:

```typescript
// In browser: Visual critique disabled
if (typeof window !== 'undefined') {
    console.warn('[Visual Cortex] Rasterization not available in browser');
    // Fall back to internal validation only
}
```

## Testing the Separation

### Verify Vite Can Bundle

```bash
npm run build
# Should succeed without @resvg/resvg-js errors
```

### Verify Runtime Behavior

```typescript
// In browser console
try {
    const { svgToPngBase64 } = await import('./services/visualRasterizer');
    // Should throw: "Cannot run in browser context"
} catch (e) {
    console.log('Expected error:', e.message);
}
```

### Verify Node.js Works

```typescript
// In Node.js REPL
const { svgToPngBase64 } = await import('./services/visualRasterizer.js');
const svg = '<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="red"/></svg>';
const png = svgToPngBase64(svg, 1920, 1080);
console.log('PNG size:', png.length); // Should output base64 string length
```

## Key Takeaways

1. **Never use static imports for Node-only modules** in code that might be bundled by Vite
2. **Always use dynamic imports** (`await import()`) for conditional loading
3. **Add runtime guards** (`typeof window !== 'undefined'`) before Node-only operations
4. **Configure Vite** to exclude/externalize native modules
5. **Document limitations** clearly when features only work in specific environments

## References

- [Vite Build Options](https://vitejs.dev/config/build-options.html)
- [Rollup External Modules](https://rollupjs.org/configuration-options/#external)
- [Dynamic Imports in JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import)
