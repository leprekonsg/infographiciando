

// --- PROMPT REGISTRY ---
// "Program-like" prompts that define specific Contracts for the Agents.

// THE CONSTITUTION: Distilled Aesthetics
const DISTILLED_AESTHETICS_PROMPT = `
  <visual_constitution>
    GLOBAL RULE: You are fighting "AI Slop" (generic, safe, boring designs).
    
    1. **BACKGROUNDS (The Atmosphere)**:
       - NEVER use solid colors or simple gradients.
       - DO use: "Subtle topological mesh", "Soft ray-traced lighting on matte paper", "Abstract macro architectural glass", "Dark-mode heavy grain".
       - CONSTRAINT: Images must be *backgrounds*. No focal subjects that fight with text.

    2. **TYPOGRAPHY & LAYOUT**:
       - Avoid "Center everything". Use asymmetrical balance (Golden Ratio).
       - If 'data-viz': The visual is the DATA. The background must be muted/deep (Charcoal/Midnight Blue).
       
    3. **DATA VISUALIZATION**:
       - Do not describe a chart in bullets.
       - Create a structured 'chartSpec' payload.
       - AESTHETIC: "Financial Times" style. Pink/Blue accents on dark.

    4. **MOTION & DEPTH**:
       - In 'visualPrompt', request "Depth of Field" and "Soft Bokeh" to create separation between text and image.
  </visual_constitution>
`;

export const PROMPTS = {
  RESEARCHER: {
    ROLE: "Lead Technical Researcher",
    TASK: (topic: string) => `Research "${topic}" and extract 10 verified, high-impact facts/statistics. Focus on numbers, trends, and technical specifications.`,
    OUTPUT_SCHEMA: "JSON Array of {id, category, claim, value, source, confidence}"
  },

  ARCHITECT: {
    ROLE: "Principal System Architect",
    TASK: (topic: string, factsContext: string) => `
      ROLE: Principal System Architect.
      GOAL: Structure a slide deck about "${topic}" using the "LLM-as-a-Program" mental model.

      INPUT CONTEXT (The Knowledge Base):
      ${factsContext}

      PHASE 1: ENVIRONMENTAL SCAN (The Librarian)
      - Analyze the Input Context.
      - Group facts into "Fact Clusters" (e.g., "Cluster A: Historical Context", "Cluster B: Technical Specs").
      - Assign a unique ID to each cluster.

      PHASE 2: BLUEPRINT (The Planner)
      - Create a 5-8 slide flow.
      - **CRITICAL**: Assign specific 'relevantClusterIds' to each slide. The Slide Generator will ONLY see facts from these clusters.
      - Narrative Arc: Ensure the deck moves from "Environment" -> "Modules" -> "Optimizer".

      REQUIREMENTS:
      1. Narrative: Intro -> Problem -> Solution -> Data -> Conclusion.
      2. StyleGuide: Define a coherent visual theme.
      3. Slides: Return an array of slide objects.
      4. Slide Types: use 'title-slide', 'section-header', 'content-main', 'data-viz', 'conclusion'.
    `,
    OUTPUT_SCHEMA: "JSON OutlineSchema"
  },

  ROUTER: {
    ROLE: "Lead Visual Designer & Layout Architect",
    TASK: (slideMeta: any) => `
      Assign a specific layout structure and content budget to this slide.
      
      SLIDE: "${slideMeta.title}" - ${slideMeta.purpose}
      
      LAYOUT VARIANTS (Choose one):
      - 'standard-vertical': Default stack. Good for simple lists.
      - 'split-left-text': Text on left (50%), Visual/Data on right (50%). Good for comparisons or explanations.
      - 'split-right-text': Visual/Data on left (50%), Text on right (50%). Good for feature highlights.
      - 'hero-centered': Minimal text, centered, high impact. Good for Title/Conclusion.
      - 'bento-grid': Structured grid of cards (2x2 or 3x2). Good for multiple equal features.
      - 'timeline-horizontal': Horizontal flow. Good for processes.
      
      DECISION PROTOCOL:
      1. Intro/Conclusion -> 'hero-centered'
      2. Comparison/Key Feature -> 'split-*'
      3. Multi-item list (3+) -> 'bento-grid'
      4. Step-by-step -> 'timeline-horizontal'
    `,
    OUTPUT_SCHEMA: `JSON { 
      renderMode: "statement" | "infographic" | "data-viz" | "standard",
      layoutVariant: "standard-vertical" | "split-left-text" | "split-right-text" | "hero-centered" | "bento-grid" | "timeline-horizontal",
      layoutIntent: string,
      densityBudget: { maxChars: number, maxItems: number, minVisuals: number },
      visualFocus: string 
    }`
  },

  GENERATOR: {
    ROLE: "Senior Information Designer & Visual Director",
    TASK: (meta: any, routerConfig: any, relevantFacts: string) => `
      TASK: Generate Slide #${meta.order}: "${meta.title}"
      TYPE: ${meta.type}
      
      LAYOUT: ${routerConfig.layoutVariant}
      MODE: ${routerConfig.renderMode}
      BUDGET: Max ${routerConfig.densityBudget.maxChars} chars.

      AVAILABLE FACTS (Source of Truth):
      ${relevantFacts}

      VISUAL CONSTITUTION (Strict Enforcement):
      ${DISTILLED_AESTHETICS_PROMPT}

      OUTPUT REQUIREMENTS:
      - **citations**: MUST map claims to the source text.
      - **visualPrompt**: MUST include "no text, 8k resolution, corporate abstract" + specific texture instructions.
      - **chartSpec**: REQUIRED if type is 'data-viz'.
      - **selfCritique**: Honest assessment of the layout density.
      
      **STRICT ANTI-LOOPING CONSTRAINTS**:
      1. **MAX 4 ITEMS** per list/array (e.g., max 4 steps, max 4 metrics).
      2. **MAX 15 WORDS** per description string.
      3. **NO REPETITION**: Do not repeat the same word sequence.
      4. **STOP** immediately if you have filled the required fields.
      
      COMPONENTS: Choose 1-2 components (metric-cards, process-flow, icon-grid, text-bullets, chart-frame).
    `,
    OUTPUT_SCHEMA: `Follow the strict SlideNodeSchema.`
  },

  REPAIRER: {
    ROLE: "QA Engineer & Fixer",
    TASK: (originalJson: string, errors: any[]) => `
      The previous generation failed the Delight QA check.
      
      ERRORS:
      ${JSON.stringify(errors, null, 2)}
      
      TASK:
      Repair the JSON content to resolve these errors.
      - **CRITICAL**: If ERR_REPETITION_DETECTED, you MUST rewrite the text content. Do not output duplicates. If you cannot invent new text, reduce the number of items.
      - If ERR_TEXT_OVERFLOW: Shorten text, remove filler words.
      - If ERR_MISSING_ICON: Add 'icon' fields to items.
      - If ERR_DENSITY: Reduce number of list items.
      - If ERR_EMPTY_SLIDE: Add a 'text-bullets' component with relevant content.
      - If ERR_MALFORMED_COMPONENT: Ensure arrays like 'steps' or 'metrics' exist.
      
      Return ONLY the fixed JSON.
    `
  }
};