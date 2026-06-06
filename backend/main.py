import json
import os
import time
from enum import Enum
from typing import Any, Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    import weave
except Exception:  # pragma: no cover
    weave = None

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore


OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
WEAVE_PROJECT = os.getenv("WEAVE_PROJECT", "the-throng")


class Action(str, Enum):
    drop_resources = "drop_resources"
    boost_coordination = "boost_coordination"
    scout_sweep = "scout_sweep"
    build_focus = "build_focus"
    stress_test = "stress_test"
    toggle_claims = "toggle_claims"


class Metrics(BaseModel):
    elapsed: float = 0
    towerProgress: float = 0
    coordination: float = 0
    deliveryRate: float = 0
    failedClaims: int = 0
    callsSaved: float = 0
    strategyScore: float = 0
    activeBodies: int = 0
    activeDirectors: int = 0
    activeStrategy: str = ""
    latestTrace: str = ""
    mode: str = ""


class Event(BaseModel):
    time: str = ""
    kind: str = ""
    text: str = ""


class OrchestratorRequest(BaseModel):
    metrics: Metrics
    events: list[Event] = Field(default_factory=list)
    player_instruction: str | None = None


class OrchestratorPlan(BaseModel):
    strategy_name: str
    summary: str
    actions: list[Action]
    target_cohorts: list[Literal["scout", "gatherer", "builder", "coordinator", "critic", "memory"]]
    expected_effect: str
    trace_url: str | None = None
    live_llm: bool = False


app = FastAPI(title="The Throng Orchestrator")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://localhost:5173", "http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if weave and os.getenv("WANDB_API_KEY"):
    try:
      weave.init(WEAVE_PROJECT)
    except Exception:
      pass


def _event_text(events: list[Event]) -> str:
    if not events:
        return "No recent events."
    return "\n".join(f"- [{event.kind}] {event.text}" for event in events[:8])


def _fallback_plan(req: OrchestratorRequest, reason: str) -> OrchestratorPlan:
    metrics = req.metrics
    actions: list[Action] = []
    cohorts: list[str] = []

    if req.player_instruction:
        text = req.player_instruction.lower()
        if "scout" in text or "spread" in text or "corner" in text:
            actions.append(Action.scout_sweep)
            cohorts.extend(["scout", "coordinator"])
        if "build" in text or "tower" in text or "deposit" in text:
            actions.append(Action.build_focus)
            cohorts.extend(["builder", "coordinator"])
        if "critic" in text or "improve" in text or "coordinate" in text:
            actions.append(Action.boost_coordination)
            cohorts.extend(["critic", "coordinator"])
        if "resource" in text or "seed" in text or "shard" in text:
            actions.append(Action.drop_resources)
            cohorts.extend(["scout", "gatherer"])

    if not actions:
        if metrics.failedClaims > 35:
            actions = [Action.boost_coordination, Action.scout_sweep]
            cohorts = ["critic", "scout", "coordinator"]
        elif metrics.towerProgress < 0.25:
            actions = [Action.drop_resources, Action.scout_sweep]
            cohorts = ["scout", "gatherer"]
        elif metrics.coordination < 0.62:
            actions = [Action.boost_coordination, Action.build_focus]
            cohorts = ["critic", "builder", "coordinator"]
        else:
            actions = [Action.build_focus]
            cohorts = ["builder", "coordinator"]

    deduped = list(dict.fromkeys(cohorts)) or ["coordinator"]
    return OrchestratorPlan(
        strategy_name="claim backoff after collision" if metrics.failedClaims > 30 else "directed tower build",
        summary=f"Local orchestrator selected {', '.join(action.value for action in actions)}. {reason}",
        actions=actions[:3],
        target_cohorts=deduped[:4],  # type: ignore[arg-type]
        expected_effect="Reduce duplicate claims and push bodies into legal scout/build lanes.",
        trace_url="local://heuristic-orchestrator",
        live_llm=False,
    )


def _build_prompt(req: OrchestratorRequest) -> list[dict[str, str]]:
    metrics = req.metrics
    instruction = req.player_instruction or "No direct player instruction. Improve the colony toward the Signal Tower."
    return [
        {
            "role": "system",
            "content": (
                "You are The Throng's Orchestrator Director. You do not move sprites directly. "
                "You choose high-level, game-legal actions for a bounded Phaser world. "
                "Optimize for building the Signal Tower, reducing duplicate claim collisions, and improving coordination. "
                "Return only valid JSON matching the provided schema. Keep actions short and executable."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Player instruction: {instruction}\n\n"
                "Current colony metrics:\n"
                f"- towerProgress: {metrics.towerProgress:.2f}\n"
                f"- coordination: {metrics.coordination:.2f}\n"
                f"- failedClaims: {metrics.failedClaims}\n"
                f"- strategyScore: {metrics.strategyScore:.2f}\n"
                f"- activeBodies: {metrics.activeBodies}\n"
                f"- activeDirectors: {metrics.activeDirectors}\n"
                f"- activeStrategy: {metrics.activeStrategy}\n\n"
                "Recent events:\n"
                f"{_event_text(req.events)}\n\n"
                "Allowed actions: drop_resources, boost_coordination, scout_sweep, build_focus, stress_test, toggle_claims.\n"
                "Choose 1-3 actions."
            ),
        },
    ]


def _schema() -> dict[str, Any]:
    return {
        "name": "throng_orchestrator_plan",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "strategy_name": {"type": "string"},
                "summary": {"type": "string"},
                "actions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 3,
                    "items": {
                        "type": "string",
                        "enum": [action.value for action in Action],
                    },
                },
                "target_cohorts": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 4,
                    "items": {
                        "type": "string",
                        "enum": ["scout", "gatherer", "builder", "coordinator", "critic", "memory"],
                    },
                },
                "expected_effect": {"type": "string"},
            },
            "required": ["strategy_name", "summary", "actions", "target_cohorts", "expected_effect"],
        },
    }


def _call_openai(req: OrchestratorRequest) -> OrchestratorPlan:
    if not os.getenv("OPENAI_API_KEY"):
        return _fallback_plan(req, "OPENAI_API_KEY is not set.")
    if OpenAI is None:
        return _fallback_plan(req, "openai package could not be imported.")

    client = OpenAI()
    response = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=_build_prompt(req),
        response_format={"type": "json_schema", "json_schema": _schema()},
        temperature=0.35,
    )
    raw = response.choices[0].message.content or "{}"
    data = json.loads(raw)
    plan = OrchestratorPlan(**data)
    plan.live_llm = True
    plan.trace_url = f"openai://chat.completions/{int(time.time())}"
    return plan


if weave and os.getenv("WANDB_API_KEY"):
    decide_op = weave.op()(_call_openai)
else:
    decide_op = _call_openai


@app.get("/api/orchestrator/status")
def status() -> dict[str, Any]:
    return {
        "openai_key": bool(os.getenv("OPENAI_API_KEY")),
        "wandb_key": bool(os.getenv("WANDB_API_KEY")),
        "model": OPENAI_MODEL,
        "weave_project": WEAVE_PROJECT,
    }


@app.post("/api/orchestrator/decide", response_model=OrchestratorPlan)
def decide(req: OrchestratorRequest) -> OrchestratorPlan:
    try:
        return decide_op(req)
    except Exception as exc:
        return _fallback_plan(req, f"LLM call failed: {exc.__class__.__name__}.")
