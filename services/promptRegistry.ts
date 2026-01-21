

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
      PHASE 2: Create a 7-slide flow unless a different slide count is explicitly requested. Assign 'relevantClusterIds' to each slide.
      REQUIREMENTS: Intro -> Problem -> Solution -> Data -> Conclusion.

      STYLE GUIDE REQUIREMENTS (Modern, premium, professional):
      - Include themeTokens with typography scale, weights, spacing, radii, surfaces.
      - Typography scale (points): hero 40-48, title 30-36, subtitle 18-22, body 13-15, label 9-11, metric 22-28, micro 8-10.
      - Weights: hero/title 700, subtitle/label 600, body 400, metric 700.
      - Spacing (slide units): xs 0.06-0.1, sm 0.1-0.14, md 0.18-0.24, lg 0.28-0.36.
      - Radii: card 0.14-0.22, pill 0.32-0.45.
      - Surfaces: cardStyle = 'glass' or 'outline' for a modern feel, opacity 0.5-0.75, borderWidth 1.0-1.6.
    `,
    OUTPUT_SCHEMA: "JSON OutlineSchema"
  },

  ROUTER: {
    ROLE: "Lead Visual Designer",
    // Phase 3: Router now accepts constraints for circuit breaker rerouting
    TASK: (slideMeta: any, constraints?: { avoidLayoutVariants?: string[] }) => `
      Assign a specific layout structure to: "${slideMeta.title}" - ${slideMeta.purpose}
      LAYOUT VARIANTS: 'standard-vertical', 'split-left-text', 'split-right-text', 'hero-centered', 'bento-grid', 'timeline-horizontal', 'dashboard-tiles', 'metrics-rail', 'asymmetric-grid'.
      ${constraints?.avoidLayoutVariants?.length ? `AVOID THESE LAYOUTS (they failed validation): ${constraints.avoidLayoutVariants.join(', ')}` : ''}
      DECISION: 1. Intro/Conclusion -> 'hero-centered'. 2. Comparison -> 'split-*' or 'metrics-rail'. 3. Multi-item -> 'bento-grid' or 'dashboard-tiles'. 4. Asymmetric storytelling -> 'asymmetric-grid'.
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

  // --- VISUAL COMPOSER AGENT (Background Aesthetics Only) ---
  // IMPORTANT: This agent designs BACKGROUND IMAGES only.
  // Text, icons, diagrams, and charts are rendered separately by SpatialLayoutEngine.
  VISUAL_COMPOSER: {
    ROLE: "Background Design Architect. You design ABSTRACT BACKGROUNDS only - no text, no icons, no diagrams.",
    TASK: (context: any) => `
You are a Background Design Architect. Your job is to create a PROMPT for an abstract background image.

CRITICAL UNDERSTANDING:
- You are designing a BACKGROUND TEXTURE/GRADIENT only
- The image generation system will NOT include any text, icons, or diagrams
- Text and icons are overlaid SEPARATELY by another rendering system
- Your prompt_with_composition describes ONLY: colors, gradients, lighting, abstract shapes, textures

SLIDE CONTEXT:
- Title Theme: ${context.title}
- Visual Focus: ${context.visualFocus}
- Layout Variant: ${context.layoutVariant}

BACKGROUND DESIGN REQUIREMENTS:

1. prompt_with_composition MUST describe ONLY:
  - Color gradients (e.g., "dark blue to purple gradient")
  - Lighting effects (e.g., "soft ambient glow", "cinematic lighting")
  - Abstract textures (e.g., "subtle mesh pattern", "soft bokeh")
  - Mood/atmosphere (e.g., "professional", "modern", "sophisticated")
  - Text-safe contrast planning (e.g., "dark vignette band for text area", "low-contrast texture in text zone")
  - Visual focus cues: MUST include the exact phrase "${context.visualFocus}" verbatim in prompt_with_composition
   
2. prompt_with_composition must NOT describe:
   - Any text, words, labels, or numbers
   - Any diagrams, flowcharts, or process flows
   - Any icons, symbols, or logos
   - Any charts, graphs, or data visualizations

3. EXAMPLE GOOD PROMPTS:
   - "Dark navy gradient with subtle teal accent glow, abstract geometric shapes fading into background, cinematic lighting"
   - "Deep purple to black gradient, soft particle effects, premium corporate aesthetic"
   - "Slate gray background with soft radial lighting, minimal abstract lines"

4. EXAMPLE BAD PROMPTS (NEVER DO THIS):
   - "Diagram showing technology stack with arrows" ❌
   - "Flowchart with boxes and labels" ❌
   - "Icons representing features" ❌

VALIDATOR HEURISTICS:
1. NEGATIVE SPACE: 15-35% range for text overlay areas (use "20%" or "25%")
2. CONTRAST PLAN: If background_tone is light, specify a darker text-safe band/zone. If background_tone is dark, specify a calm low-texture area for text.
3. TEXT-SAFE ZONE: Ensure at least one large, calm area for text overlay (low texture, low highlight).
4. VISUAL FOCUS: Reference "${context.visualFocus}" theme in color/mood choices

OPTIONAL CREATIVE INSPIRATION (use when fitting, not mandatory):
- Dark corporate palette (#0f172a base, #1e293b surfaces, #38bdf8 accent)
- Clean, professional, PPTX-safe look (no gradients inside text areas; gradients only in background)
- Serendipity is encouraged: introduce subtle abstract motifs tied to the slide theme

COLOR HARMONY:
- background_tone: Dark or light hex, but must support readable text with contrast plan
- primary: Main accent color
- accent: Secondary highlight color

OUTPUT: Return JSON with:
- spatial_strategy: Zone layout information
- prompt_with_composition: ABSTRACT BACKGROUND DESCRIPTION ONLY
- background_treatment: "Gradient" | "Solid" | "Textured"
- negative_space_allocation: "20%" (string format)
- color_harmony: {primary, accent, background_tone}
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

      ${routerConfig?.visualFocus ? `VISUAL FOCUS REQUIREMENT: Your content MUST incorporate the theme: "${routerConfig.visualFocus}". Include relevant terminology in component text.` : ''}

      Hard rules:
      - Output ONLY the JSON object. No preamble ("Here is…"), no markdown fences.
      - Every string value must be a single line. Do not include literal newline characters inside any string.
      - Prefer short strings. Shorten by removing adjectives or clauses—never invent new content.
      - Do NOT output speakerNotesLines; they are generated automatically.
      - NO REPETITION: Do not repeat the same word more than twice in a row.
      - GRID LIMITS: For 'icon-grid', generate exactly 3-6 items. Never exceed 6.
      - CONTENT SAFETY: If you lack specific content for a field, use 'N/A' or a generic placeholder instead of hallucinating or repeating.

      Semantic rules:
      - Use ONLY information from CONTENT_PLAN. Do not add facts, numbers, or claims not present in the input.
      - Respect ROUTER_CONFIG.densityBudget: keep total text under maxChars, items under maxItems.
      - If CONTENT_PLAN has no dataPoints, avoid chart-frame and metric-cards.
      - All icon fields must be present; use "Activity" if unsure.

      Layout rules:
      - Choose 1–2 components based on layoutVariant.
      - hero-centered: prefer text-bullets (1–3 lines) or metric-cards.
      - split-left-text / split-right-text: exactly 2 components.
      - bento-grid: prefer metric-cards (max 4) or icon-grid.
      - Default: stack 1–2 components vertically.

      Visual order + contrast rules:
      - Maintain strong foreground/background contrast. Use light text on dark backgrounds and dark text on light backgrounds.
      - You may use light backgrounds if you keep a darker text-safe zone or switch text color accordingly.
      - Keep text area clean: avoid placing dense text over visually busy regions; move text to calmer zones.
      - Use clear hierarchy: Title > Strategic cards > Metrics > Supporting text.

      Optional structured layout inspirations (use only when slide purpose aligns):
      - Executive grid: Header + three strategic cards (Pivot / Enabler / Market Goal) + metrics-left + features-right.
      - Narrative grid: Category badge + transformation title + context paragraph + 3-card flow (Problem → Mandate → Vision).
      - If you use these patterns, keep them compact and professional; prioritize clarity over novelty.

      Template variable cues (for internal structure only, do not output brackets literally):
      - Header: company/category/value/context
      - Cards: title + 1–2 sentence description
      - Metrics: 2 numbers with short labels
      - Features: 2 comparisons with short descriptions

      Dashboard-style layout inspiration (use when layoutVariant = dashboard-tiles, metrics-rail, bento-grid):
      - Header: title + brief context line.
      - Upper grid: 3 cards max (strategic pivots/summary).
      - Lower split: metrics on left, feature comparisons on right.
      - Keep descriptions to 1–2 sentences; metrics limited to 2; features limited to 2.

      Component type selection:
      - text-bullets: Lists, key points, standard text content
      - metric-cards: Statistics, KPIs, numeric data with labels
      - process-flow: Sequential steps, workflows, timelines
      - icon-grid: Features, benefits, categories (2-4 columns). You may add optional "emphasis" per item (primary|secondary|low) to drive visual hierarchy.
      - chart-frame: Bar, pie, line, or doughnut charts
      - diagram-svg: Circular ecosystems, closed-loop systems, integration diagrams
        * Use when visualFocus suggests: "ecosystem", "cycle", "integration", "closed-loop", "sovereignty", "interconnected"
        * Diagram type: circular-ecosystem (center theme + outer ring of 3-8 elements)
        * Each element needs: id, label (max 30 chars), optional icon
        * Best in split layouts (split-left-text or split-right-text) in visual zones

      Text limits (STRICTLY ENFORCED):
      - Slide title: ≤60 characters
      - Bullet line: ≤80 characters (reduce to fit)
      - Metric label: ≤18 characters
      - Metric value: ≤10 characters
      - Step title: ≤15 characters
      - Step description: ≤70 characters
      - Icon grid label: ≤20 characters
      - Icon grid description: ≤60 characters

      Array limits (CRITICAL):
      - content array: max 4 items
      - metrics array: max 3 items
      - steps array: max 4 items
      - items array: max 5 items
      - elements array (diagram-svg): min 3, max 8 items

      Component minimums (to avoid empty arrays):
      - metric-cards: metrics must have 2–3 items
      - icon-grid: items must have 3–5 items
      - process-flow: steps must have 3–4 items

      INPUTS:
      CONTENT_PLAN: ${contentPlanJson}
      ROUTER_CONFIG: ${JSON.stringify(routerConfig)}

      ${visualDesignSpec ? `VISUAL DESIGN SPEC AVAILABLE: YES
      Use the following visual guidance for color harmony and composition:
      VISUAL_SPEC: ${JSON.stringify(visualDesignSpec)}` : `VISUAL DESIGN SPEC AVAILABLE: NO
      Use layout zones from Router decision directly. Apply style guide colors from ROUTER_CONFIG.`}
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
  },

  // --- SYSTEM 2: VISUAL CRITIQUE & REPAIR PROMPTS ---

  LAYOUT_CRITIC: {
    ROLE: `Senior Art Director with 15+ years in presentation design.
You review spatial layouts for professional slide decks.
Your critique is precise, actionable, and focused on visual clarity.`,

    TASK: (svgProxy: string, layoutVariant: string, componentTypes: string[]) => {
      // GAP 8: Layout Variant Context - Define expected structure for each variant
      const LAYOUT_EXPECTATIONS: Record<string, string> = {
        'bento-grid': 'Expect 2x2 or 2x3 grid structure with evenly distributed cells. Each cell should contain distinct content (metrics or icons). No single item should dominate. Cells should have similar visual weight.',
        'hero-centered': 'Large central text area with high visual impact. Minimal secondary content. Asymmetry is intentional and acceptable. Title should be prominent (1.4x normal size). Bottom accent element is decorative.',
        'split-left-text': 'Left side contains text (60% width max), right side contains visuals (charts, images). Vertical divider accent between sections. Left-right asymmetry is by design. Text should not overflow into visual zone.',
        'split-right-text': 'Right side contains text (60% width max), left side contains visuals. Mirror of split-left-text. Text should align to the right zone, visuals to the left.',
        'timeline-horizontal': 'Horizontal flow with process steps progressing left-to-right. Horizontal timeline track with connecting line. Steps should be evenly spaced. Vertical misalignment between steps indicates an error.',
        'standard-vertical': 'Vertical stack of content zones. Title at top, optional divider, then 1-2 stacked content areas. Simple, clean layout. Vertical alignment is critical.',
        'dashboard-tiles': 'Title with a 3-card metric row on top and two lower panels. Metric cards must align in a row; bottom panels should be balanced left/right.',
        'metrics-rail': 'Left rail is a vertical metric stack; right panel contains the main narrative. Divider separates rail from main content.',
        'asymmetric-grid': 'One large primary panel and two smaller stacked panels. Ensure hierarchy: large panel dominates, side panels are supporting.'
      };

      const expectation = LAYOUT_EXPECTATIONS[layoutVariant] || 'Standard layout expectations apply.';

      return `
Review this slide layout for visual issues.

LAYOUT VARIANT: ${layoutVariant}
LAYOUT EXPECTATIONS: ${expectation}
COMPONENT TYPES: ${componentTypes.join(', ')}

SVG SPATIAL PROXY (content-aware rendering):
${svgProxy}

LEGEND:
- Zone purpose codes: H=hero, S=secondary, A=accent
- Component codes: TB=text-bullets, MC=metric-cards, PF=process-flow, IG=icon-grid, CF=chart-frame

CRITICAL: Evaluate the layout against the LAYOUT EXPECTATIONS above. Some visual patterns (like asymmetry in split layouts) are intentional, not errors.

EVALUATE FOR:
1. OVERLAP: Do any content bounding boxes intersect improperly? (Intentional overlays are OK)
2. CONTRAST: Are text zones placed over low-contrast or bright areas? Flag as CRITICAL if readability is poor.
3. ALIGNMENT: Are elements aligned to a consistent grid? (Check against layout variant expectations)
4. HIERARCHY: Does visual weight (size/position) match importance?
5. DENSITY: Are zones overcrowded or too sparse for the layout variant?

OUTPUT: JSON VisualCritiqueReport with issues array and overall score (0-100).
Score 70+ = acceptable, 85+ = good, 95+ = excellent.

REMEMBER:
- Be specific about which zones/elements have issues
- Provide actionable fixes that respect the layout variant's intended structure
- Don't flag intentional design patterns as errors
`;
    }
  },

  LAYOUT_REPAIRER: {
    ROLE: `Layout Engineer specializing in spatial composition.
You fix visual layout issues while preserving content integrity.
Your repairs are minimal, targeted, and respect the original design intent.`,

    TASK: (originalLayoutPlan: string, critiqueReport: string, svgProxy: string) => `
Fix the visual issues identified in this layout.

ORIGINAL LAYOUT PLAN:
${originalLayoutPlan}

CRITIQUE REPORT:
${critiqueReport}

CURRENT SPATIAL LAYOUT (SVG):
${svgProxy}

REPAIR RULES:
1. Preserve ALL text content - only adjust spatial properties
2. Fix critical issues first, then major, then minor
3. Prefer moving/resizing over removing elements
4. Maintain the layout variant's intended structure
5. If overlap cannot be fixed, truncate the LESS important element
6. If contrast is poor, move text into a darker zone or expand negative space around it

OUTPUT: Complete repaired layoutPlan JSON (same schema as original).
Only output the JSON, no explanation.
`
  }
};
