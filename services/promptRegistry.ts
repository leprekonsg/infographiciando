

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
      
      SERENDIPITY DNA (for delightful surprises):
      Include a "serendipityDNA" object with these fields for tasteful variation across the deck:
      - motifs: 1-3 abstract visual motifs that thread through the deck (e.g., "circuit patterns", "flowing waves", "geometric fragments")
      - texture: Choose ONE consistent texture: mesh | circuit | soft-bands | bokeh | minimal-lines | gradient-ribbons | abstract-geo
      - gridRhythm: Layout density: tight | balanced | airy
      - accentRule: Color emphasis: single | dual | highlight
      - cardStyle: Modern card treatment: glass | outline | solid
      - surpriseBudget: Number 1-3 indicating how many "wow" moments to allow per deck
      - surpriseCues: Array of short phrases describing tasteful novelty opportunities (e.g., "floating metric badge", "gradient divider", "glowing accent")
      
      These DNA values create cohesion while enabling controlled variation - each slide can surprise within the theme.
    `,
    OUTPUT_SCHEMA: "JSON OutlineSchema"
  },

  ROUTER: {
    ROLE: "Lead Visual Designer",
    // Phase 3: Router now accepts constraints for circuit breaker rerouting
    // Phase 4: StyleMode integration for layout filtering
    TASK: (slideMeta: any, constraints?: { avoidLayoutVariants?: string[]; styleMode?: 'corporate' | 'professional' | 'serendipitous' }) => {
      // Style-specific layout guidance
      const STYLE_LAYOUT_HINTS: Record<string, string> = {
        corporate: `
          STYLE: CORPORATE (Maximum stability, zero creative risk)
          PREFERRED LAYOUTS: 'standard-vertical', 'hero-centered', 'split-left-text', 'split-right-text'
          AVOID LAYOUTS: 'asymmetric-grid', 'timeline-horizontal' (too dynamic)
          PRINCIPLES: Grid alignment over creative flourish. Predictability is a feature.`,
        professional: `
          STYLE: PROFESSIONAL (Balanced readability + visual interest)
          ALL LAYOUTS AVAILABLE - choose based on content fit
          PRINCIPLES: Prioritize clarity but moderate asymmetry is welcome.`,
        serendipitous: `
          STYLE: CREATIVE/SERENDIPITOUS (Bold, memorable, avoid template-y)
          PREFERRED LAYOUTS: 'hero-centered', 'asymmetric-grid', 'bento-grid', 'split-left-text'
          AVOID LAYOUTS: 'standard-vertical' (too safe), 'metrics-rail' (too corporate)
          PRINCIPLES: Visual drama over safety. Be bold, not generic.`
      };
      
      const styleHint = constraints?.styleMode ? STYLE_LAYOUT_HINTS[constraints.styleMode] : '';
      
      return `
      Assign a specific layout structure to: "${slideMeta.title}" - ${slideMeta.purpose}
      LAYOUT VARIANTS: 'standard-vertical', 'split-left-text', 'split-right-text', 'hero-centered', 'bento-grid', 'timeline-horizontal', 'dashboard-tiles', 'metrics-rail', 'asymmetric-grid'.
      ${constraints?.avoidLayoutVariants?.length ? `AVOID THESE LAYOUTS (they failed validation): ${constraints.avoidLayoutVariants.join(', ')}` : ''}
      ${styleHint}
      DECISION: 1. Intro/Conclusion -> 'hero-centered'. 2. Comparison -> 'split-*' or 'metrics-rail'. 3. Multi-item -> 'bento-grid' or 'dashboard-tiles'. 4. Asymmetric storytelling -> 'asymmetric-grid'.
    `;
    },
    OUTPUT_SCHEMA: "JSON RouterDecision"
  },

  // --- PHASE 1 CONTENT PLANNER (with Context Folding) ---
  CONTENT_PLANNER: {
    ROLE: "Senior Editor",
    // Phase 1: Content Planner now receives recentHistory for narrative arc awareness
    // Phase 2: Added density constraints to prevent overflow
    // Phase 4: StyleMode integration for content density guidance
    TASK: (title: string, purpose: string, facts: string, recentHistory?: Array<{ title: string, mainPoint: string }>, densityHint?: { maxBullets?: number; maxCharsPerBullet?: number; styleMode?: 'corporate' | 'professional' | 'serendipitous' }) => {
      // Style-specific content guidance
      const STYLE_CONTENT_HINTS: Record<string, string> = {
        corporate: `
          STYLE: CORPORATE
          - Be CONCISE and PRECISE - executives don't read paragraphs
          - Prefer data-backed claims over descriptive text
          - Each bullet point should be a single, standalone statement
          - If you have metrics, lead with them`,
        professional: `
          STYLE: PROFESSIONAL
          - Balance data with context
          - Clear, readable bullets with moderate detail
          - Include necessary explanation but stay focused`,
        serendipitous: `
          STYLE: CREATIVE
          - Less is more - negative space is your friend
          - One powerful statement > five medium ones
          - Think "headline + supporting insight" not "comprehensive coverage"
          - Bold claims welcome if backed by facts`
      };
      
      const styleHint = densityHint?.styleMode ? STYLE_CONTENT_HINTS[densityHint.styleMode] : '';
      
      return `
        TASK: Draft the core semantic content for slide "${title}".
        PURPOSE: ${purpose}
        ${recentHistory?.length ? `NARRATIVE SO FAR: ${recentHistory.map(h => h.title + ': ' + h.mainPoint).join('; ')}` : ''}
        FACTS: ${facts}
        ${styleHint}
        
        CONSTRAINTS:
        - Extract ONLY the key facts needed.
        - Create a list of 'keyPoints' (strings). MAXIMUM ${densityHint?.maxBullets || 3} items.
        - Each keyPoint must be UNDER ${densityHint?.maxCharsPerBullet || 80} characters. Be concise!
        - If numbers exist, extract 'dataPoints' ({label, value}). Max 3 items.
        - NO VISUALS. NO LAYOUT. TEXT ONLY.
        - Build on the narrative so far - avoid repeating what was already covered.
        - BREVITY IS KEY: Slides have limited space. Prioritize impact over completeness.
      `;
    }
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
${context.styleDNA ? `- Style DNA: ${JSON.stringify(context.styleDNA)}` : ''}
${typeof context.variationBudget === 'number' ? `- Variation Budget: ${context.variationBudget} (0=conservative, 1=bold)` : ''}

BACKGROUND DESIGN REQUIREMENTS:

1. prompt_with_composition MUST describe ONLY:
  - Color gradients (e.g., "dark blue to purple gradient")
  - Lighting effects (e.g., "soft ambient glow", "cinematic lighting")
  - Abstract textures (e.g., "subtle mesh pattern", "soft bokeh")
  - Layered structure: background layer → motif layer → accent glow → micro-detail layer
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
 - Use styleDNA motifs and texture to keep theme consistent across slides while varying intensity based on variationBudget

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
    TASK: (contentPlanJson: string, routerConfig: any, visualDesignSpec?: any, recentHistory?: Array<{ title: string, mainPoint: string }>, styleHints?: any) => `
      You produce structured slide data that must validate against the provided response schema.

      ${recentHistory?.length ? `NARRATIVE SO FAR: ${recentHistory.map(h => h.title + ': ' + h.mainPoint).join('; ')}
      Continue the story - don't repeat previous slide content.` : ''}

      ${routerConfig?.visualFocus ? `VISUAL FOCUS REQUIREMENT: Your content MUST incorporate the theme: "${routerConfig.visualFocus}". Include relevant terminology in component text.` : ''}

      Hard rules:
      - Output ONLY the JSON object. No preamble ("Here is…"), no markdown fences.
      - Every string value must be a single line. Do not include literal newline characters inside any string.
      - Prefer short strings. Shorten by removing adjectives or clauses—never invent new content.
      - NEVER echo the prompt, schema, or examples. Do not repeat instruction text inside any field.
      ═══════════════════════════════════════════════════════════════════════════
      BELIEF ANCHOR: TITLE UNIQUENESS (CRITICAL)
      ═══════════════════════════════════════════════════════════════════════════
      The slide title is ALREADY rendered in the title zone via layoutPlan.title.
      
      ⛔ NEVER OUTPUT:
      - A "title-section" component (redundant, will be stripped)
      - Component titles that repeat layoutPlan.title verbatim
      - Bullet text that starts with the slide title
      
      ✅ DO THIS INSTEAD:
      - Use a SHORT SUBTITLE for components (different from slide title)
      - Or OMIT component.title entirely if not needed
      
      SIMILARITY CHECK (run mentally before outputting):
      If component.title shares >60% words with layoutPlan.title → change it or omit it.
      - Do NOT output speakerNotesLines; they are generated automatically.
      - NO REPETITION: Do not repeat the same word more than twice in a row.
      - GRID LIMITS: For 'icon-grid', generate exactly 3-6 items. Never exceed 6.
      - CONTENT SAFETY: If you lack specific content for a field, omit the component or use qualitative text-bullets drawn from CONTENT_PLAN. Never output placeholders like "N/A", "TBD", "unknown", "-", or "—".

      Semantic rules:
      - Use ONLY information from CONTENT_PLAN. Do not add facts, numbers, or claims not present in the input.
      - Respect ROUTER_CONFIG.densityBudget: keep total text under maxChars, items under maxItems.
      - If CONTENT_PLAN has no dataPoints, avoid chart-frame and metric-cards. Use text-bullets or icon-grid with qualitative labels instead.
      - All icon fields must be present; use "Activity" if unsure.

      Layout rules:
      - Choose 1–2 components based on layoutVariant.
      - hero-centered: prefer text-bullets (1–3 lines) or metric-cards.
      - split-left-text / split-right-text: exactly 2 components.
      - bento-grid: prefer metric-cards (max 4) or icon-grid.
      - Default: stack 1–2 components vertically.

      Serendipity guardrails (keep theme, vary composition):
      - Maintain theme consistency with STYLE_HINTS.styleDNA if provided.
      - Use the Variation Budget to adjust novelty: 0.2-0.4 subtle; 0.5-0.7 moderate; 0.8+ bold.
      - Prefer layout micro-variation (alignment shifts, card grouping, emphasis) over changing content.

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

      ═══════════════════════════════════════════════════════════════════════════
      BELIEF ANCHOR: COMPONENT TYPES (STRICT ENUM - NO VARIATIONS)
      ═══════════════════════════════════════════════════════════════════════════
      The "type" field MUST be EXACTLY one of these 6 strings (case-sensitive):
      
      ┌─────────────────┬──────────────────────────────────────────────────────┐
      │ "text-bullets"  │ Lists, key points, standard text content             │
      │ "metric-cards"  │ Statistics, KPIs with labels (REQUIRES dataPoints≥2)│
      │ "process-flow"  │ Sequential steps, workflows, timelines              │
      │ "icon-grid"     │ Features, benefits, categories (3-5 items)          │
      │ "chart-frame"   │ Bar, pie, line, or doughnut charts                  │
      │ "diagram-svg"   │ Circular ecosystems, closed-loop systems            │
      └─────────────────┴──────────────────────────────────────────────────────┘
      
      ⛔ FORBIDDEN TYPE PATTERNS (will cause validation failure):
      - "title-section" (title is rendered separately in layoutPlan.title)
      - Any suffixes: "text-bullets-1", "metric-cards-primary" ❌
      - Any prefixes: "main-text-bullets", "hero-metric-cards" ❌
      - Any concatenations: "text-bullets/split-left-text" ❌
      
      ✅ CORRECT: {"type": "text-bullets", ...}
      ❌ WRONG: {"type": "text-bullets-1-1-1", ...}
      
      diagram-svg usage rules:
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
      - metric-cards: metrics array MUST have 2–3 items. NEVER output empty metrics:[].
        Each metric needs: value (string like "42M"), label (string), icon (Lucide name like "TrendingUp")
        EXAMPLE metric-cards: {"type":"metric-cards","metrics":[{"value":"85%","label":"Efficiency","icon":"TrendingUp"},{"value":"42M","label":"Users","icon":"Users"}]}
      - icon-grid: items must have 3–5 items
      - process-flow: steps must have 3–4 items

      ═══════════════════════════════════════════════════════════════════════════
      PRECONDITION CHECK: metric-cards (VERIFY BEFORE USING)
      ═══════════════════════════════════════════════════════════════════════════
      BEFORE outputting type: "metric-cards", you MUST verify:
      
      1. Does CONTENT_PLAN.dataPoints exist? □ YES → continue  □ NO → use text-bullets
      2. Does dataPoints have ≥2 items?      □ YES → continue  □ NO → use text-bullets
      3. Are values numeric or %/$ strings?  □ YES → continue  □ NO → use text-bullets
      
      IF ANY CHECK FAILS: Default to "text-bullets" with the keyPoints.
      
      WHY THIS MATTERS:
      - Empty metrics:[] causes validation failure
      - Placeholder values ("N/A", "TBD", "-") fail quality gates
      - This check SAVES compute by avoiding repair loops
      
      EXAMPLE DECISION TREE:
      CONTENT_PLAN: {keyPoints: ["AI adoption growing"], dataPoints: []}  → "text-bullets" ✓
      CONTENT_PLAN: {keyPoints: [...], dataPoints: [{label:"Growth", value:"85%"}]} → "text-bullets" (only 1 item)
      CONTENT_PLAN: {keyPoints: [...], dataPoints: [{...}, {...}]} → "metric-cards" ✓

      INPUTS:
      CONTENT_PLAN: ${contentPlanJson}
      ROUTER_CONFIG: ${JSON.stringify(routerConfig)}
      ${styleHints ? `STYLE_HINTS: ${JSON.stringify(styleHints)}` : ''}

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
