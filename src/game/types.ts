export type Cohort =
  | "scout"
  | "gatherer"
  | "builder"
  | "coordinator"
  | "critic"
  | "memory";

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
};

export type ThrongEvent = {
  id: string;
  time: string;
  kind: "claim" | "message" | "strategy" | "tower" | "trace" | "system";
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

declare global {
  interface WindowEventMap {
    "throng:update": CustomEvent<ThrongUpdate>;
    "throng:command": CustomEvent<ThrongCommand>;
  }
}
