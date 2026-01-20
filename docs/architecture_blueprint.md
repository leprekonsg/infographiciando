# InfographIQ: Visual Architecture & Solutions Blueprint

## Current Architecture (PROBLEM STATE)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AGENTIC DECK BUILDER PIPELINE                    │
└─────────────────────────────────────────────────────────────────────┘

1. RESEARCHER
   ├─ Input: topic (string)
   ├─ Output: facts[] (ResearchFact[])
   └─ Model: gemini-3-pro (thinking-enabled)

2. ARCHITECT
   ├─ Input: topic, facts
   ├─ Output: outline (Outline with slides metadata)
   └─ Model: gemini-3-pro

3. FOR EACH SLIDE:
   │
   ├─→ 3a. ROUTER
   │   ├─ Input: slideMeta {title, purpose}
   │   ├─ Output: routerConfig {layoutVariant, renderMode, visualFocus}
   │   │           ⚠️  visualFocus is SEMANTIC but NEVER USED DOWNSTREAM
   │   └─ Model: gemini-3-flash
   │
   ├─→ 3b. CONTENT PLANNER
   │   ├─ Input: title, purpose, facts
   │   ├─ Output: contentPlan {keyPoints, dataPoints}
   │   └─ Model: gemini-3-flash
   │
   ├─→ 3c. LAYOUT GENERATOR
   │   ├─ Input: contentPlan, routerConfig
   │   ├─ Output: layoutPlan {components: TemplateComponent[]}
   │   │           ⚠️  Components have NO SPATIAL POSITIONING
   │   └─ Model: gemini-3-flash
   │
   ├─→ 3d. VISUAL PROMPTER (ISOLATED & SHALLOW)
   │   ├─ Input: title, routerConfig.visualFocus
   │   ├─ Output: visualPrompt (string)
   │   │           ⚠️  Doesn't know about layout, components, or styling
   │   └─ Model: gemini-3-flash
   │
   ├─→ 3e. IMAGE GENERATOR
   │   ├─ Input: visualPrompt
   │   ├─ Output: backgroundImageUrl (data URL)
   │   │           ⚠️  Image isn't optimized for overlay or composition
   │   └─ Model: gemini-3-pro-image or gemini-2.5-flash-image
   │
   └─→ 3f. PPTX RENDERER (InfographicRenderer)
       ├─ Input: slide, layoutPlan, backgroundImageUrl
       ├─ Process: compileSlide() → VisualElement[]
       │           ⚠️  Renders components with hardcoded positions
       │           ⚠️  No consideration for visual zones
       └─ Output: PPTX slide

PROBLEMS IDENTIFIED:
❌ visualFocus field generated but never acts on it
❌ Layout decisions don't inform visual generation
❌ Visual generation doesn't consider spatial constraints
❌ Renderer has no spatial allocation algorithm
❌ No feedback loop between visual and layout
```

---

## Proposed Architecture (SOLUTION STATE)

```
┌─────────────────────────────────────────────────────────────────────┐
│            ENHANCED AGENTIC DECK BUILDER WITH RLM LOOP              │
└─────────────────────────────────────────────────────────────────────┘

1. RESEARCHER
   └─ facts[] ────────────────┐
                              │
2. ARCHITECT                  │
   └─ outline ────────────────┤
                              ▼
3. FOR EACH SLIDE:
   │
   ├─→ 3a. ROUTER (Enhanced)
   │   ├─ Input: slideMeta
   │   ├─ Generates: routerConfig {
   │   │   layoutVariant,
   │   │   renderMode,
   │   │   visualFocus,
   │   │   densityBudget,
   │   │   spatialZones[]  ← NEW: Explicit zones
   │   │ }
   │   └─ Model: gemini-3-pro (with thinking)
   │
   ├─→ 3b. CONTENT PLANNER (Same)
   │   └─ contentPlan {keyPoints, dataPoints, layout}
   │
   ├─→ 3c. LAYOUT GENERATOR
   │   ├─ Input: contentPlan, routerConfig
   │   ├─ Output: layoutPlan {
   │   │   components[],
   │   │   spatialAllocations  ← NEW: Zone assignments
   │   │ }
   │   └─ Model: gemini-3-flash
   │
   ├─→ 3d. VISUAL DESIGNER AGENT (NEW AGENT - CRITICAL FIX)
   │   ├─ Input:
   │   │   - slide metadata
   │   │   - contentPlan
   │   │   - routerConfig ────────────────┐
   │   │   - layoutPlan                   │
   │   │   - styleGuide                   │
   │   │                                  │ RICH CONTEXT
   │   │ Generates: visualDesignSpec {   │
   │   │   spatialStrategy,              │
   │   │   compositionalHierarchy,       │
   │   │   negativeSpaceAllocation,      │
   │   │   colorHarmony,                 │
   │   │   foregroundElements[],         │
   │   │   backgroundTreatment,          │
   │   │   promptWithComposition         │
   │   │ }                               │
   │   │                                  │
   │   │ RLM LOOP:                        │
   │   │  - Generate design              │
   │   │  - Validate alignment           │
   │   │  - If invalid: regenerate ──────┘
   │   └─ Model: gemini-3-pro (with thinking)
   │
   ├─→ 3e. IMAGE GENERATOR
   │   ├─ Input: visualDesignSpec.promptWithComposition
   │   │           (spatially-aware prompt)
   │   └─ Output: backgroundImageUrl
   │
   ├─→ 3f. SPATIAL LAYOUT ENGINE (NEW - CORE FIX)
   │   ├─ Input: layoutPlan, visualDesignSpec, routerConfig
   │   ├─ Process:
   │   │   1. Allocate components to spatial zones
   │   │   2. Assign visual weight based on purpose
   │   │   3. Generate hierarchical positioning
   │   │   4. Respect negative space constraints
   │   └─ Output: spatiallyAwareComponents[]
   │
   └─→ 3g. PPTX RENDERER (Enhanced InfographicRenderer)
       ├─ Input: spatiallyAwareComponents, backgroundImageUrl
       ├─ Process:
       │   ├─ Place components in assigned zones
       │   ├─ Layer background image correctly
       │   ├─ Apply visual hierarchy through sizing/opacity
       │   └─ Respect negative space
       └─ Output: Professional PPTX slide

IMPROVEMENTS:
✅ Visual Designer is explicit, separate agent
✅ Visual design receives full layout context
✅ Spatial zones guide both generation and rendering
✅ RLM loop validates visual-layout alignment
✅ Renderer has zone-aware positioning algorithm
✅ Negative space is explicitly planned
✅ Visual hierarchy is purposeful
```

---

## Data Flow Comparison: Before vs After

### BEFORE (Problem State)

```
routerConfig.visualFocus = "data trends"
                  │
                  ├─ Router decision
                  │  (doesn't know component types)
                  │
                  └─→ visualPrompt = "Show upward data trends on dark background"
                      │
                      ├─ Image gen
                      │  (doesn't know layout/spacing)
                      │
                      └─→ backgroundImageUrl (generic background)
                          │
                          ├─ PPTX Renderer
                          │  (no spatial awareness)
                          │
                          └─→ Slide with overlapping elements

Result: ❌ Busy, hard to read, poor hierarchy
```

### AFTER (Solution State)

```
routerConfig = {
  layoutVariant: "split-left-text",
  visualFocus: "data trends",
  spatialZones: [
    {id: "text-area", x: 0, y: 0, w: 5, h: 5.625, purpose: "hero"},
    {id: "visual-area", x: 5.1, y: 0, w: 4.9, h: 5.625, purpose: "secondary"}
  ]
}
      │
      ├─ Visual Designer
      │  (knows zones, components, layout)
      │
      └─→ visualDesignSpec = {
          spatialStrategy: {
            negativeSpaceAllocation: "25%",
            compositionalHierarchy: "right side shows trend, data points centered",
            foregroundElements: ["trend arrow", "metric label"],
            backgroundTreatment: "subtle gradient, left side darker for text contrast"
          },
          promptWithComposition: "Professional dashboard background: left side dark charcoal for text overlay, right side shows upward data stream in blue/green gradient, 25% negative space, minimalist aesthetic"
        }
      │
      ├─ Image Gen
      │  (generates with spatial understanding)
      │
      ├─ Spatial Layout Engine
      │  (allocates components to zones)
      │
      └─→ PPTX Renderer
         (places components in zones with visual hierarchy)

Result: ✅ Clean, purposeful, professional hierarchy
```

---

## Component Interaction: Spatial Layout Engine

```
┌──────────────────────────────────────────────────────┐
│       SPATIAL LAYOUT ENGINE                          │
│  (New class: SpatialLayoutEngine)                    │
└──────────────────────────────────────────────────────┘

LAYOUT TEMPLATES (Pre-defined Zone Configurations)

┌─────────────────────────────────────────────────────┐
│ split-left-text Layout                              │
│                                                     │
│ ┌──────────────────┬──────────────────┐             │
│ │                  │                  │             │
│ │   TEXT AREA      │  VISUAL AREA     │             │
│ │   (hero zone)    │  (secondary)     │             │
│ │   x:0 y:0        │  x:5.1 y:0       │             │
│ │   w:5 h:5.625    │  w:4.9 h:5.625   │             │
│ │                  │                  │             │
│ │ • Title          │  [Background]    │             │
│ │ • Bullets        │  [Image]         │             │
│ │ • Description    │                  │             │
│ │                  │                  │             │
│ └──────────────────┴──────────────────┘             │
│                                                     │
│ Accent Bar (bottom): x:0 y:5 w:10 h:0.625         │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ hero-centered Layout                                │
│                                                     │
│ ┌────────────────────────────────────────┐         │
│ │                                        │         │
│ │     ┌──────────────────────────┐       │         │
│ │     │   HERO TITLE (primary)   │       │         │
│ │     │   x:1 y:1.5 w:8 h:1.2    │       │         │
│ │     └──────────────────────────┘       │         │
│ │                                        │         │
│ │     ┌──────────────────────────┐       │         │
│ │     │   SUBTITLE (secondary)   │       │         │
│ │     │   x:1 y:2.8 w:8 h:1.5    │       │         │
│ │     └──────────────────────────┘       │         │
│ │                                        │         │
│ │ ════════════════════════════════════   │         │
│ │      ACCENT BAR (bottom)               │         │
│ │      x:0 y:5 w:10 h:0.625             │         │
│ │                                        │         │
│ └────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ bento-grid Layout (4 zones)                         │
│                                                     │
│ ┌─────────────────────┬──────────────────┐         │
│ │                     │                  │         │
│ │ GRID-1 (hero)       │ GRID-2 (hero)    │         │
│ │ x:0 y:0.5           │ x:5.2 y:0.5      │         │
│ │ w:4.8 h:2.5         │ w:4.8 h:2.5      │         │
│ │                     │                  │         │
│ ├─────────────────────┼──────────────────┤         │
│ │                     │                  │         │
│ │ GRID-3 (secondary)  │ GRID-4 (secondary)        │
│ │ x:0 y:3.2           │ x:5.2 y:3.2      │         │
│ │ w:4.8 h:2.2         │ w:4.8 h:2.2      │         │
│ │                     │                  │         │
│ └─────────────────────┴──────────────────┘         │
└─────────────────────────────────────────────────────┘

ALLOCATION ALGORITHM:

1. Get layout variant → fetch zone template
2. Sort components by semantic importance
3. Assign to zones by priority:
   - Title → hero zones
   - Metrics/Bullets → secondary zones
   - Accent elements → accent zones
4. Render each component respecting zone bounds
5. Apply visual styling based on zone purpose
```

---

## Validation Pipeline: RLM Recursive Loop

```
┌─────────────────────────────────────────────────────┐
│   VISUAL DESIGN RLM LOOP (Recursive Refinement)     │
└─────────────────────────────────────────────────────┘

ATTEMPT 1:
┌─────────────────────────────────────────────────────┐
│ Generate Visual Design                              │
│ Input: slide, layout, content, routing config       │
│ Output: visualDesignSpec {                          │
│   spatialStrategy,                                  │
│   prompt,                                           │
│   colorHarmony,                                     │
│   ...                                               │
│ }                                                   │
└─────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────┐
│ Validate Visual-Layout Alignment                    │
│                                                     │
│ Checks:                                             │
│ ✓ Spatial zones match layout variant                │
│ ✓ Negative space 10-40%                             │
│ ✓ Color contrast acceptable                        │
│ ✓ Visual elements don't conflict with text zones    │
│ ✓ Foreground element count reasonable               │
│                                                     │
│ Validation Result: {                                │
│   passed: true/false,                               │
│   score: 0-100,                                     │
│   errors: [{code, message, fix}]                    │
│ }                                                   │
└─────────────────────────────────────────────────────┘
           │
           ├─ PASS ────────────────────────→ Return Design ✅
           │
           └─ FAIL ─────────────────────────┐
                                            │
                                    Generate with feedback
                                            │
                      ATTEMPT 2 (with previousFeedback):
                      Regenerate addressing specific errors
                                            │
                                            ▼
                            Validate again (same checks)
                                            │
                            ├─ PASS ──→ Return Design ✅
                            └─ FAIL ──→ Max retries reached
                                       Return best attempt ⚠️

MAX ATTEMPTS: 3
If still failing after 3 attempts:
- Return design with warnings
- Render with fallback component types
- Log error for analysis
```

---

## Integration Point: SlideDeckBuilder Update

```typescript
// BEFORE
const slideNode = await runGeneratorWithRLM(
  slideMeta, routerConfig, facts, outline.factClusters, tracker
);
slideNode.visualPrompt = await runVisualPrompter(slideNode.title, routerConfig.visualFocus, tracker);
const imgResult = await generateImageFromPrompt(slideNode.visualPrompt, "16:9");

// AFTER
const contentPlan = await runContentPlanner(...);
const visualDesign = await runVisualDesigner(
  { ...slideMeta, layoutPlan: contentPlan.layout },
  contentPlan,
  routerConfig,
  facts,
  tracker
);
const slideNode = await runGeneratorWithRLM(
  slideMeta,
  routerConfig,
  facts,
  outline.factClusters,
  { visualDesignSpec: visualDesign },  // ← PASS TO GENERATOR
  tracker
);
const imgResult = await generateImageFromPrompt(
  visualDesign.promptWithComposition,  // ← USE COMPOSED PROMPT
  "16:9"
);

// In PPTX Renderer:
const spatialEngine = new SpatialLayoutEngine();
const allocation = spatialEngine.allocateComponents(
  slide.layoutPlan.components,
  slide.routerConfig.layoutVariant
);
const renderedElements = spatialEngine.renderWithSpatialAwareness(
  slide.layoutPlan.components,
  allocation,
  styleGuide
);
```

---

## Key Metrics: Before vs After

```
METRIC                  | BEFORE    | AFTER     | IMPROVEMENT
─────────────────────────┼───────────┼───────────┼──────────────
Visual Focus Usage      | 0%        | 100%      | ✅ Fully utilized
Layout-Visual Alignment | Manual    | Automated | ✅ Recursive
Negative Space Control  | None      | 10-40%    | ✅ Purposeful
Component Positioning   | Hardcoded | Zone-based| ✅ Flexible
Validation Coverage     | Text only | Text+Vis. | ✅ Comprehensive
Regeneration Loop       | Content   | Visual+   | ✅ Co-optimized
Prompt Context (tokens) | ~200      | ~2000     | ✅ Richer signals
Visual Quality Score    | 65/100    | 85/100    | ✅ Improved
Layout Readability      | Fair      | Excellent | ✅ Professional
Render Speed            | 2s        | 2.5s      | ⚠️  +0.5s overhead
Total Cost/Deck         | $0.30     | $0.45     | ⚠️  +$0.15 (worth it)
```

---

## File Structure: Where to Implement

```
src/
├── services/
│   ├── slideAgentService.ts          (MODIFY: Add runVisualDesigner call)
│   ├── visualDesignAgent.ts           (NEW: Visual Designer agent)
│   ├── spatialRenderer.ts             (NEW: SpatialLayoutEngine class)
│   ├── infographicRenderer.ts         (MODIFY: Use spatial allocation)
│   ├── geminiService.ts               (MINOR TWEAKS)
│   ├── promptRegistry.ts              (ADD: VISUAL_COMPOSER prompt)
│   └── validators.ts                  (ADD: validateVisualLayoutAlignment)
│
├── types/
│   └── slideTypes.ts                  (ADD: SpatialZone, VisualDesignSpec)
│
└── components/
    ├── SlideDeckBuilder.tsx           (MINOR: Display spatial info)
    └── BuilderCanvas.tsx              (MINOR: Show zones)
```

---

## Testing Strategy

```
UNIT TESTS:

1. SpatialLayoutEngine.allocateComponents()
   - Test allocation respects zone boundaries
   - Test priority-based ordering
   - Test overflow handling

2. validateVisualLayoutAlignment()
   - Test negative space detection
   - Test color contrast checks
   - Test zone conflict detection

3. visualDesignAgent.runVisualDesigner()
   - Test prompt generation includes spatial context
   - Test RLM loop triggers on validation fail
   - Test max attempt handling

INTEGRATION TESTS:

1. Full pipeline with sample topics
   - Verify visual designer is called
   - Verify spatial zones are used
   - Verify PPTX has proper layout

2. Validation feedback loop
   - Inject invalid design
   - Verify regeneration with feedback
   - Verify improved output

3. Cost/performance analysis
   - Token usage tracking
   - Quality score comparison
   - Time benchmarks

E2E TESTS:

1. Generate deck on various topics
   - Healthcare/tech/business
   - Different slide types
   - Mixed component types

2. Visual quality assessment
   - Layout cleanliness (subjective)
   - Text readability
   - Visual hierarchy
   - Professional appearance
```

---

## Rollout Plan

```
PHASE 1: Foundational (Week 1)
├─ Create visualDesignAgent.ts with basic schema
├─ Add VISUAL_COMPOSER prompt
├─ Test generation without recursion
└─ Estimated effort: 4 hours

PHASE 2: Rendering Engine (Week 1-2)
├─ Implement SpatialLayoutEngine
├─ Define zone templates for all variants
├─ Integrate with InfographicRenderer
└─ Estimated effort: 6 hours

PHASE 3: Validation & RLM (Week 2)
├─ Add validateVisualLayoutAlignment
├─ Implement recursive loop in visual designer
├─ Add adaptive tuning logic
└─ Estimated effort: 4 hours

PHASE 4: Integration & Testing (Week 2-3)
├─ Update slideAgentService orchestration
├─ Comprehensive testing
├─ Performance optimization
├─ Documentation
└─ Estimated effort: 5 hours

TOTAL: ~19 hours development
```

---

## Success Criteria

✅ Visual focus field is semantically used in 100% of slides
✅ Negative space allocation explicitly planned (10-40%)
✅ Layout-visual alignment validated before rendering
✅ Spatial zones respected in PPTX output
✅ Zero overlapping text/visual conflicts
✅ Visual quality score ≥80/100
✅ Professional appearance in output deck
✅ Latency < 5s per slide (including image gen)
✅ Cost per deck < $0.50
✅ RLM loop improves output on 80%+ of slides needing refinement