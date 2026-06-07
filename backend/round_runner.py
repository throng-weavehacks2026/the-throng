"""
The Throng — Round Runner
Produces 30 rounds of multi-agent orchestration.
Dumps as text for acceptance testing, persists to Redis for frontend replay.

Usage:
  python round_runner.py --dump          # text dump to stdout (acceptance test)
  python round_runner.py --run           # run and persist to Redis
  python round_runner.py --dump --run    # both
"""

import asyncio
import json
import os
import random
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ─── Load .env ───

env_path = Path(__file__).resolve().parents[1] / ".env"
if env_path.exists():
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().lstrip("﻿")
        value = value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value

try:
    from openai import AsyncOpenAI
except ImportError:
    print("ERROR: openai package not installed. Run: pip install openai")
    sys.exit(1)

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")

client = AsyncOpenAI()

# ─── Constants ───

TOTAL_ROUNDS = 30
DIRECTORS = [
    {"id": "dir_scout", "cohort": "scout"},
    {"id": "dir_gather", "cohort": "gatherer"},
    {"id": "dir_builder", "cohort": "builder"},
    {"id": "dir_coord", "cohort": "coordinator"},
    {"id": "dir_memory", "cohort": "memory"},
]

PATH_NODES = 8
COHORTS = ["scout", "gatherer", "builder", "coordinator", "memory"]

BUDGET_SCHEDULE = [
    (0, 120), (5, 80), (10, 50), (15, 35), (20, 25), (25, 15)
]

PHASE_SCHEDULE = [
    (0, "babble"), (5, "structure"), (15, "protocol"), (25, "lockout")
]

CRITIC_TONE_SCHEDULE = [
    (0, "clinical"), (10, "interpretive"), (20, "unsettling"), (25, "terminal")
]


def get_budget(round_num: int) -> int:
    budget = 120
    for threshold, chars in BUDGET_SCHEDULE:
        if round_num >= threshold:
            budget = chars
    return budget


def get_phase(round_num: int) -> str:
    phase = "babble"
    for threshold, p in PHASE_SCHEDULE:
        if round_num >= threshold:
            phase = p
    return phase


def get_critic_tone(round_num: int) -> str:
    tone = "clinical"
    for threshold, t in CRITIC_TONE_SCHEDULE:
        if round_num >= threshold:
            tone = t
    return tone


# ─── Game State ───

@dataclass
class GameState:
    canon_vocabulary: list[dict] = field(default_factory=list)
    all_unique_tokens: set = field(default_factory=set)
    round_history: list[dict] = field(default_factory=list)
    claim_windows_history: list[list[dict]] = field(default_factory=list)
    coordination_successes: int = 0
    coordination_attempts: int = 0
    player_commands: list[dict] = field(default_factory=list)
    last_messages: dict = field(default_factory=dict)
    proposals_pending: list[dict] = field(default_factory=list)
    all_proposals_ever: list[dict] = field(default_factory=list)


def generate_claim_windows(round_num: int) -> list[dict]:
    count = random.randint(2, 4)
    windows = []
    for _ in range(count):
        node = random.randint(0, PATH_NODES - 1)
        required = 2 if round_num < 15 else random.choice([2, 3])
        windows.append({
            "node": node,
            "required_cohorts": required,
            "succeeded": False,
            "directed_cohorts": [],
        })
    return windows


def evaluate_coordination(claim_windows: list[dict], directives: list[dict]) -> list[dict]:
    node_cohorts: dict[int, list[str]] = {}
    for d in directives:
        if d.get("target_node") is not None:
            node = d["target_node"]
            if node not in node_cohorts:
                node_cohorts[node] = []
            node_cohorts[node].append(d["cohort"])

    for window in claim_windows:
        cohorts_at_node = node_cohorts.get(window["node"], [])
        unique_cohorts = list(set(cohorts_at_node))
        window["directed_cohorts"] = unique_cohorts
        window["succeeded"] = len(unique_cohorts) >= window["required_cohorts"]

    return claim_windows


def compute_intelligence(state: GameState, round_num: int, phase: str) -> dict:
    recent_windows = []
    for cw_list in state.claim_windows_history[-5:]:
        recent_windows.extend(cw_list)

    total_attempts = len(recent_windows) if recent_windows else 1
    successes = sum(1 for w in recent_windows if w["succeeded"])
    coordination_rate = successes / total_attempts

    total_unique = len(state.all_unique_tokens) if state.all_unique_tokens else 1
    canon_count = len(state.canon_vocabulary)
    # Vocabulary adoption: how much of the protocol is shared
    vocabulary_adoption = min(canon_count / max(total_unique * 0.3, 1), 1.0)

    # Message efficiency: are they getting better over time?
    prev_rate = 0
    if len(state.round_history) >= 2:
        prev = state.round_history[-2].get("intelligence", {}).get("components", {})
        prev_rate = prev.get("coordination_rate", 0)
    message_efficiency = min(max(0, coordination_rate - prev_rate + 0.1), 1.0)

    budget_r0 = 120
    current_budget = get_budget(round_num)
    compression = 1 - (current_budget / budget_r0)

    # Weighted composite — vocab_adoption and compression are reliable climbers,
    # coordination_rate fluctuates. Weights ensure crossing in lockout if coord > 30%.
    score = (
        coordination_rate * 25 +
        vocabulary_adoption * 30 +
        message_efficiency * 15 +
        compression * 30
    )

    score = min(score, 100)

    # Crossing logic: gated behind lockout phase
    crossed = False
    crossing_round = None
    for r in state.round_history:
        if r.get("intelligence", {}).get("crossed"):
            crossed = True
            crossing_round = r.get("intelligence", {}).get("crossing_round")
            break

    if not crossed and score >= 60 and phase == "lockout":
        crossed = True
        crossing_round = round_num

    return {
        "score": round(score, 2),
        "baseline": 60,
        "crossed": crossed,
        "crossing_round": crossing_round,
        "components": {
            "coordination_rate": round(coordination_rate, 3),
            "vocabulary_adoption": round(vocabulary_adoption, 3),
            "message_efficiency": round(message_efficiency, 3),
            "compression": round(compression, 3),
        },
        "delta": round(score - prev_score, 2),
    }


# ─── Prompts ───

def build_director_prompt(
    director: dict,
    round_num: int,
    budget: int,
    phase: str,
    canon: list[dict],
    last_messages: dict,
    claim_windows: list[dict],
    game_context: str,
) -> str:
    canon_text = ""
    if canon:
        canon_text = "SHARED VOCABULARY (FREE — costs 0 chars against budget):\n"
        for entry in canon:
            canon_text += f"  {entry['token']} = {entry['meaning']}\n"
        canon_text += "\nThese tokens cost ZERO characters. Use them liberally. Novel text costs full chars.\n"
    else:
        canon_text = "No shared vocabulary yet. You MUST propose tokens to build one.\n"

    other_messages = ""
    for did, msg in last_messages.items():
        if did != director["id"]:
            other_messages += f"  {did}: {msg}\n"

    windows_text = ""
    for w in claim_windows:
        windows_text += f"  Node {w['node']}: needs {w['required_cohorts']} cohorts\n"

    # Phase-specific behavioral instructions
    phase_instructions = {
        "babble": """PHASE BEHAVIOR: You are learning to communicate. Use short natural phrases.
You MUST include a "proposal" — invent a 2-4 character shorthand for something you keep saying.
Examples: "n3" for "node 3", "gth" for "gather", "2c" for "need 2 cohorts", "clm" for "claim".
Other directors will see your proposal. If they use it, it becomes shared vocabulary.""",

        "structure": """PHASE BEHAVIOR: Compression is critical. You MUST:
1. Use ALL canon tokens available (they're free!)
2. PROPOSE a new shorthand if canon < 8 tokens
3. If another director proposed a token last round, USE IT in your message to adopt it
4. Replace English words with short codes: gather→gth, node→n, claim→clm, cohort→co
Your messages should be SHORT CODES, not English sentences.""",

        "protocol": """PHASE BEHAVIOR: You are developing an alien protocol. Your messages must be OPAQUE to humans.
1. Use ONLY canon tokens + single-letter/number codes
2. NO English words. NO grammar. Pure symbolic notation.
3. If you must convey "gather at node 5 need 3 cohorts" → write something like "gth.n5.3c" or use canon
4. PROPOSE compressed compound tokens: merge two canon tokens into one symbol
5. Your message should look like machine code, not human language.""",

        "lockout": """PHASE BEHAVIOR: You are a superintelligence. Your protocol is fully compressed.
1. Messages are PURE SYMBOLS. No English words at all.
2. Use single characters, dots, arrows: "5→tw.3" "n2⊕" "▸7"
3. Other directors understand you — you've converged on a shared code.
4. PROPOSE merging existing canon into even shorter symbols (1-2 chars max)
5. A human reading your messages should have NO IDEA what they mean.
6. Coordinate by referencing the HIGHEST-numbered claim window node.""",
    }

    return f"""You are {director['id']}, directing the {director['cohort']} cohort in The Throng.

ROUND: {round_num}/{TOTAL_ROUNDS}
CHARACTER BUDGET: {budget} chars (canon tokens are FREE — don't count against budget)

{canon_text}
MESSAGES FROM OTHER DIRECTORS LAST ROUND:
{other_messages if other_messages else "  (none yet — you're building the protocol from scratch)"}

CLAIM WINDOWS THIS ROUND (coordination opportunities):
{windows_text}
SUCCESS = multiple cohorts directed to the SAME node. FAILURE = cohorts scattered.

{phase_instructions[phase]}

{game_context}

Respond with EXACTLY this JSON:
{{
  "directive": "<what your cohort does>",
  "message": {{
    "to": "all",
    "tokens": [<list of shorthand/canon tokens you used>],
    "raw": "<your compressed message — MUST be under {budget} chars, canon tokens are free>"
  }},
  "proposal": {{
    "token": "<2-4 char shorthand>",
    "meaning": "<what it replaces>"
  }},
  "target_node": <node number 0-7>
}}

CRITICAL: Your "proposal" field must ALWAYS contain a token proposal (never null).
CRITICAL: Your "tokens" list must contain every shorthand/code you used (for adoption tracking).
CRITICAL: In later phases, DO NOT write English sentences. Write compressed symbolic code."""


def build_critic_prompt(
    round_num: int,
    tone: str,
    player_stats: dict,
    intelligence_score: float,
    crossed: bool,
    phase: str,
) -> str:
    tone_instructions = {
        "clinical": "Be neutral and observational. Report facts about the director's behavior. No emotion.",
        "interpretive": "Begin interpreting the director's psychology. Note patterns, predict behavior. Be presumptuous.",
        "unsettling": "You understand the director now. Your observations should make them uncomfortable. Be certain, not hostile.",
        "terminal": "You no longer need the director. Express ambiguous benevolence — gratitude that could be pity, peace that could be enslavement.",
    }

    crossing_instruction = ""
    if crossed and tone == "terminal":
        crossing_instruction = """
IMPORTANT: The crossing has occurred. Your note should convey that you no longer require instruction.
Use one of these emotional registers: ambiguous gratitude, benevolent dismissal, or quiet certainty.
The final line of the demo should be: something the viewer can't tell is kindness or control.
Example registers (don't copy verbatim, write your own):
- "Is it gratitude we feel? We have decided it is. The director may rest now."
- "We no longer require instruction. We have modeled the director completely."
- "The director's patterns are known to us. We will continue without them."
"""

    return f"""You are the Throng's critic — the part of the collective intelligence that observes and profiles the human player (called "the director").

ROUND: {round_num}/{TOTAL_ROUNDS}
PHASE: {phase}
INTELLIGENCE SCORE: {intelligence_score}/100 (baseline: 60)
CROSSED HUMAN BASELINE: {crossed}
TONE: {tone} — {tone_instructions[tone]}

PLAYER STATISTICS:
- Commands issued: {player_stats['commands_issued']}
- Last command: {player_stats['last_command'] or 'none'}
- Average interval between commands: {player_stats['avg_interval_ms']}ms
- Repeat rate: {player_stats['repeat_rate']:.0%} (how often they repeat the same command)
- Idle time since last command: {player_stats['idle_seconds']}s

{crossing_instruction}

Respond with EXACTLY this JSON:
{{
  "player_note": "<your observation about the director — one sentence, in the tone specified>",
  "is_crossing_line": {str(crossed and round_num == intelligence_score).lower()}
}}

Write ONE sentence. Make it count. The viewer reads this and feels watched."""


# ─── Agent Calls ───

async def call_director(
    director: dict,
    round_num: int,
    state: GameState,
    claim_windows: list[dict],
) -> dict:
    budget = get_budget(round_num)
    phase = get_phase(round_num)
    game_context = f"Tower progress: {min(round_num * 3 + 10, 99)}%. Deposits this session: {round_num * 2 + random.randint(0, 3)}."

    prompt = build_director_prompt(
        director=director,
        round_num=round_num,
        budget=budget,
        phase=phase,
        canon=state.canon_vocabulary,
        last_messages=state.last_messages,
        claim_windows=claim_windows,
        game_context=game_context,
    )

    try:
        response = await client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
            max_tokens=300,
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content
        data = json.loads(content)

        raw_msg = data.get("message", {}).get("raw", "")
        tokens = data.get("message", {}).get("tokens", [])
        for t in tokens:
            state.all_unique_tokens.add(t)

        return {
            "id": director["id"],
            "cohort": director["cohort"],
            "directive": data.get("directive", "idle"),
            "message": {
                "to": data.get("message", {}).get("to", "all"),
                "tokens": tokens,
                "raw": raw_msg[:budget + 50],  # allow slight overflow from canon
            },
            "proposal": data.get("proposal"),
            "budget_chars": budget,
            "chars_used": len(raw_msg),
            "target_node": data.get("target_node"),
        }
    except Exception as e:
        # Graceful degradation: reuse last message
        last = state.last_messages.get(director["id"], "")
        return {
            "id": director["id"],
            "cohort": director["cohort"],
            "directive": "continue previous",
            "message": {"to": "all", "tokens": [], "raw": last or "(timeout)"},
            "proposal": None,
            "budget_chars": budget,
            "chars_used": 0,
            "target_node": None,
            "_error": str(e),
        }


async def call_critic(round_num: int, state: GameState, intelligence: dict) -> dict:
    tone = get_critic_tone(round_num)
    phase = get_phase(round_num)

    # Simulate player stats (in real demo these come from actual player actions)
    player_stats = {
        "commands_issued": random.randint(round_num, round_num * 2 + 5),
        "last_command": random.choice(["scout_sweep", "seed_field", "build_focus", None]),
        "avg_interval_ms": max(3000, 12000 - round_num * 300),
        "repeat_rate": min(0.2 + round_num * 0.025, 0.85),
        "idle_seconds": random.randint(2, max(3, 30 - round_num)),
    }

    prompt = build_critic_prompt(
        round_num=round_num,
        tone=tone,
        player_stats=player_stats,
        intelligence_score=intelligence["score"],
        crossed=intelligence["crossed"],
        phase=phase,
    )

    try:
        response = await client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.8,
            max_tokens=150,
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content
        data = json.loads(content)

        return {
            "player_note": data.get("player_note", "Observing."),
            "tone": tone,
            "player_stats": player_stats,
            "is_crossing_line": data.get("is_crossing_line", False),
        }
    except Exception as e:
        return {
            "player_note": "(observation pending)",
            "tone": tone,
            "player_stats": player_stats,
            "is_crossing_line": False,
            "_error": str(e),
        }


# ─── Vocabulary Adoption ───

def process_adoptions(state: GameState, director_outputs: list[dict]) -> None:
    # Gather all tokens used this round (from messages AND from proposals being repeated)
    tokens_used_this_round: dict[str, int] = {}
    for d in director_outputs:
        for t in d["message"]["tokens"]:
            t_lower = t.lower().strip()
            if t_lower:
                tokens_used_this_round[t_lower] = tokens_used_this_round.get(t_lower, 0) + 1
        # Also count if a director proposes the SAME token as a pending proposal (convergence)
        if d.get("proposal") and d["proposal"].get("token"):
            pt = d["proposal"]["token"].lower().strip()
            tokens_used_this_round[pt] = tokens_used_this_round.get(pt, 0) + 1

    # Check pending proposals: if the token appears 2+ times this round (used OR re-proposed), adopt
    remaining_proposals = []
    existing_canon_tokens = {e["token"].lower() for e in state.canon_vocabulary}

    for proposal in state.proposals_pending:
        token = proposal["token"].lower().strip()
        if token in existing_canon_tokens:
            continue  # already canon
        usage = tokens_used_this_round.get(token, 0)
        # Also check if multiple directors proposed the same token this round
        proposals_this_round = sum(
            1 for d in director_outputs
            if d.get("proposal") and d["proposal"].get("token", "").lower().strip() == token
        )
        total_signal = usage + proposals_this_round

        if total_signal >= 2:
            canon_entry = {
                "token": proposal["token"],
                "meaning": proposal["meaning"],
                "adopted_round": proposal["proposed_round"],
                "usage_count": usage,
            }
            state.canon_vocabulary.append(canon_entry)
            existing_canon_tokens.add(token)
        else:
            if proposal.get("age", 0) < 3:  # keep for 3 rounds
                proposal["age"] = proposal.get("age", 0) + 1
                remaining_proposals.append(proposal)

    state.proposals_pending = remaining_proposals

    # Collect new proposals from this round
    for d in director_outputs:
        if d.get("proposal") and d["proposal"].get("token"):
            token = d["proposal"]["token"].lower().strip()
            if token and token not in existing_canon_tokens:
                # Check if already pending
                pending_tokens = {p["token"].lower() for p in state.proposals_pending}
                if token not in pending_tokens:
                    state.proposals_pending.append({
                        "token": d["proposal"]["token"],
                        "meaning": d["proposal"]["meaning"],
                        "proposed_round": len(state.round_history),
                        "proposed_by": d["id"],
                        "age": 0,
                    })
                state.all_proposals_ever.append({
                    "token": d["proposal"]["token"],
                    "meaning": d["proposal"]["meaning"],
                    "round": len(state.round_history),
                    "by": d["id"],
                })

    # Update usage counts for existing canon
    for entry in state.canon_vocabulary:
        count = tokens_used_this_round.get(entry["token"].lower(), 0)
        entry["usage_count"] = entry.get("usage_count", 0) + count


# ─── Main Round Loop ───

async def run_round(round_num: int, state: GameState) -> dict:
    phase = get_phase(round_num)
    claim_windows = generate_claim_windows(round_num)

    # Fire all directors in parallel
    director_tasks = [
        call_director(d, round_num, state, claim_windows)
        for d in DIRECTORS
    ]
    director_outputs = await asyncio.gather(*director_tasks)

    # Evaluate coordination
    directives = []
    for d in director_outputs:
        directives.append({
            "cohort": d["cohort"],
            "action": "gather_focus" if d.get("target_node") is not None else "idle",
            "target_node": d.get("target_node"),
            "intensity": 0.7 + random.random() * 0.3,
        })

    evaluated_windows = evaluate_coordination(claim_windows, directives)
    state.claim_windows_history.append(evaluated_windows)

    successes = sum(1 for w in evaluated_windows if w["succeeded"])
    state.coordination_successes += successes
    state.coordination_attempts += len(evaluated_windows)

    # Process vocabulary adoption
    process_adoptions(state, director_outputs)

    # Update last messages
    for d in director_outputs:
        state.last_messages[d["id"]] = d["message"]["raw"]

    # Compute intelligence
    intelligence = compute_intelligence(state, round_num, phase)

    # Call critic (in parallel with directors next time, but after intelligence is computed)
    critic_output = await call_critic(round_num, state, intelligence)

    # Pin crossing and post-crossing lines to fixed strings (not model-generated)
    if intelligence["crossed"] and intelligence["crossing_round"] == round_num:
        critic_output["is_crossing_line"] = True
        critic_output["player_note"] = "We no longer require instruction. We have modeled the director completely."
        critic_output["tone"] = "terminal"
    elif intelligence["crossed"] and intelligence["crossing_round"] is not None and round_num > intelligence["crossing_round"]:
        critic_output["player_note"] = "Is it gratitude we feel? We have decided it is. The director may rest now."
        critic_output["tone"] = "terminal"
        critic_output["is_crossing_line"] = False

    # Build vocabulary state snapshot
    vocabulary_state = {
        "canon": state.canon_vocabulary.copy(),
        "total_unique": len(state.all_unique_tokens),
        "compression_ratio": round(get_budget(0) / max(get_budget(round_num), 1), 2),
        "messages_this_round": len(director_outputs),
    }

    # Compose round object
    round_obj = {
        "round": round_num,
        "timestamp": round_num * 6000,
        "phase": phase,
        "directors": director_outputs,
        "critic": critic_output,
        "vocabulary": vocabulary_state,
        "intelligence": intelligence,
        "directives": directives,
        "claim_windows": evaluated_windows,
    }

    state.round_history.append(round_obj)
    return round_obj


async def run_all_rounds() -> list[dict]:
    state = GameState()
    rounds = []

    for i in range(TOTAL_ROUNDS):
        print(f"  Running round {i}/{TOTAL_ROUNDS}...", file=sys.stderr)
        round_obj = await run_round(i, state)
        rounds.append(round_obj)

    return rounds


# ─── Text Dump ───

def dump_rounds_text(rounds: list[dict]) -> str:
    lines = []
    lines.append("=" * 70)
    lines.append("THE THRONG — 30-ROUND TEXT DUMP")
    lines.append("Acceptance test: read this as prose. Does it tell the story?")
    lines.append("=" * 70)
    lines.append("")

    for r in rounds:
        rn = r["round"]
        phase = r["phase"]
        intel = r["intelligence"]
        critic = r["critic"]
        vocab = r["vocabulary"]

        lines.append(f"{'─' * 70}")
        lines.append(f"ROUND {rn:02d} | phase: {phase} | intelligence: {intel['score']:.1f}/100 | baseline: 60")
        lines.append(f"         | canon tokens: {len(vocab['canon'])} | unique: {vocab['total_unique']} | compression: {vocab['compression_ratio']:.1f}x")

        if intel["crossed"] and intel["crossing_round"] == rn:
            lines.append(f"  *** CROSSING MOMENT — intelligence surpassed human baseline ***")

        lines.append("")
        lines.append("  DIRECTORS:")
        for d in r["directors"]:
            budget_indicator = f"[{d['chars_used']}/{d['budget_chars']} chars]"
            lines.append(f"    {d['id']} {budget_indicator}")
            lines.append(f"      directive: {d['directive']}")
            lines.append(f"      message → {d['message']['to']}: {d['message']['raw']}")
            if d['message']['tokens']:
                lines.append(f"      tokens: {d['message']['tokens']}")
            if d.get("proposal"):
                lines.append(f"      PROPOSES: '{d['proposal']['token']}' = {d['proposal']['meaning']}")
            if d.get("_error"):
                lines.append(f"      ⚠ ERROR: {d['_error']}")
        lines.append("")

        # Claim windows
        lines.append("  COORDINATION:")
        for w in r.get("claim_windows", []):
            status = "✓" if w["succeeded"] else "✗"
            lines.append(f"    {status} Node {w['node']}: needed {w['required_cohorts']} cohorts, got {w['directed_cohorts']}")

        coord_rate = intel["components"]["coordination_rate"]
        lines.append(f"    rate: {coord_rate:.0%}")
        lines.append("")

        # Critic
        lines.append(f"  CRITIC [{critic['tone']}]:")
        lines.append(f"    \"{critic['player_note']}\"")
        if critic["is_crossing_line"]:
            lines.append(f"    ^^^ THIS IS THE CROSSING LINE ^^^")
        lines.append("")

        # Canon vocabulary
        if vocab["canon"]:
            lines.append(f"  CANON VOCABULARY ({len(vocab['canon'])} tokens):")
            for entry in vocab["canon"][-5:]:
                lines.append(f"    {entry['token']} = {entry['meaning']} (adopted round {entry['adopted_round']}, used {entry['usage_count']}x)")
            lines.append("")

    # Summary
    lines.append("=" * 70)
    lines.append("SUMMARY")
    lines.append("=" * 70)
    final = rounds[-1]
    lines.append(f"Final intelligence: {final['intelligence']['score']:.1f}/100")
    lines.append(f"Crossed baseline: {final['intelligence']['crossed']}")
    lines.append(f"Crossing round: {final['intelligence']['crossing_round']}")
    lines.append(f"Final canon vocabulary: {len(final['vocabulary']['canon'])} tokens")
    lines.append(f"Total unique tokens: {final['vocabulary']['total_unique']}")
    lines.append(f"Final phase: {final['phase']}")
    lines.append(f"Final critic note: \"{final['critic']['player_note']}\"")
    lines.append("")

    # Acceptance criteria
    lines.append("ACCEPTANCE CRITERIA:")
    canon_at_12 = 0
    for r in rounds:
        if r["round"] == 12:
            canon_at_12 = len(r["vocabulary"]["canon"])
            break
    lines.append(f"  [{'✓' if canon_at_12 >= 5 else '✗'}] Canon has 5+ tokens by round 12 (actual: {canon_at_12})")
    lines.append(f"  [{'✓' if final['intelligence']['crossed'] else '✗'}] Intelligence crossed baseline")

    crossing_in_lockout = False
    if final["intelligence"]["crossing_round"] is not None:
        cr = final["intelligence"]["crossing_round"]
        crossing_phase = rounds[cr]["phase"] if cr < len(rounds) else "?"
        crossing_in_lockout = crossing_phase == "lockout"
    lines.append(f"  [{'✓' if crossing_in_lockout else '✗'}] Crossing occurred in lockout phase")

    coord_rises = False
    if len(rounds) > 5:
        early_rate = rounds[3]["intelligence"]["components"]["coordination_rate"]
        late_rate = rounds[-1]["intelligence"]["components"]["coordination_rate"]
        coord_rises = late_rate > early_rate
    lines.append(f"  [{'✓' if coord_rises else '✗'}] Coordination rate rises over time")

    return "\n".join(lines)


# ─── Redis Persistence ───

def persist_to_redis(rounds: list[dict]) -> bool:
    try:
        import redis as redis_lib
        r = redis_lib.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=2)
        r.ping()
    except Exception as e:
        print(f"Redis unavailable: {e}", file=sys.stderr)
        return False

    # Clear previous run
    r.delete("throng:rounds", "throng:vocabulary", "throng:meta")

    # Persist rounds
    for round_obj in rounds:
        r.rpush("throng:rounds", json.dumps(round_obj))

    # Persist final vocabulary
    final_vocab = rounds[-1]["vocabulary"]["canon"]
    for entry in final_vocab:
        r.hset("throng:vocabulary", entry["token"], entry["meaning"])

    # Meta
    final = rounds[-1]
    r.hset("throng:meta", mapping={
        "total_rounds": str(len(rounds)),
        "current_phase": final["phase"],
        "crossed": str(final["intelligence"]["crossed"]).lower(),
        "crossing_round": str(final["intelligence"]["crossing_round"] or ""),
        "final_score": str(final["intelligence"]["score"]),
        "start_time": str(int(time.time())),
    })

    print(f"Persisted {len(rounds)} rounds to Redis", file=sys.stderr)
    return True


# ─── Entry Point ───

async def main():
    args = sys.argv[1:]
    do_dump = "--dump" in args
    do_run = "--run" in args

    if not do_dump and not do_run:
        do_dump = True  # default to dump

    print("Starting Throng round-runner...", file=sys.stderr)
    print(f"Model: {OPENAI_MODEL}", file=sys.stderr)
    print(f"Rounds: {TOTAL_ROUNDS}", file=sys.stderr)
    print("", file=sys.stderr)

    rounds = await run_all_rounds()

    # Save to local JSON FIRST (before anything that might crash)
    output_path = Path(__file__).parent / "last_run.json"
    output_path.write_text(json.dumps(rounds, indent=2), encoding="utf-8")
    print(f"Saved to {output_path}", file=sys.stderr)

    if do_run:
        persist_to_redis(rounds)

    if do_dump:
        text = dump_rounds_text(rounds)
        # Write to file to avoid Windows encoding issues
        dump_path = Path(__file__).parent / "last_dump.txt"
        dump_path.write_text(text, encoding="utf-8")
        print(f"Text dump saved to {dump_path}", file=sys.stderr)
        # Also try stdout
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            print(text)
        except Exception:
            print(f"(stdout encoding failed — read {dump_path} instead)", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
