import json
import os
import time
from enum import Enum
from pathlib import Path
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

try:
    import redis
except Exception:  # pragma: no cover
    redis = None  # type: ignore


def load_local_env() -> None:
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().lstrip("\ufeff")
        value = value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


load_local_env()

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
WEAVE_PROJECT = os.getenv("WEAVE_PROJECT", "the-throng")
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
_memory_claims: dict[str, tuple[str, float]] = {}
_memory_strategies: dict[str, float] = {}
_redis_client: Any | None = None
_weave_ready = False


class Action(str, Enum):
    drop_resources = "drop_resources"
    boost_coordination = "boost_coordination"
    scout_sweep = "scout_sweep"
    build_focus = "build_focus"
    stress_test = "stress_test"
    toggle_claims = "toggle_claims"


PLAN_ACTIONS = [Action.drop_resources, Action.boost_coordination, Action.scout_sweep, Action.build_focus]


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


class ClaimRequest(BaseModel):
    resource_id: str
    body_id: str
    cohort: str = "unknown"


class ClaimResponse(BaseModel):
    accepted: bool
    resource_id: str
    body_id: str
    owner: str | None = None
    backend: Literal["redis", "memory"]
    event: str


class CriticRequest(BaseModel):
    metrics: Metrics
    events: list[Event] = Field(default_factory=list)
    current_strategy: str = ""


class CriticPlan(BaseModel):
    strategy_name: str
    lesson: str
    score_delta: float
    actions: list[Action]
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
        _weave_ready = True
    except Exception:
        pass


def redis_client() -> Any | None:
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    if redis is None:
        return None
    try:
        client = redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=0.25, socket_timeout=0.5)
        client.ping()
        _redis_client = client
        return client
    except Exception:
        _redis_client = None
        return None


def redis_live() -> bool:
    return redis_client() is not None


def log_event(kind: str, text: str, fields: dict[str, Any] | None = None) -> None:
    client = redis_client()
    if not client:
        return
    payload = {
        "kind": kind,
        "text": text,
        "ts": str(time.time()),
    }
    if fields:
        payload.update({key: str(value) for key, value in fields.items()})
    try:
        client.xadd("stream:world:events", payload, maxlen=500, approximate=True)
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
                "Allowed actions: drop_resources, boost_coordination, scout_sweep, build_focus.\n"
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
                        "enum": [action.value for action in PLAN_ACTIONS],
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


def _critic_schema() -> dict[str, Any]:
    return {
        "name": "throng_critic_plan",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "strategy_name": {"type": "string"},
                "lesson": {"type": "string"},
                "score_delta": {"type": "number"},
                "actions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 3,
                    "items": {
                        "type": "string",
                        "enum": [action.value for action in PLAN_ACTIONS],
                    },
                },
                "expected_effect": {"type": "string"},
            },
            "required": ["strategy_name", "lesson", "score_delta", "actions", "expected_effect"],
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


def _fallback_critic(req: CriticRequest, reason: str) -> CriticPlan:
    metrics = req.metrics
    if metrics.failedClaims > 25:
        name = "claim backoff after collision"
        actions = [Action.boost_coordination, Action.scout_sweep]
        lesson = "Duplicate resource claims are wasting bodies. Redirect failed claimants into scout lanes before retrying."
    elif metrics.towerProgress < 0.5:
        name = "builder-first deposit windows"
        actions = [Action.build_focus, Action.drop_resources]
        lesson = "The tower is underfed. Hold builders near the tower and keep gatherers supplied with nearby shards."
    else:
        name = "tower orbit synchronization"
        actions = [Action.build_focus, Action.boost_coordination]
        lesson = "The colony is ready to compress around the tower and finish the signal."

    return CriticPlan(
        strategy_name=name,
        lesson=f"{lesson} {reason}",
        score_delta=0.06,
        actions=actions,
        expected_effect="Improve delivery rate while reducing failed claims.",
        trace_url="local://critic",
        live_llm=False,
    )


def _call_critic(req: CriticRequest) -> CriticPlan:
    if not os.getenv("OPENAI_API_KEY"):
        return _fallback_critic(req, "OPENAI_API_KEY is not set.")
    if OpenAI is None:
        return _fallback_critic(req, "openai package could not be imported.")

    metrics = req.metrics
    client = OpenAI()
    response = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are The Throng's Critic Director. Diagnose why the colony is not building the Signal Tower faster. "
                    "Return a reusable strategy that the Orchestrator can apply next. Avoid UI-only changes."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Current strategy: {req.current_strategy or metrics.activeStrategy}\n"
                    f"towerProgress={metrics.towerProgress:.2f}, coordination={metrics.coordination:.2f}, "
                    f"failedClaims={metrics.failedClaims}, strategyScore={metrics.strategyScore:.2f}, "
                    f"deliveryRate={metrics.deliveryRate:.2f}\n\n"
                    "Recent events:\n"
                    f"{_event_text(req.events)}\n\n"
                    "Allowed actions: drop_resources, boost_coordination, scout_sweep, build_focus."
                ),
            },
        ],
        response_format={"type": "json_schema", "json_schema": _critic_schema()},
        temperature=0.25,
    )
    raw = response.choices[0].message.content or "{}"
    plan = CriticPlan(**json.loads(raw))
    plan.live_llm = True
    plan.trace_url = f"openai://chat.completions/critic-{int(time.time())}"
    return plan


if weave and os.getenv("WANDB_API_KEY"):
    decide_op = weave.op()(_call_openai)
    critic_op = weave.op()(_call_critic)
else:
    decide_op = _call_openai
    critic_op = _call_critic


@app.get("/api/orchestrator/status")
def status() -> dict[str, Any]:
    return {
        "openai_key": bool(os.getenv("OPENAI_API_KEY")),
        "wandb_key": bool(os.getenv("WANDB_API_KEY")),
        "weave_live": _weave_ready,
        "redis_live": redis_live(),
        "redis_client": redis is not None,
        "model": OPENAI_MODEL,
        "weave_project": WEAVE_PROJECT,
    }


@app.post("/api/orchestrator/decide", response_model=OrchestratorPlan)
def decide(req: OrchestratorRequest) -> OrchestratorPlan:
    try:
        plan = decide_op(req)
        log_event("orchestrator", plan.summary, {"strategy": plan.strategy_name, "live_llm": plan.live_llm})
        return plan
    except Exception as exc:
        return _fallback_plan(req, f"LLM call failed: {exc.__class__.__name__}.")


@app.post("/api/claims/claim", response_model=ClaimResponse)
def claim(req: ClaimRequest) -> ClaimResponse:
    key = f"claim:resource:{req.resource_id}"
    owner = f"body:{req.body_id}"
    client = redis_client()

    if client:
        try:
            accepted = bool(client.set(key, owner, nx=True, ex=10))
            current_owner = owner if accepted else client.get(key)
            event = (
                f"Redis SET NX claim won: resource:{req.resource_id} -> {owner}"
                if accepted
                else f"Redis SET NX rejected: resource:{req.resource_id} already owned by {current_owner}"
            )
            client.xadd(
                "stream:claims",
                {
                    "resource_id": req.resource_id,
                    "body_id": req.body_id,
                    "cohort": req.cohort,
                    "accepted": str(accepted),
                    "owner": current_owner or "",
                    "ts": str(time.time()),
                },
                maxlen=500,
                approximate=True,
            )
            log_event("claim", event, {"resource_id": req.resource_id, "body_id": req.body_id, "accepted": accepted})
            return ClaimResponse(
                accepted=accepted,
                resource_id=req.resource_id,
                body_id=req.body_id,
                owner=current_owner,
                backend="redis",
                event=event,
            )
        except Exception:
            pass

    now = time.time()
    expired = [claim_key for claim_key, (_, expires_at) in _memory_claims.items() if expires_at <= now]
    for claim_key in expired:
        _memory_claims.pop(claim_key, None)

    if key not in _memory_claims:
        _memory_claims[key] = (owner, now + 10)
        event = f"Memory claim won: resource:{req.resource_id} -> {owner}"
        accepted = True
        current_owner = owner
    else:
        current_owner = _memory_claims[key][0]
        event = f"Memory claim rejected: resource:{req.resource_id} already owned by {current_owner}"
        accepted = False

    return ClaimResponse(
        accepted=accepted,
        resource_id=req.resource_id,
        body_id=req.body_id,
        owner=current_owner,
        backend="memory",
        event=event,
    )


@app.post("/api/critic/reflect", response_model=CriticPlan)
def reflect(req: CriticRequest) -> CriticPlan:
    try:
        plan = critic_op(req)
    except Exception as exc:
        plan = _fallback_critic(req, f"Critic call failed: {exc.__class__.__name__}.")

    score = max(0.0, min(1.0, req.metrics.strategyScore + plan.score_delta))
    _memory_strategies[plan.strategy_name] = score
    client = redis_client()
    if client:
        try:
            client.zadd("zset:strategies", {plan.strategy_name: score})
            client.xadd(
                "stream:critic",
                {
                    "strategy": plan.strategy_name,
                    "lesson": plan.lesson,
                    "score_delta": str(plan.score_delta),
                    "live_llm": str(plan.live_llm),
                    "ts": str(time.time()),
                },
                maxlen=200,
                approximate=True,
            )
        except Exception:
            pass
    log_event("critic", plan.lesson, {"strategy": plan.strategy_name, "score_delta": plan.score_delta})
    return plan
