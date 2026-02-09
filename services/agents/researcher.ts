import { ResearchFact } from "../../types/slideTypes";
import { createInteraction, runAgentLoop, CostTracker, ThinkingLevel, MODEL_AGENTIC } from "../interactionsClient";

interface ResearchPass {
    id: string;
    focus: string;
    objective: string;
    targetFacts: number;
}

const RESEARCH_FACT_SCHEMA = {
    type: 'object',
    properties: {
        facts: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    category: { type: 'string' },
                    claim: { type: 'string' },
                    value: { type: 'string' },
                    source: { type: 'string' },
                    confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
                },
                required: ['category', 'claim', 'confidence']
            }
        }
    },
    required: ['facts']
};

const normalizeConfidence = (raw: any): 'high' | 'medium' | 'low' => {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'high' || value === 'medium' || value === 'low') return value;
    if (value.includes('high')) return 'high';
    if (value.includes('low')) return 'low';
    return 'medium';
};

const normalizeFact = (raw: any, fallbackId: string): ResearchFact | null => {
    if (!raw || typeof raw !== 'object') return null;

    const claim = String(raw.claim || '').trim();
    if (claim.length < 16) return null;

    const category = String(raw.category || 'General').trim() || 'General';
    const source = String(raw.source || '').trim() || undefined;
    const value = String(raw.value || '').trim() || undefined;

    return {
        id: String(raw.id || fallbackId),
        category,
        claim,
        value,
        source,
        confidence: normalizeConfidence(raw.confidence)
    };
};

const parseFactsFromJson = (rawText: string): ResearchFact[] => {
    if (!rawText || typeof rawText !== 'string') return [];

    const parseCandidate = (candidate: string): ResearchFact[] => {
        try {
            const parsed = JSON.parse(candidate);
            const rawFacts = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.facts) ? parsed.facts : []);
            return rawFacts
                .map((item: any, idx: number) => normalizeFact(item, `fact-${idx + 1}`))
                .filter((fact: ResearchFact | null): fact is ResearchFact => fact !== null);
        } catch {
            return [];
        }
    };

    const direct = parseCandidate(rawText);
    if (direct.length > 0) return direct;

    const objectMatch = rawText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
        const extractedObject = parseCandidate(objectMatch[0]);
        if (extractedObject.length > 0) return extractedObject;
    }

    const arrayMatch = rawText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        const extractedArray = parseCandidate(arrayMatch[0]);
        if (extractedArray.length > 0) return extractedArray;
    }

    return [];
};

const scoreFactQuality = (fact: ResearchFact): number => {
    let score = 0;
    if (fact.confidence === 'high') score += 3;
    else if (fact.confidence === 'medium') score += 1;
    if (fact.source && fact.source.length > 6) score += 2;
    if (/\d/.test(`${fact.claim} ${fact.value || ''}`)) score += 2;
    if ((fact.value || '').length > 0) score += 1;
    if (fact.claim.length > 60) score += 1;
    return score;
};

const mergeAndRankFacts = (facts: ResearchFact[], maxFacts = 14): ResearchFact[] => {
    const deduped = new Map<string, ResearchFact>();
    for (const fact of facts) {
        const key = fact.claim
            .toLowerCase()
            .replace(/[^\w\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!key) continue;

        const existing = deduped.get(key);
        if (!existing || scoreFactQuality(fact) > scoreFactQuality(existing)) {
            deduped.set(key, fact);
        }
    }

    return Array.from(deduped.values())
        .sort((a, b) => scoreFactQuality(b) - scoreFactQuality(a))
        .slice(0, maxFacts)
        .map((fact, idx) => ({ ...fact, id: `fact-${idx + 1}` }));
};

const hasResearchCoverage = (facts: ResearchFact[]): boolean => {
    if (facts.length < 10) return false;
    const withSources = facts.filter(f => !!f.source && f.source.trim().length > 6).length;
    const quantitative = facts.filter(f => /\d/.test(`${f.claim} ${f.value || ''}`)).length;
    return withSources >= 7 && quantitative >= 4;
};

async function runGroundedPass(
    topic: string,
    pass: ResearchPass,
    costTracker: CostTracker
): Promise<ResearchFact[]> {
    const prompt = `Research topic: "${topic}".

FOCUS AREA: ${pass.focus}
OBJECTIVE: ${pass.objective}

Requirements:
1. Return ${Math.max(4, pass.targetFacts - 2)}-${pass.targetFacts} non-duplicative facts.
2. Prioritize concrete evidence (benchmarks, percentages, timelines, cost/latency/quality metrics) where applicable.
3. Every fact must include a source identifier (publication or URL).
4. Keep claims specific and presentation-ready.

Return JSON only in the format:
{
  "facts": [
    {
      "id": "fact-1",
      "category": "Market Trend | Technical Spec | Statistic | Expert Opinion | Implementation",
      "claim": "Specific factual claim",
      "value": "Optional quantitative value",
      "source": "Source publication or URL",
      "confidence": "high | medium | low"
    }
  ]
}`;

    try {
        const text = await createInteraction(
            MODEL_AGENTIC,
            prompt,
            {
                systemInstruction: `You are a senior technical researcher.
- Prefer recent and authoritative sources.
- Avoid generic statements.
- Do not invent citations.
- Output strict JSON only.`,
                responseFormat: RESEARCH_FACT_SCHEMA,
                responseMimeType: 'application/json',
                temperature: 0.2,
                maxOutputTokens: 4096,
                thinkingLevel: 'low' as ThinkingLevel,
                tools: [{ type: 'google_search' }]
            },
            costTracker
        );

        const parsedFacts = parseFactsFromJson(text);
        if (parsedFacts.length > 0) {
            console.log(`[RESEARCHER] Pass "${pass.id}" collected ${parsedFacts.length} grounded facts`);
        } else {
            console.warn(`[RESEARCHER] Pass "${pass.id}" returned no parseable grounded facts`);
        }
        return parsedFacts;
    } catch (err: any) {
        console.warn(`[RESEARCHER] Grounded pass "${pass.id}" failed: ${err.message}`);
        return [];
    }
}

async function runFallbackSinglePass(topic: string, costTracker: CostTracker): Promise<ResearchFact[]> {
    try {
        const result = await runAgentLoop(
            `Perform research on "${topic}" and return 8-10 verified facts with category, claim, optional value, source, confidence.
Return JSON only.`,
            {
                model: MODEL_AGENTIC,
                systemInstruction: `You are a technical researcher. Return strict JSON only.`,
                tools: {},
                maxIterations: 4,
                thinkingLevel: 'low' as ThinkingLevel,
                temperature: 0.2
            },
            costTracker
        );
        return parseFactsFromJson(result.text);
    } catch (err: any) {
        console.warn(`[RESEARCHER] Fallback single-pass failed: ${err.message}`);
        return [];
    }
}

export async function runFocusedResearch(
    query: string,
    costTracker: CostTracker,
    options: { maxFacts?: number } = {}
): Promise<ResearchFact[]> {
    const pass: ResearchPass = {
        id: 'focused',
        focus: 'slide-specific facts',
        objective: 'Find concise, relevant facts for one presentation slide',
        targetFacts: Math.min(8, Math.max(3, options.maxFacts ?? 5))
    };

    const facts = await runGroundedPass(query, pass, costTracker);
    return mergeAndRankFacts(facts, pass.targetFacts);
}

export async function runResearcher(topic: string, costTracker: CostTracker): Promise<ResearchFact[]> {
    console.log("[RESEARCHER] Starting grounded multi-pass research...");

    const passes: ResearchPass[] = [
        {
            id: 'baseline',
            focus: 'core landscape',
            objective: 'Establish key concepts, current state, and widely accepted framing',
            targetFacts: 8
        },
        {
            id: 'quantitative',
            focus: 'metrics and benchmarks',
            objective: 'Find quantitative evidence: adoption, performance, costs, ROI, latency, error rates',
            targetFacts: 8
        },
        {
            id: 'implementation',
            focus: 'deployment and architecture',
            objective: 'Find implementation patterns, trade-offs, failure modes, and production lessons',
            targetFacts: 6
        }
    ];

    let collected: ResearchFact[] = [];

    for (const pass of passes) {
        if (pass.id !== 'baseline' && hasResearchCoverage(collected)) {
            console.log(`[RESEARCHER] Coverage threshold reached after ${collected.length} facts. Skipping remaining passes.`);
            break;
        }

        const passFacts = await runGroundedPass(topic, pass, costTracker);
        collected = mergeAndRankFacts([...collected, ...passFacts], 16);
    }

    if (collected.length < 8) {
        console.warn(`[RESEARCHER] Grounded passes produced ${collected.length} facts. Running fallback research pass.`);
        const fallbackFacts = await runFallbackSinglePass(topic, costTracker);
        collected = mergeAndRankFacts([...collected, ...fallbackFacts], 16);
    }

    const finalFacts = mergeAndRankFacts(collected, 12);
    console.log(`[RESEARCHER] Final fact set: ${finalFacts.length} facts`);
    return finalFacts;
}
