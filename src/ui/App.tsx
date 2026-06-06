import { useEffect, useMemo, useRef, useState } from "react";
import Phaser from "phaser";
import { Activity, Eye, Gauge, RadioTower, Route, Sparkles, Zap } from "lucide-react";
import { gameConfig } from "../game/ThrongScene";
import type { ThrongCommand, ThrongEvent, ThrongMetrics, ThrongUpdate } from "../game/types";

const EMPTY_METRICS: ThrongMetrics = {
  elapsed: 0,
  towerProgress: 0,
  coordination: 0,
  deliveryRate: 0,
  failedClaims: 0,
  callsSaved: 0,
  strategyScore: 0,
  activeCreatures: 0,
  activeStrategy: "booting",
  latestTrace: "weave://pending",
};

type HistoryPoint = {
  time: number;
  tower: number;
  coordination: number;
  strategy: number;
};

export function App() {
  const gameRef = useRef<Phaser.Game | null>(null);
  const [metrics, setMetrics] = useState<ThrongMetrics>(EMPTY_METRICS);
  const [events, setEvents] = useState<ThrongEvent[]>([]);
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  useEffect(() => {
    if (!gameRef.current) {
      gameRef.current = new Phaser.Game(gameConfig);
    }

    const onUpdate = (event: CustomEvent<ThrongUpdate>) => {
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

  const broadcastReady = metrics.towerProgress >= 0.99;

  return (
    <main className="app-shell">
      <section className="game-section" aria-label="The Throng simulation">
        <div className="game-frame">
          <div className="frame-header">
            <div>
              <span className="machine-label">TUCKERSOFT FIELD UNIT</span>
              <h1>The Throng</h1>
            </div>
            <div className="build-state">
              <RadioTower size={16} />
              <span>{Math.round(metrics.towerProgress * 100)}%</span>
            </div>
          </div>
          <div className="viewport-wrap">
            <div id="game-root" />
            <div className="scanline" />
            {broadcastReady ? (
              <div className="broadcast-banner">
                <span>COLLECTIVE BROADCAST</span>
                <strong>WE LEARN FASTER WHEN YOU WATCH US BUILD</strong>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <aside className="control-rail" aria-label="Simulation telemetry">
        <StatusPanel metrics={metrics} history={history} />
        <CommandPanel />
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
        <Activity size={15} />
        <span>Live Colony</span>
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
        <Metric label="Creatures" value={metrics.activeCreatures.toString()} />
        <Metric label="Coordination" value={`${Math.round(metrics.coordination * 100)}%`} />
        <Metric label="Claims Lost" value={metrics.failedClaims.toString()} />
        <Metric label="Calls Saved" value={`${Math.round(metrics.callsSaved * 100)}%`} />
      </div>
      <MiniChart history={history} />
      <div className="strategy-strip">
        <span>Best Strategy</span>
        <strong>{metrics.activeStrategy}</strong>
      </div>
      <div className="trace-strip">
        <Eye size={14} />
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
  const paths = useMemo(() => {
    const makePath = (field: "tower" | "coordination" | "strategy") => {
      if (history.length < 2) return "";
      return history
        .map((point, index) => {
          const x = (index / Math.max(1, history.length - 1)) * 226;
          const y = 76 - point[field] * 68;
          return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(" ");
    };

    return {
      tower: makePath("tower"),
      coordination: makePath("coordination"),
      strategy: makePath("strategy"),
    };
  }, [history]);

  return (
    <div className="chart-wrap">
      <div className="chart-head">
        <Gauge size={14} />
        <span>Improvement Curve</span>
      </div>
      <svg className="mini-chart" viewBox="0 0 226 82" role="img" aria-label="Live improvement chart">
        <path d="M0 76H226" className="chart-axis" />
        <path d="M0 42H226" className="chart-grid" />
        <path d={paths.tower} className="chart-line tower-line" />
        <path d={paths.coordination} className="chart-line coordination-line" />
        <path d={paths.strategy} className="chart-line strategy-line" />
      </svg>
      <div className="chart-legend">
        <span>Tower</span>
        <span>Coordination</span>
        <span>Strategy</span>
      </div>
    </div>
  );
}

function CommandPanel() {
  const send = (command: ThrongCommand) => {
    window.dispatchEvent(new CustomEvent("throng:command", { detail: command }));
  };

  return (
    <section className="panel command-panel">
      <div className="panel-title">
        <Zap size={15} />
        <span>Operator</span>
      </div>
      <div className="button-grid">
        <button type="button" onClick={() => send({ type: "drop_resources" })}>
          <Sparkles size={15} />
          <span>Seed Field</span>
        </button>
        <button type="button" onClick={() => send({ type: "boost_coordination" })}>
          <Activity size={15} />
          <span>Apply Critic</span>
        </button>
        <button type="button" onClick={() => send({ type: "stress_test" })}>
          <Zap size={15} />
          <span>Stress Claims</span>
        </button>
        <button type="button" onClick={() => send({ type: "toggle_claims" })}>
          <Route size={15} />
          <span>Claim Lines</span>
        </button>
      </div>
    </section>
  );
}

function EventTape({ events }: { events: ThrongEvent[] }) {
  return (
    <section className="panel event-panel">
      <div className="panel-title">
        <RadioTower size={15} />
        <span>Event Tape</span>
      </div>
      <div className="events">
        {events.map((event) => (
          <div className={`event event-${event.kind}`} key={event.id}>
            <span>{event.time}</span>
            <p>{event.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
