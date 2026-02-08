import type {
  AgentLoopConfig,
  AgentLoopResult,
  AgentLoopStepContext,
  LoopIssue,
  LoopRunTrace,
  LoopVerdict
} from "../types/agentLoopTypes";

const defaultLoopId = () => `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const summarizeIssues = (issues: LoopIssue[]): string => {
  if (!issues.length) return "no issues";
  const critical = issues.filter(i => i.severity === "critical").length;
  const major = issues.filter(i => i.severity === "major").length;
  const minor = issues.filter(i => i.severity === "minor").length;
  return `issues c:${critical} m:${major} n:${minor}`;
};

export async function runAgentLoop<TState, TEnv = unknown>(
  config: AgentLoopConfig<TState, TEnv>
): Promise<AgentLoopResult<TState, TEnv>> {
  const startedAt = Date.now();
  const trace: LoopRunTrace = {
    loopId: config.loopId || defaultLoopId(),
    slideId: config.slideId,
    pipeline: config.pipeline || "unknown",
    startedAt,
    endedAt: startedAt,
    iterations: [],
    finalVerdict: "abort",
    warnings: []
  };

  let state = config.initialState;
  let env: TEnv | undefined;
  let issues: LoopIssue[] = [];
  let verdict: LoopVerdict = "retry";
  let score: number | undefined;

  const scoreHistory: number[] = [];
  const issueHistory: string[] = [];
  const stagnationWindow = Math.max(2, config.policy.stagnationWindow || 2);
  const minImprovementDelta = config.policy.minImprovementDelta ?? 1;

  const pushTrace = (entry: LoopRunTrace["iterations"][number]) => {
    trace.iterations.push(entry);
    config.onTrace?.(entry, trace);
  };

  for (let iteration = 1; iteration <= config.policy.maxIterations; iteration++) {
    if (config.policy.maxTimeMs && Date.now() - startedAt > config.policy.maxTimeMs) {
      verdict = config.policy.allowSoftAccept ? "accept_with_warnings" : "abort";
      trace.warnings?.push(`time_budget_exceeded:${config.policy.maxTimeMs}`);
      break;
    }

    const observeStart = Date.now();
    const observeCtx: AgentLoopStepContext<TState, TEnv> = { iteration, state, env, issues, trace };
    env = await config.observe(observeCtx);
    pushTrace({
      iteration,
      phase: "observe",
      inputsSummary: "environment captured",
      timeMs: Date.now() - observeStart
    });

    const diagnoseStart = Date.now();
    const diagnoseCtx: AgentLoopStepContext<TState, TEnv> = { iteration, state, env, issues, trace };
    issues = await config.diagnose(diagnoseCtx);
    pushTrace({
      iteration,
      phase: "diagnose",
      inputsSummary: summarizeIssues(issues),
      issues,
      timeMs: Date.now() - diagnoseStart
    });

    const issueSignature = issues
      .map(i => `${i.code}:${i.severity}`)
      .sort()
      .join("|");
    issueHistory.push(issueSignature);

    const actStart = Date.now();
    const actCtx: AgentLoopStepContext<TState, TEnv> = { iteration, state, env, issues, trace };
    const actResult = await config.act(actCtx);
    state = actResult.state;
    pushTrace({
      iteration,
      phase: "act",
      actions: actResult.actions || [],
      inputsSummary: actResult.actions?.map(a => a.kind).join(", ") || "no-op",
      timeMs: Date.now() - actStart
    });

    const verifyStart = Date.now();
    const verifyCtx: AgentLoopStepContext<TState, TEnv> = {
      iteration,
      state,
      env,
      issues,
      actions: actResult.actions,
      trace
    };
    const verifyResult = await config.verify(verifyCtx);
    if (verifyResult.state !== undefined) {
      state = verifyResult.state;
    }
    verdict = verifyResult.verdict;
    score = verifyResult.score;

    if (typeof score === "number") {
      scoreHistory.push(score);
      trace.finalScore = score;
    }
    if (verifyResult.warning) {
      trace.warnings?.push(verifyResult.warning);
    }

    pushTrace({
      iteration,
      phase: "verify",
      verify: {
        effectScore: verifyResult.effectScore ?? (typeof score === "number" ? score : 0),
        unresolvedIssueCodes: issues.map(i => i.code),
        verdictHint: verdict
      },
      inputsSummary: `verdict=${verdict}`,
      timeMs: Date.now() - verifyStart
    });

    if (verdict !== "retry") {
      break;
    }

    if (issueHistory.length >= stagnationWindow) {
      const recentIssues = issueHistory.slice(-stagnationWindow);
      const stagnantIssues = recentIssues.every(sig => sig === recentIssues[0]);

      let stagnantScore = false;
      if (scoreHistory.length >= stagnationWindow) {
        const recentScores = scoreHistory.slice(-stagnationWindow);
        const improvement = Math.max(...recentScores) - Math.min(...recentScores);
        stagnantScore = improvement < minImprovementDelta;
      }

      if (stagnantIssues && stagnantScore) {
        verdict = config.policy.allowSoftAccept ? "accept_with_warnings" : "abort";
        trace.warnings?.push("stagnation_detected");
        break;
      }
    }
  }

  trace.endedAt = Date.now();
  trace.finalVerdict = verdict;

  return {
    state,
    env,
    issues,
    verdict,
    score,
    iterations: trace.iterations.length,
    trace
  };
}
