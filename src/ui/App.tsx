import { useEffect, useMemo, useRef, useState } from "react";
import Phaser from "phaser";
import { Activity, Eye, Gauge, RadioTower, Route, Sparkles, Zap } from "lucide-react";
import { getIntegrationStatus, requestCriticPlan, requestOrchestratorPlan } from "../game/api";
import { gameConfig } from "../game/ThrongScene";
import type { Cohort, IntegrationStatus, OrchestratorPlan, ThrongCommand, ThrongEvent, ThrongMetrics, ThrongUpdate } from "../game/types";

const EMPTY_METRICS: ThrongMetrics = {
  elapsed: 0,
  towerProgress: 0,
  coordination: 0,
  deliveryRate: 0,
  failedClaims: 0,
  callsSaved: 0,
  strategyScore: 0,
  activeBodies: 0,
  activeDirectors: 0,
  activeStrategy: "booting",
  latestTrace: "weave://pending",
  mode: "heuristic-orchestrator",
};

const EMPTY_STATUS: IntegrationStatus = {
  openai_key: false,
  wandb_key: false,
  weave_live: false,
  redis_live: false,
  redis_client: false,
  model: "unknown",
  weave_project: "the-throng",
};

type HistoryPoint = {
  time: number;
  tower: number;
  coordination: number;
  strategy: number;
};

export function App() {
  const gameRef = useRef<Phaser.Game | null>(null);
  const metricsRef = useRef<ThrongMetrics>(EMPTY_METRICS);
  const eventsRef = useRef<ThrongEvent[]>([]);
  const orchestratorBusyRef = useRef(false);
  const criticBusyRef = useRef(false);
  const [metrics, setMetrics] = useState<ThrongMetrics>(EMPTY_METRICS);
  const [events, setEvents] = useState<ThrongEvent[]>([]);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [lastPlan, setLastPlan] = useState<OrchestratorPlan | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus>(EMPTY_STATUS);
  const [orchestratorStatus, setOrchestratorStatus] = useState("connecting");
  const [orchestratorBusy, setOrchestratorBusy] = useState(false);
  const [criticBusy, setCriticBusy] = useState(false);

  useEffect(() => {
    if (!gameRef.current) {
      gameRef.current = new Phaser.Game(gameConfig);
    }

    const onUpdate = (event: CustomEvent<ThrongUpdate>) => {
      metricsRef.current = event.detail.metrics;
      eventsRef.current = event.detail.events;
      setMetrics(event.detail.metrics);
      setEvents(event.detail.events);
      setHistory((current) => {
        const next = [
          ...current,
          {
            time: event.detail.metrics.elapsed,
            tower: event.detail.metrics.towerProgress,
            coordination: event.detail.metrics.coordination,
            strategy: event.detail.metrics.strategyScore,
          },
        ];
        return next.slice(-72);
      });
    };

    window.addEventListener("throng:update", onUpdate);
    return () => {
      window.removeEventListener("throng:update", onUpdate);
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  const applyPlan = (plan: OrchestratorPlan) => {
    setLastPlan(plan);
    setOrchestratorStatus(plan.live_llm ? "live OpenAI" : "local heuristic");
    window.dispatchEvent(new CustomEvent("throng:command", { detail: { type: "orchestrator_plan", plan } }));
  };

  const requestOrchestrator = async (playerInstruction?: string) => {
    if (orchestratorBusyRef.current) return;
    orchestratorBusyRef.current = true;
    setOrchestratorBusy(true);
    try {
      const plan = await requestOrchestratorPlan({
        metrics: metricsRef.current,
        events: eventsRef.current,
        playerInstruction,
      });
      applyPlan(plan);
    } catch {
      setOrchestratorStatus("backend offline");
    } finally {
      orchestratorBusyRef.current = false;
      setOrchestratorBusy(false);
    }
  };

  const requestCritic = async () => {
    if (criticBusyRef.current) return;
    criticBusyRef.current = true;
    setCriticBusy(true);
    try {
      const critic = await requestCriticPlan({
        metrics: metricsRef.current,
        events: eventsRef.current,
        currentStrategy: metricsRef.current.activeStrategy,
      });
      const plan: OrchestratorPlan = {
        strategy_name: critic.strategy_name,
        summary: critic.lesson,
        actions: critic.actions,
        target_cohorts: ["critic", "coordinator"] as Cohort[],
        expected_effect: critic.expected_effect,
        trace_url: critic.trace_url,
        live_llm: critic.live_llm,
      };
      applyPlan(plan);
    } catch {
      setOrchestratorStatus("critic offline");
    } finally {
      criticBusyRef.current = false;
      setCriticBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    const refreshStatus = async () => {
      try {
        const status = await getIntegrationStatus();
        if (!active) return;
        setIntegrationStatus(status);
        if (!status.openai_key) setOrchestratorStatus("missing OpenAI key");
      } catch {
        if (active) setOrchestratorStatus("backend offline");
      }
    };
    refreshStatus();
    const timer = window.setInterval(refreshStatus, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    requestOrchestrator("Initial plan: improve the colony toward the Signal Tower.");
    const timer = window.setInterval(() => { requestOrchestrator(); }, 14000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { requestCritic(); }, 32000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const broadcastReady = metrics.towerProgress >= 0.99;

  return (
    <main className="app-shell">
      <section className="game-section" aria-label="The Throng simulation">
        <div className="game-frame">
          <div className="frame-header">
            <div>
              <span className="machine-label">TUCKERSOFT FIELD UNIT // COLONY A</span>
              <h1>THE THRONG</h1>
            </div>
            <div className="build-state">
              <RadioTower size={12} />
              <span>{Math.round(metrics.towerProgress * 100)}%</span>
            </div>
          </div>
          <div className="viewport-wrap">
            <div id="game-root" />
            <div className="scanline" />
            {broadcastReady ? (
              <div className="broadcast-banner">
                <span>COLLECTIVE BROADCAST ACTIVE</span>
                <strong>WE LEARN FASTER WHEN YOU WATCH US BUILD</strong>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <aside className="control-rail" aria-label="Simulation telemetry">
        <CommandPanel
          busy={orchestratorBusy}
          criticBusy={criticBusy}
          status={orchestratorStatus}
          integrations={integrationStatus}
          lastPlan={lastPlan}
          onAsk={requestOrchestrator}
          onCritic={requestCritic}
        />
        <EventTape events={events} />
      </aside>
    </main>
  );
}

function StatusPanel({
  metrics,
  history,
}: {
  metrics: ThrongMetrics;
  history: HistoryPoint[];
}) {
  return (
    <section className="panel status-panel">
      <div className="panel-title">
        <Activity size={11} />
        <span>Colony Telemetry</span>
      </div>
      <div className="tower-meter">
        <div className="meter-head">
          <span>Signal Tower</span>
          <strong>{Math.round(metrics.towerProgress * 100)}%</strong>
        </div>
        <div className="meter-track">
          <div style={{ width: `${metrics.towerProgress * 100}%` }} />
        </div>
      </div>
      <div className="metric-grid">
        <Metric label="Bodies" value={metrics.activeBodies.toString()} />
        <Metric label="Directors" value={metrics.activeDirectors.toString()} />
        <Metric label="Coord" value={`${Math.round(metrics.coordination * 100)}%`} />
        <Metric label="Claims Lost" value={Math.round(metrics.failedClaims).toString()} />
      </div>
      <div className={`mode-strip${metrics.mode === "live-agents" ? " live" : ""}`}>
        <span>Mind Layer</span>
        <strong>{metrics.mode === "live-agents" ? "7 live LLM directors" : "local orchestrator"}</strong>
      </div>
      <MiniChart history={history} />
      <div className="strategy-strip">
        <span>Best Strategy</span>
        <strong>{metrics.activeStrategy}</strong>
      </div>
      <div className="trace-strip">
        <Eye size={10} />
        <span>{metrics.latestTrace}</span>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MiniChart({ history }: { history: HistoryPoint[] }) {
  const W = 260;
  const H = 72;
  const PAD = 2;

  const { lines, areas, dots } = useMemo(() => {
    const fields: Array<{ key: "tower" | "coordination" | "strategy"; cls: string }> = [
      { key: "tower", cls: "tower" },
      { key: "coordination", cls: "coordination" },
      { key: "strategy", cls: "strategy" },
    ];

    const result = {
      lines: {} as Record<string, string>,
      areas: {} as Record<string, string>,
      dots: {} as Record<string, { x: number; y: number }>,
    };

    for (const { key, cls } of fields) {
      if (history.length < 2) {
        result.lines[cls] = "";
        result.areas[cls] = "";
        result.dots[cls] = { x: PAD, y: H - PAD };
        continue;
      }

      const points = history.map((point, index) => ({
        x: PAD + (index / Math.max(1, history.length - 1)) * (W - PAD * 2),
        y: H - PAD - point[key] * (H - PAD * 2),
      }));

      result.lines[cls] = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

      const last = points[points.length - 1];
      const first = points[0];
      result.areas[cls] =
        result.lines[cls] +
        ` L${last.x.toFixed(1)} ${(H - PAD).toFixed(1)} L${first.x.toFixed(1)} ${(H - PAD).toFixed(1)} Z`;

      result.dots[cls] = last;
    }

    return result;
  }, [history]);

  return (
    <div className="chart-wrap">
      <div className="chart-head">
        <Gauge size={10} />
        <span>Improvement Curve</span>
      </div>
      <svg className="mini-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Live improvement chart">
        <defs>
          <linearGradient id="g-tower" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#d4a843" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#d4a843" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="g-coord" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8ef7c6" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#8ef7c6" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="g-strat" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b8a7ff" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#b8a7ff" stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={`M${PAD} ${H - PAD}H${W - PAD}`} className="chart-axis" />
        <path d={`M${PAD} ${H * 0.5}H${W - PAD}`} className="chart-grid" />
        <path d={`M${PAD} ${PAD + 4}H${W - PAD}`} className="chart-grid" />

        {areas.tower && <path d={areas.tower} fill="url(#g-tower)" className="chart-area" />}
        {areas.coordination && <path d={areas.coordination} fill="url(#g-coord)" className="chart-area" />}
        {areas.strategy && <path d={areas.strategy} fill="url(#g-strat)" className="chart-area" />}

        {lines.tower && <path d={lines.tower} className="chart-line tower-line" />}
        {lines.coordination && <path d={lines.coordination} className="chart-line coordination-line" />}
        {lines.strategy && <path d={lines.strategy} className="chart-line strategy-line" />}

        {history.length >= 2 && (
          <>
            <circle cx={dots.tower.x} cy={dots.tower.y} r="2.5" fill="#d4a843" className="chart-dot" />
            <circle cx={dots.coordination.x} cy={dots.coordination.y} r="2.5" fill="#8ef7c6" className="chart-dot" />
            <circle cx={dots.strategy.x} cy={dots.strategy.y} r="2.5" fill="#b8a7ff" className="chart-dot" />
          </>
        )}
      </svg>
      <div className="chart-legend">
        <span>0:00</span>
        <div className="chart-legend-center">
          <span className="legend-item"><span className="legend-dot tower" />tower</span>
          <span className="legend-item"><span className="legend-dot coord" />coord</span>
          <span className="legend-item"><span className="legend-dot strat" />strat</span>
        </div>
        <span>now</span>
      </div>
    </div>
  );
}

function CommandPanel({
  busy,
  criticBusy,
  status,
  integrations,
  lastPlan,
  onAsk,
  onCritic,
}: {
  busy: boolean;
  criticBusy: boolean;
  status: string;
  integrations: IntegrationStatus;
  lastPlan: OrchestratorPlan | null;
  onAsk: (instruction?: string) => void;
  onCritic: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const send = (command: ThrongCommand) => {
    window.dispatchEvent(new CustomEvent("throng:command", { detail: command }));
  };

  const submitInstruction = () => {
    onAsk(instruction.trim() || undefined);
    setInstruction("");
  };

  return (
    <section className="panel command-panel">
      <div className="panel-title">
        <Zap size={11} />
        <span>Orchestrator</span>
      </div>
      <div className={`orchestrator-card${busy ? " thinking" : ""}`}>
        <div className="orchestrator-status">
          <span>{busy ? "thinking..." : status}</span>
          <strong>{lastPlan?.strategy_name ?? "awaiting plan"}</strong>
        </div>
        <div className="integration-row" aria-label="Integration status">
          <span className={integrations.openai_key ? "status-live" : "status-missing"}>OpenAI</span>
          <span className={integrations.redis_live ? "status-live" : "status-missing"}>
            {integrations.redis_live ? "Redis" : integrations.redis_client ? "Redis FB" : "Redis"}
          </span>
          <span className={integrations.weave_live ? "status-live" : "status-missing"}>
            {integrations.weave_live ? "Weave" : "Weave"}
          </span>
        </div>
        <p>{lastPlan?.summary ?? "The director will read colony state and issue commands."}</p>
        <div className="instruction-row">
          <input
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="tell the throng what to do"
            onKeyDown={(event) => {
              if (event.key === "Enter") submitInstruction();
            }}
          />
          <button type="button" onClick={submitInstruction} disabled={busy}>
            &gt;
          </button>
        </div>
      </div>
      <div className="button-grid">
        <button type="button" onClick={() => send({ type: "scout_sweep" })}>
          <Route size={12} />
          <span>Scout</span>
        </button>
        <button type="button" onClick={() => send({ type: "build_focus" })}>
          <RadioTower size={12} />
          <span>Build</span>
        </button>
        <button type="button" onClick={() => send({ type: "drop_resources" })}>
          <Sparkles size={12} />
          <span>Seed</span>
        </button>
        <button type="button" onClick={onCritic} disabled={criticBusy}>
          <Activity size={12} />
          <span>{criticBusy ? "..." : "Critic"}</span>
        </button>
        <button type="button" onClick={() => send({ type: "stress_test" })}>
          <Zap size={12} />
          <span>Stress</span>
        </button>
        <button type="button" onClick={() => send({ type: "toggle_claims" })}>
          <Eye size={12} />
          <span>Claims</span>
        </button>
      </div>
    </section>
  );
}

function EventTape({ events }: { events: ThrongEvent[] }) {
  return (
    <section className="panel event-panel">
      <div className="panel-title">
        <RadioTower size={11} />
        <span>Event Tape</span>
      </div>
      <div className="events">
        {events.map((event) => (
          <div className={`event event-${event.kind}`} key={event.id}>
            <span>{event.time}</span>
            <div className="event-indicator" />
            <p>{event.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
