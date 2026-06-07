import type { ClaimResult, CriticPlan, IntegrationStatus, OrchestratorPlan, ThrongEvent, ThrongMetrics } from "./types";

export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8787";

export async function getIntegrationStatus(): Promise<IntegrationStatus> {
  const response = await fetch(`${API_BASE}/api/orchestrator/status`);
  if (!response.ok) throw new Error(`status failed: ${response.status}`);
  return (await response.json()) as IntegrationStatus;
}

export async function requestOrchestratorPlan(input: {
  metrics: ThrongMetrics;
  events: ThrongEvent[];
  playerInstruction?: string;
}): Promise<OrchestratorPlan> {
  const response = await fetch(`${API_BASE}/api/orchestrator/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      metrics: input.metrics,
      events: input.events,
      player_instruction: input.playerInstruction || undefined,
    }),
  });
  if (!response.ok) throw new Error(`orchestrator failed: ${response.status}`);
  return (await response.json()) as OrchestratorPlan;
}

export async function requestCriticPlan(input: {
  metrics: ThrongMetrics;
  events: ThrongEvent[];
  currentStrategy: string;
}): Promise<CriticPlan> {
  const response = await fetch(`${API_BASE}/api/critic/reflect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      metrics: input.metrics,
      events: input.events,
      current_strategy: input.currentStrategy,
    }),
  });
  if (!response.ok) throw new Error(`critic failed: ${response.status}`);
  return (await response.json()) as CriticPlan;
}

export async function claimResource(input: {
  resourceId: string | number;
  bodyId: string | number;
  cohort: string;
}): Promise<ClaimResult> {
  const response = await fetch(`${API_BASE}/api/claims/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resource_id: String(input.resourceId),
      body_id: String(input.bodyId),
      cohort: input.cohort,
    }),
  });
  if (!response.ok) throw new Error(`claim failed: ${response.status}`);
  return (await response.json()) as ClaimResult;
}
