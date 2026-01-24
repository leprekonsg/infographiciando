import 'dotenv/config';
import express from 'express';
import { Resvg } from '@resvg/resvg-js';

const app = express();
const port = process.env.QWEN_VL_PORT || 8787;

const QWEN_VL_MODEL = 'qwen3-vl-plus-2025-12-19';
const QWEN_API_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function getApiKey() {
  return process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '';
}

function rasterizeSvgToBase64(svgString, width = 1920, height = 1080) {
  const safeSvg = svgString.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[a-fA-F0-9]+;)/g, '&amp;');
  const resvg = new Resvg(safeSvg, {
    fitTo: { mode: 'width', value: width }
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();
  return pngBuffer.toString('base64');
}

function buildCritiquePrompt() {
  return `Analyze this slide image and provide detailed visual feedback.

ANALYZE FOR:
1. Text Overlap - Any text that overlaps elements or runs off screen?
2. Contrast - Is text readable against background (WCAG AA: 4.5:1)?
3. Alignment - Are elements properly aligned? Consistent spacing?
4. Spacing - Is there too much / too little whitespace?
5. Density - Is content packed too tightly or spread out?

OUTPUT JSON with structure:
{
  "overall_score": <0-100>,
  "issues": [
    {
      "category": "text_overlap" | "contrast" | "alignment" | "spacing" | "density",
      "severity": "critical" | "warning" | "info",
      "location": { "x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1> },
      "description": "...",
      "suggested_fix": "..."
    }
  ],
  "empty_regions": [
    {
      "bbox": { "x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1> },
      "label": "safe_for_text" | "safe_for_image" | "marginal",
      "area_percentage": <0-100>
    }
  ],
  "color_analysis": {
    "primary_color": "#XXXXXX",
    "secondary_colors": ["#XXXXXX"],
    "contrast_ratio": <number>
  },
  "overall_verdict": "accept" | "flag_for_review" | "requires_repair"
}

IMPORTANT:
- Coordinates are normalized 0-1 (not pixels)
- Focus on actionable issues
- Be concise in descriptions
- Output ONLY valid JSON`;
}

function buildRepairPrompt() {
  return `ANALYZE this slide for visual quality and output STRUCTURED REPAIRS.

ANALYZE FOR:
1. Spatial Issues - Overlap, out-of-bounds content, zone violations
2. Contrast - WCAG AA compliance (4.5:1 for text)
3. Alignment - Grid adherence, consistent margins
4. Spacing - Crowding, negative space balance (optimal: 10-15% margins)
5. Hierarchy - Visual weight matches importance

COMPONENT ID FORMAT: 
The SVG contains data-component-idx attributes that map to layoutPlan.components[index].
Use ONLY the component IDs listed in the ComponentManifest comment at the top of the SVG.
Format: "{component-type}-{index}" mapping directly to layoutPlan.components[index]
- "text-bullets-0" maps to layoutPlan.components[0] (if type is text-bullets)
- "metric-cards-1" maps to layoutPlan.components[1] (if type is metric-cards)
- "chart-frame-0" maps to layoutPlan.components[0] (if type is chart-frame)
- For slide title/divider elements: use "title" or "divider" (not numbered)
DO NOT use legacy IDs like "text-title-0" or "shape-card-0" - these are internal only.

OUTPUT JSON:
{
  "overall_score": <0-100>,
  "repairs": [
    {
      "component_id": "text-bullets-0",
      "action": "reposition",
      "params": { "x": 0.05, "y": 0.35 },
      "reason": "Move down to y=0.35 to create breathing room from title"
    }
  ],
  "issues": [...],
  "verdict": "accept" | "requires_repair" | "flag_for_review"
}

ACTION PARAM SCHEMAS (MUST include numeric values):
- reposition: { "x": <0-1 normalized>, "y": <0-1 normalized> }
- resize: { "width": <0-1 fraction of slide>, "height": <0-1 fraction> }
- adjust_spacing: { "lineHeight": <1.2-2.0>, "padding": <0.01-0.1 normalized> }
- adjust_color: { "color": "#XXXXXX" }
- simplify_content: { "removeCount": <1-3> }

CRITICAL RULES:
1. params MUST contain numeric values (NOT text descriptions)
2. All coordinates/sizes normalized 0-1 (x=0 is left, y=0 is top)
3. Title optimal y position: 0.08-0.15
4. Bullets optimal y position: 0.25-0.40
5. Line height 1.6-1.8 for readability
6. Output ONLY valid JSON`;
}

function buildLayoutScorePrompt() {
  return `/no_think

Evaluate this slide layout for content accommodation and visual balance.

Score 0-100 based on:
- Content fit (40%): All content visible, no truncation, appropriate zones
- Visual balance (30%): Distributed weight, no heavy clustering
- Readability (30%): Text legible, adequate spacing, clear hierarchy

OUTPUT (strict JSON):
{
  "overall_score": <0-100>,
  "content_fit": <0-100>,
  "visual_balance": <0-100>,
  "readability": <0-100>,
  "primary_issue": "none" | "overflow" | "sparse" | "misaligned" | "cramped",
  "recommendation": "One sentence max"
}

This is a perception task - output score directly without lengthy reasoning.`;
}

async function callQwenVL({ imageBase64, prompt }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Qwen-VL API key not configured (DASHSCOPE_API_KEY or QWEN_API_KEY)');
  }

  const response = await fetch(`${QWEN_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: QWEN_VL_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`
              }
            },
            { type: 'text', text: prompt }
          ]
        }
      ],
      max_tokens: 2048,
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Qwen-VL API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const responseText = data.choices?.[0]?.message?.content || '';

  return {
    responseText,
    usage: {
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0
    }
  };
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text.trim());
  } catch (e) {
    console.warn('[QWEN-VL] Direct JSON parse failed:', e && e.message ? e.message : e);
  }

  if (text.includes('```json')) {
    try {
      const extracted = text.split('```json')[1].split('```')[0].trim();
      return JSON.parse(extracted);
    } catch (e) {
      console.warn('[QWEN-VL] ```json parse failed:', e && e.message ? e.message : e);
    }
  }

  if (text.includes('```')) {
    try {
      const parts = text.split('```');
      if (parts.length >= 2) {
        let extracted = parts[1];
        if (extracted.startsWith('json')) extracted = extracted.substring(4);
        return JSON.parse(extracted.trim());
      }
    } catch (e) {
      console.warn('[QWEN-VL] ``` block parse failed:', e && e.message ? e.message : e);
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn('[QWEN-VL] Regex parse failed:', e && e.message ? e.message : e);
    }
  }

  throw new Error('Failed to parse Qwen-VL response JSON');
}

app.get('/api/qwen/health', (req, res) => {
  res.json({ ok: true, hasKey: !!getApiKey() });
});

app.post('/api/qwen/critique', async (req, res) => {
  try {
    const { svgString, imageBase64, slideWidth = 1920, slideHeight = 1080 } = req.body || {};

    let base64 = imageBase64;
    if (!base64 && svgString) {
      base64 = rasterizeSvgToBase64(svgString, slideWidth, slideHeight);
    }

    if (!base64) {
      return res.status(400).json({ error: 'Missing svgString or imageBase64' });
    }

    const { responseText, usage } = await callQwenVL({
      imageBase64: base64,
      prompt: buildCritiquePrompt()
    });

    const result = parseJsonResponse(responseText);
    res.json({ result, usage });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/qwen/critique-repairs', async (req, res) => {
  try {
    const { svgString, imageBase64, slideWidth = 1920, slideHeight = 1080 } = req.body || {};

    let base64 = imageBase64;
    if (!base64 && svgString) {
      base64 = rasterizeSvgToBase64(svgString, slideWidth, slideHeight);
    }

    if (!base64) {
      return res.status(400).json({ error: 'Missing svgString or imageBase64' });
    }

    const { responseText, usage } = await callQwenVL({
      imageBase64: base64,
      prompt: buildRepairPrompt()
    });

    const result = parseJsonResponse(responseText);
    res.json({ result, usage });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/qwen/layout-score', async (req, res) => {
  try {
    const { svgString, imageBase64, slideWidth = 1920, slideHeight = 1080 } = req.body || {};

    let base64 = imageBase64;
    if (!base64 && svgString) {
      base64 = rasterizeSvgToBase64(svgString, slideWidth, slideHeight);
    }

    if (!base64) {
      return res.status(400).json({ error: 'Missing svgString or imageBase64' });
    }

    const { responseText, usage } = await callQwenVL({
      imageBase64: base64,
      prompt: buildLayoutScorePrompt()
    });

    const result = parseJsonResponse(responseText);
    res.json({ result, usage });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.listen(port, () => {
  console.log(`[QWEN-VL SERVER] Listening on http://localhost:${port}`);
});
