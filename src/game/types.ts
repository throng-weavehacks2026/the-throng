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
  activeCreatures: number;
  activeStrategy: string;
  latestTrace: string;
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
  | { type: "toggle_claims" };

declare global {
  interface WindowEventMap {
    "throng:update": CustomEvent<ThrongUpdate>;
    "throng:command": CustomEvent<ThrongCommand>;
  }
}
