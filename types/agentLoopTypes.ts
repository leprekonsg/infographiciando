export type LoopPhase = 'observe' | 'diagnose' | 'act' | 'verify';

export type LoopVerdict =
  | 'accept'
  | 'accept_with_warnings'
  | 'reroute'
  | 'retry'
  | 'abort';

export type LoopIssueSeverity = 'critical' | 'major' | 'minor';
export type LoopIssueCategory = 'content' | 'layout' | 'visual' | 'quality' | 'system';

export interface LoopIssue {
  code: string;
  severity: LoopIssueSeverity;
  category: LoopIssueCategory;
  message: string;
  target?: string;
  evidence?: Record<string, any>;
}

export interface LoopAction {
  kind: string;
  params?: Record<string, any>;
  source: 'deterministic' | 'model' | 'policy';
  expectedEffect?: string;
}

export interface LoopIterationTrace {
  iteration: number;
  phase: LoopPhase;
  inputsSummary?: string;
  issues?: LoopIssue[];
  actions?: LoopAction[];
  verify?: {
    effectScore: number;
    unresolvedIssueCodes: string[];
    verdictHint?: LoopVerdict;
  };
  costDelta?: number;
  timeMs: number;
}

export interface LoopRunTrace {
  loopId: string;
  slideId: string;
  pipeline: 'director' | 'generator' | 'visual-architect' | 'unknown';
  startedAt: number;
  endedAt: number;
  iterations: LoopIterationTrace[];
  finalVerdict: LoopVerdict;
  finalScore?: number;
  warnings?: string[];
}

export interface LoopPolicy {
  maxIterations: number;
  maxTimeMs?: number;
  maxCostDelta?: number;
  stagnationWindow?: number;
  minImprovementDelta?: number;
  allowSoftAccept?: boolean;
}

export interface LoopActResult<TState> {
  state: TState;
  actions?: LoopAction[];
}

export interface LoopVerifyResult<TState> {
  state?: TState;
  verdict: LoopVerdict;
  score?: number;
  warning?: string;
  effectScore?: number;
}

export interface AgentLoopStepContext<TState, TEnv> {
  iteration: number;
  state: TState;
  env?: TEnv;
  issues?: LoopIssue[];
  actions?: LoopAction[];
  trace: LoopRunTrace;
}

export interface AgentLoopConfig<TState, TEnv = unknown> {
  loopId?: string;
  slideId: string;
  pipeline?: LoopRunTrace['pipeline'];
  initialState: TState;
  policy: LoopPolicy;
  observe: (ctx: AgentLoopStepContext<TState, TEnv>) => Promise<TEnv> | TEnv;
  diagnose: (ctx: AgentLoopStepContext<TState, TEnv>) => Promise<LoopIssue[]> | LoopIssue[];
  act: (ctx: AgentLoopStepContext<TState, TEnv>) => Promise<LoopActResult<TState>> | LoopActResult<TState>;
  verify: (ctx: AgentLoopStepContext<TState, TEnv>) => Promise<LoopVerifyResult<TState>> | LoopVerifyResult<TState>;
  onTrace?: (entry: LoopIterationTrace, runTrace: LoopRunTrace) => void;
}

export interface AgentLoopResult<TState, TEnv = unknown> {
  state: TState;
  env?: TEnv;
  issues: LoopIssue[];
  verdict: LoopVerdict;
  score?: number;
  iterations: number;
  trace: LoopRunTrace;
}
