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
4. Spacing - Crowding, negative space balance
5. Hierarchy - Visual weight matches importance

OUTPUT JSON:
{
  "overall_score": <0-100>,
  "repairs": [
    {
      "component_id": "<component-type>-<index>",
      "action": "resize" | "reposition" | "adjust_color" | "adjust_spacing" | "simplify_content",
      "params": { <action-specific params> },
      "reason": "<why this repair is needed>"
    }
  ],
  "issues": [
    {
      "category": "text_overlap" | "contrast" | "alignment" | "spacing" | "density",
      "severity": "critical" | "warning" | "info",
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
  "verdict": "accept" | "requires_repair" | "flag_for_review"
}

IMPORTANT:
- Component IDs format: "{type}-{index}" (e.g., "text-bullets-0", "metric-cards-1")
- Coordinates normalized 0-1 (not pixels) → will be converted to slide units
- Only suggest repairs that improve score by ≥5 points
- Preserve ALL text content (spatial changes only)
- Output ONLY valid JSON`;
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
  } catch {}

  if (text.includes('```json')) {
    try {
      const extracted = text.split('```json')[1].split('```')[0].trim();
      return JSON.parse(extracted);
    } catch {}
  }

  if (text.includes('```')) {
    try {
      const parts = text.split('```');
      if (parts.length >= 2) {
        let extracted = parts[1];
        if (extracted.startsWith('json')) extracted = extracted.substring(4);
        return JSON.parse(extracted.trim());
      }
    } catch {}
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
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

app.listen(port, () => {
  console.log(`[QWEN-VL SERVER] Listening on http://localhost:${port}`);
});
