export type Cohort =
  | "scout"
  | "gatherer"
  | "builder"
  | "coordinator"
  | "critic"
  | "memory";

export type Phase = "babble" | "structure" | "protocol" | "lockout";

export type ThrongMetrics = {
  elapsed: number;
  towerProgress: number;
  coordination: number;
  deliveryRate: number;
  failedClaims: number;
  callsSaved: number;
  strategyScore: number;
  activeBodies: number;
  activeDirectors: number;
  activeStrategy: string;
  latestTrace: string;
  mode: "heuristic-orchestrator" | "live-agents";
  intelligence: number;
  phase: Phase;
  glyphsPerSec: number;
  uniqueTokens: number;
  crossed: boolean;
};

export type ThrongEvent = {
  id: string;
  time: string;
  kind: "claim" | "message" | "strategy" | "tower" | "trace" | "system" | "throng";
  text: string;
};

export type ThrongUpdate = {
  metrics: ThrongMetrics;
  events: ThrongEvent[];
};

export type ThrongCommand =
  | { type: "drop_resources" }
  | { type: "stress_test" }
  | { type: "boost_coordination" }
  | { type: "toggle_claims" }
  | { type: "scout_sweep" }
  | { type: "build_focus" }
  | { type: "orchestrator_plan"; plan: OrchestratorPlan };

export type OrchestratorAction =
  | "drop_resources"
  | "boost_coordination"
  | "scout_sweep"
  | "build_focus"
  | "stress_test"
  | "toggle_claims";

export type OrchestratorPlan = {
  strategy_name: string;
  summary: string;
  actions: OrchestratorAction[];
  target_cohorts: Cohort[];
  expected_effect: string;
  trace_url?: string;
  live_llm: boolean;
};

export type IntegrationStatus = {
  openai_key: boolean;
  wandb_key: boolean;
  weave_live: boolean;
  redis_live: boolean;
  redis_client: boolean;
  model: string;
  weave_project: string;
};

export type ClaimResult = {
  accepted: boolean;
  resource_id: string;
  body_id: string;
  owner: string | null;
  backend: "redis" | "memory";
  event: string;
};

export type CriticPlan = {
  strategy_name: string;
  lesson: string;
  score_delta: number;
  actions: OrchestratorAction[];
  expected_effect: string;
  trace_url?: string;
  live_llm: boolean;
};

export type PlayerAction = {
  type: string;
  time: number;
  detail?: string;
};

declare global {
  interface WindowEventMap {
    "throng:update": CustomEvent<ThrongUpdate>;
    "throng:command": CustomEvent<ThrongCommand>;
  }
}
