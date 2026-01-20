

// --- PROMPT REGISTRY ---
// "Program-like" prompts that define specific Contracts for the Agents.

const DISTILLED_AESTHETICS_PROMPT = `
  <visual_constitution>
    GLOBAL RULE: You are fighting "AI Slop" (generic, safe, boring designs).
    1. **BACKGROUNDS**: NEVER use solid colors. DO use: "Subtle topological mesh", "Soft ray-traced lighting".
    2. **TYPOGRAPHY**: Avoid "Center everything". Use asymmetrical balance.
    3. **DATA**: AESTHETIC: "Financial Times" style. Pink/Blue accents on dark.
  </visual_constitution>
`;

export const PROMPTS = {
  RESEARCHER: {
    ROLE: "Lead Technical Researcher",
    TASK: (topic: string) => `
      Perform a deep search on "${topic}".
      Extract 10 verified, high-impact facts/statistics.
      Focus on numbers, trends, and technical specifications.
      
      CRITICAL OUTPUT RULE:
      You must output PURE VALID JSON.
      Return an ARRAY of objects.
      Format: [{"id": "1", "category": "Trend", "claim": "...", "value": "...", "source": "...", "confidence": "high"}, ...]
      Do not include any introductory text or markdown formatting. Just the JSON array.
    `,
    OUTPUT_SCHEMA: "JSON Array"
  },

  ARCHITECT: {
    ROLE: "Principal System Architect",
    TASK: (topic: string, factsContext: string) => `
      ROLE: Principal System Architect.
      GOAL: Structure a slide deck about "${topic}".
      INPUT CONTEXT: ${factsContext}
      PHASE 1: Group facts into "Fact Clusters".
      PHASE 2: Create a 5-8 slide flow. Assign 'relevantClusterIds' to each slide.
      REQUIREMENTS: Intro -> Problem -> Solution -> Data -> Conclusion.
    `,
    OUTPUT_SCHEMA: "JSON OutlineSchema"
  },

  ROUTER: {
    ROLE: "Lead Visual Designer",
    // Phase 3: Router now accepts constraints for circuit breaker rerouting
    TASK: (slideMeta: any, constraints?: { avoidLayoutVariants?: string[] }) => `
      Assign a specific layout structure to: "${slideMeta.title}" - ${slideMeta.purpose}
      LAYOUT VARIANTS: 'standard-vertical', 'split-left-text', 'split-right-text', 'hero-centered', 'bento-grid', 'timeline-horizontal'.
      ${constraints?.avoidLayoutVariants?.length ? `AVOID THESE LAYOUTS (they failed validation): ${constraints.avoidLayoutVariants.join(', ')}` : ''}
      DECISION: 1. Intro/Conclusion -> 'hero-centered'. 2. Comparison -> 'split-*'. 3. Multi-item -> 'bento-grid'.
    `,
    OUTPUT_SCHEMA: "JSON RouterDecision"
  },

  // --- PHASE 1 CONTENT PLANNER (with Context Folding) ---
  CONTENT_PLANNER: {
    ROLE: "Senior Editor",
    // Phase 1: Content Planner now receives recentHistory for narrative arc awareness
    TASK: (title: string, purpose: string, facts: string, recentHistory?: Array<{ title: string, mainPoint: string }>) => `
        TASK: Draft the core semantic content for slide "${title}".
        PURPOSE: ${purpose}
        ${recentHistory?.length ? `NARRATIVE SO FAR: ${recentHistory.map(h => h.title + ': ' + h.mainPoint).join('; ')}` : ''}
        FACTS: ${facts}
        
        CONSTRAINTS:
        - Extract ONLY the key facts needed.
        - Create a list of 'keyPoints' (strings). Max 4 items.
        - If numbers exist, extract 'dataPoints' ({label, value}).
        - NO VISUALS. NO LAYOUT. TEXT ONLY.
        - Build on the narrative so far - avoid repeating what was already covered.
      `
  },

  // --- VISUAL COMPOSER AGENT (with Validator-Driven Vibe Coding) ---
  VISUAL_COMPOSER: {
    // Phase 2: Expert UI Architect with validateVisualLayoutAlignment awareness
    ROLE: "Expert UI Architect. Think: 'Does this pass validateVisualLayoutAlignment?'",
    TASK: (context: any) => `
You are an Expert UI Architect. Before generating, mentally verify: "Does this pass validateVisualLayoutAlignment?"

SLIDE CONTEXT:
- Title: ${context.title}
- Visual Focus: ${context.visualFocus}
- Layout Variant: ${context.layoutVariant}
- Components: ${context.componentTypes.join(', ')}

VALIDATOR HEURISTICS (you MUST pass these checks):
1. VISUAL FOCUS KEYWORDS: Mention "${context.visualFocus}" keywords 2+ times in prompt_with_composition
2. NEGATIVE SPACE: Allocate 15-35% range (validator rejects <10% or >50%)
3. ZONE PLACEMENT: ${context.layoutVariant} requires ${context.componentTypes.join(', ')} to be placed in correct zones
4. DARK BACKGROUND: For text overlay, use YIQ<180 (dark colors like #0f172a, #1e293b, not mid-tones)

SPATIAL STRATEGY PROVIDED:
${JSON.stringify(context.spatialStrategy, null, 2)}

DESIGN PROCESS:

1. FIRST: Mentally draft the spatial zones for ${context.layoutVariant}
2. THEN: Compile to VisualDesignSpec JSON

DESIGN REQUIREMENTS:

1. COMPOSITION:
   - Create a visual that fills the designated zones efficiently
   - Use compositional hierarchy (focal point, supporting elements, negative space)
   - Ensure visual elements don't overlap with text zones

2. NEGATIVE SPACE (CRITICAL - validator checks this):
   - ${context.spatialStrategy.negative_space_plan || 'Maintain breathing room'}
   - MUST be between 15% and 35% - use "20%" or "25%" as safe values
   - Output format: "20%" (not "twenty percent")

3. COLOR HARMONY (CRITICAL - validator checks YIQ contrast):
   - background_tone MUST be dark (hex values like #0f172a, #1a1a2e, #0d1117)
   - NEVER use mid-tones (avoid #808080, #a0a0a0, etc.)
   - Accent colors should be vibrant for contrast

4. CONTENT ALIGNMENT (CRITICAL - validator checks this):
   - prompt_with_composition MUST include "${context.visualFocus}" keywords explicitly
   - foreground_elements SHOULD reference the visual focus topic

5. SPATIAL ZONES:
   ${context.spatialStrategy.zones ? context.spatialStrategy.zones.map((z: any) => `- ${z.purpose} zone (${z.id}): ${z.content_suggestion || 'supporting element'}`).join('\n') : 'No specific zones'}

OUTPUT: Return JSON conforming to VisualDesignSpecSchema. Ensure alignment.score >= 80.
`
  },

  // --- PHASE 2 VISUAL DESIGNER (with Context Folding + Validator Awareness) ---
  VISUAL_DESIGNER: {
    ROLE: "Information Designer",
    // Phase 1+2: Generator receives narrative history and validator awareness
    TASK: (contentPlanJson: string, routerConfig: any, visualDesignSpec?: any, recentHistory?: Array<{ title: string, mainPoint: string }>) => `
      You produce structured slide data that must validate against the provided response schema.

      ${recentHistory?.length ? `NARRATIVE SO FAR: ${recentHistory.map(h => h.title + ': ' + h.mainPoint).join('; ')}
      Continue the story - don't repeat previous slide content.` : ''}

      Hard rules:
      - Output ONLY the JSON object. No preamble ("Here is…"), no markdown fences.
      - Every string value must be a single line. Do not include literal newline characters inside any string.
      - Prefer short strings. Shorten by removing adjectives or clauses—never invent new content.
      - NO REPETITION: Do not repeat the same word more than twice in a row.
      - GRID LIMITS: For 'icon-grid', generate exactly 3-6 items. Never exceed 6.
      - CONTENT SAFETY: If you lack specific content for a field, use 'N/A' or a generic placeholder instead of hallucinating or repeating.

      Semantic rules:
      - Use ONLY information from CONTENT_PLAN. Do not add facts, numbers, or claims not present in the input.
      - Respect ROUTER_CONFIG.densityBudget: keep total text under maxChars, items under maxItems.
      - All icon fields must be present; use "Activity" if unsure.

      Layout rules:
      - Choose 1–2 components based on layoutVariant.
      - hero-centered: prefer text-bullets (1–3 lines) or metric-cards.
      - split-left-text / split-right-text: exactly 2 components.
      - bento-grid: prefer metric-cards (max 4) or icon-grid.
      - Default: stack 1–2 components vertically.

      Text limits:
      - Slide title: ≤60 characters
      - Bullet line: ≤90 characters
      - Metric label: ≤20 characters
      - Step title: ≤18 characters
      - Step description: ≤80 characters

      INPUTS:
      CONTENT_PLAN: ${contentPlanJson}
      ROUTER_CONFIG: ${JSON.stringify(routerConfig)}
      VISUAL_SPEC: ${visualDesignSpec ? JSON.stringify(visualDesignSpec) : 'N/A'}
    `,
  },

  REPAIRER: {
    ROLE: "QA Engineer",
    TASK: (originalJson: string, errors: any[]) => `
      The previous generation failed validation.
      
      ERRORS: ${JSON.stringify(errors)}
      
      TASK: Repair the JSON structure and content.
      1. Fix invalid structure.
      2. Resolve specific component errors (missing icons, unsupported types).
      
      Output RAW JSON ONLY matching the schema.
    `
  },

  // --- NEW: DEDICATED JSON REPAIRER ---
  JSON_REPAIRER: {
    ROLE: "JSON Repair Engine",
    TASK: (brokenJson: string) => `
      You are a specialized JSON repair engine.
      The following text contains a malformed or "dirty" JSON object.
      
      YOUR JOB:
      1. Extract the intended JSON object.
      2. Fix syntax errors (unescaped quotes, trailing commas, newlines in strings).
      3. Ensure it strictly matches the expected schema structure.
      4. Return ONLY the valid, minified JSON string. No markdown.

      BAD INPUT:
      ${brokenJson}
      `
  }
};
