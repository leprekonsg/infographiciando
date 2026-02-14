import { GlobalStyleGuide, RouterDecision, SlideNode } from "../../types/slideTypes";
import { autoRepairSlide } from "../repair/autoRepair";
import { generateSvgProxy } from "../visual/svgProxy";
import { runLayoutRepair } from "../visualDesignAgent";
import {
    CostTracker,
    InteractionPart,
    MODEL_AGENTIC,
    Tool,
    runAgentLoop
} from "../interactionsClient";
import { validateSlide } from "../validators";

export interface MultimodalVisualGateResult {
    slide: SlideNode;
    verdict: "accept" | "accept_with_warnings" | "reroute";
    reason: string;
    rounds: number;
    attempted: boolean;
    usedTools: string[];
    cost: number;
    inputTokens: number;
    outputTokens: number;
}

function parseJsonObject(text: string): any | null {
    if (!text || typeof text !== "string") return null;
    try {
        return JSON.parse(text);
    } catch {
        // continue
    }

    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (!objectMatch) return null;
    try {
        return JSON.parse(objectMatch[0]);
    } catch {
        return null;
    }
}

function hasCriticalOverflowWarnings(slide: SlideNode): boolean {
    return (slide.warnings || []).some((w) =>
        /truncated|hidden|overflow|unplaced component|title dropped|requires \d+\.\d+ units but only/i.test(String(w))
    );
}

function mapQwenToInternalCritique(qwenCritique: any) {
    const mapCategory = (category: string): string => {
        switch (category) {
            case "text_overlap":
                return "overlap";
            case "contrast":
                return "contrast";
            case "alignment":
                return "alignment";
            case "density":
            case "spacing":
                return "density";
            default:
                return "density";
        }
    };

    return {
        issues: (qwenCritique?.issues || []).map((issue: any) => ({
            severity: issue.severity === "critical" ? "critical" : "major",
            category: mapCategory(String(issue.category || "density")),
            description: issue.description || "Visual issue detected",
            suggestedFix: issue.suggested_fix || "Adjust spacing and alignment"
        })),
        overallScore: Number(qwenCritique?.overall_score ?? 70),
        hasCriticalIssues: String(qwenCritique?.overall_verdict || "") === "requires_repair"
    };
}

export async function runMultimodalVisualGatePilot(params: {
    slide: SlideNode;
    styleGuide: GlobalStyleGuide;
    routerConfig: RouterDecision;
    costTracker: CostTracker;
    maxIterations?: number;
}): Promise<MultimodalVisualGateResult> {
    const { styleGuide, routerConfig, costTracker } = params;
    const maxIterations = Math.max(2, Math.min(4, params.maxIterations ?? 3));

    let currentSlide = JSON.parse(JSON.stringify(params.slide)) as SlideNode;
    let lastSvgProxy = "";
    let lastQwenCritique: any = null;
    let repairsApplied = 0;
    const usedTools = new Set<string>();
    let loopFailed = false;

    const pre = costTracker.getSummary();
    const preQwenCalls = pre.qwenVL?.calls || 0;

    const tools: Record<string, Tool> = {
        run_logic_gate: {
            definition: {
                name: "run_logic_gate",
                description: "Run deterministic validation checks for overflow/truncation and content fit.",
                parameters: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            execute: async () => {
                usedTools.add("run_logic_gate");
                const validation = validateSlide(currentSlide);
                return {
                    layoutVariant: currentSlide.routerConfig?.layoutVariant || routerConfig.layoutVariant,
                    validationPassed: validation.passed,
                    validationScore: validation.score,
                    criticalOverflow: hasCriticalOverflowWarnings(currentSlide),
                    warningCount: (currentSlide.warnings || []).length,
                    warnings: (currentSlide.warnings || []).slice(0, 12)
                };
            }
        },
        render_svg_proxy: {
            definition: {
                name: "render_svg_proxy",
                description: "Render the current slide to SVG and return a multimodal preview image when available.",
                parameters: {
                    type: "object",
                    properties: {
                        width: { type: "number", description: "PNG width in pixels" },
                        height: { type: "number", description: "PNG height in pixels" }
                    },
                    required: []
                }
            },
            execute: async (args: Record<string, any>) => {
                usedTools.add("render_svg_proxy");
                const width = Number(args?.width) > 0 ? Number(args.width) : 1920;
                const height = Number(args?.height) > 0 ? Number(args.height) : 1080;
                lastSvgProxy = await generateSvgProxy(currentSlide, styleGuide);

                try {
                    const { svgToPngBase64 } = await import("../visualCortex");
                    const pngBase64 = await svgToPngBase64(lastSvgProxy, width, height);
                    const preview: InteractionPart[] = [
                        { type: "text", text: `Rendered slide snapshot (${width}x${height}).` },
                        { type: "image", image: { data: pngBase64, mimeType: "image/png" } }
                    ];
                    return preview;
                } catch (err: any) {
                    return {
                        rendered: false,
                        reason: `PNG preview unavailable: ${err?.message || "unknown error"}`,
                        svgLength: lastSvgProxy.length
                    };
                }
            }
        },
        run_qwen_spatial: {
            definition: {
                name: "run_qwen_spatial",
                description: "Run the existing Qwen visual gate on the current slide to get verdict and issues.",
                parameters: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            execute: async () => {
                usedTools.add("run_qwen_spatial");
                const { isQwenVLAvailable, getVisualCritiqueFromSvg } = await import("../visualCortex");
                if (!isQwenVLAvailable()) {
                    return {
                        available: false,
                        verdict: "unavailable",
                        score: null,
                        issues: []
                    };
                }

                if (!lastSvgProxy) {
                    lastSvgProxy = await generateSvgProxy(currentSlide, styleGuide);
                }

                const critique = await getVisualCritiqueFromSvg(lastSvgProxy, costTracker);
                lastQwenCritique = critique;

                return {
                    available: true,
                    verdict: critique?.overall_verdict || "unknown",
                    score: critique?.overall_score ?? null,
                    issues: (critique?.issues || []).slice(0, 10),
                    requiresRepair: critique?.overall_verdict === "requires_repair"
                };
            }
        },
        propose_safe_repair: {
            definition: {
                name: "propose_safe_repair",
                description: "Apply one bounded layout repair pass based on latest critique.",
                parameters: {
                    type: "object",
                    properties: {
                        strategy: { type: "string", description: "Repair strategy label for logging" }
                    },
                    required: []
                }
            },
            execute: async (args: Record<string, any>) => {
                usedTools.add("propose_safe_repair");

                if (!lastQwenCritique) {
                    return { applied: false, reason: "No Qwen critique available yet." };
                }

                if (!lastSvgProxy) {
                    lastSvgProxy = await generateSvgProxy(currentSlide, styleGuide);
                }

                const critique = mapQwenToInternalCritique(lastQwenCritique);
                const repaired = await runLayoutRepair(currentSlide, critique, lastSvgProxy, costTracker);
                currentSlide = autoRepairSlide(repaired, styleGuide);
                // Invalidate cached render/critique so follow-up checks inspect repaired state.
                lastSvgProxy = "";
                lastQwenCritique = null;
                repairsApplied += 1;

                return {
                    applied: true,
                    strategy: String(args?.strategy || "bounded"),
                    repairsApplied,
                    warnings: (currentSlide.warnings || []).slice(0, 8)
                };
            }
        }
    };

    const prompt = `You are the Visual Gate Orchestrator for slide quality assurance.

You must decide one final verdict:
- "accept"
- "accept_with_warnings"
- "reroute"

Rules:
1. Always run run_logic_gate first.
2. If critical overflow/truncation is detected, return "reroute" immediately.
3. If logic gate passes but confidence is low, call render_svg_proxy then run_qwen_spatial.
4. If Qwen verdict is requires_repair, you may call propose_safe_repair once, then re-check run_logic_gate.
5. Stay bounded and finish quickly.

Return strict JSON only:
{
  "verdict": "accept | accept_with_warnings | reroute",
  "reason": "short reason",
  "finalScore": <0-100>,
  "usedTools": ["tool_name"],
  "qwenVerdict": "accept | flag_for_review | requires_repair | unavailable | unknown"
}

Slide context:
- title: ${JSON.stringify(currentSlide.title || "Untitled")}
- layoutVariant: ${JSON.stringify(currentSlide.routerConfig?.layoutVariant || routerConfig.layoutVariant)}
- warnings: ${JSON.stringify((currentSlide.warnings || []).slice(0, 8))}`;

    let loopText = "";
    try {
        const loopResult = await runAgentLoop(
            prompt,
            {
                model: MODEL_AGENTIC,
                systemInstruction: "You are strict about deterministic quality gates and must avoid over-repairing.",
                tools,
                maxIterations,
                temperature: 0.1,
                thinkingLevel: "low",
                contextMode: "server",
                toolResultMode: "native_result"
            },
            costTracker
        );
        loopText = loopResult.text || "";
    } catch (err: any) {
        loopFailed = true;
        loopText = "";
        currentSlide.warnings = [
            ...(currentSlide.warnings || []),
            `MMFC visual gate fallback: ${err?.message || "unknown agent loop error"}`
        ];
    }

    const parsed = parseJsonObject(loopText) || {};
    const finalValidation = validateSlide(currentSlide);
    const hasCriticalOverflow = hasCriticalOverflowWarnings(currentSlide);
    const parsedVerdict = String(parsed.verdict || "").toLowerCase();
    const parsedUsedTools = parsed.usedTools && Array.isArray(parsed.usedTools)
        ? parsed.usedTools.map((t: any) => String(t))
        : Array.from(usedTools);
    const logicGateWasExecuted = parsedUsedTools.includes("run_logic_gate") || usedTools.has("run_logic_gate");
    const qwenRequiresRepair = String(lastQwenCritique?.overall_verdict || "").toLowerCase() === "requires_repair";

    let verdict: "accept" | "accept_with_warnings" | "reroute";
    if (loopFailed || !logicGateWasExecuted || hasCriticalOverflow || parsedVerdict === "reroute" || qwenRequiresRepair) {
        verdict = "reroute";
    } else if (finalValidation.passed && parsedVerdict === "accept") {
        verdict = "accept";
    } else if (finalValidation.passed && parsedVerdict === "accept_with_warnings") {
        verdict = "accept_with_warnings";
    } else {
        // Fail-safe: unresolved/ambiguous outcomes should hand off to stronger fallback path.
        verdict = "reroute";
    }

    const post = costTracker.getSummary();
    const costDelta = Math.max(0, post.totalCost - pre.totalCost);
    const inputDelta = Math.max(0, post.totalInputTokens - pre.totalInputTokens);
    const outputDelta = Math.max(0, post.totalOutputTokens - pre.totalOutputTokens);
    const qwenCallDelta = Math.max(0, (post.qwenVL?.calls || 0) - preQwenCalls);
    costTracker.addMmfcVisualMetrics(costDelta, inputDelta, outputDelta, qwenCallDelta > 0 ? qwenCallDelta : 1);

    return {
        slide: currentSlide,
        verdict,
        reason: String(parsed.reason || (verdict === "reroute"
            ? "Critical overflow/truncation detected"
            : "MMFC visual gate completed")),
        rounds: maxIterations,
        attempted: true,
        usedTools: parsedUsedTools,
        cost: costDelta,
        inputTokens: inputDelta,
        outputTokens: outputDelta
    };
}
