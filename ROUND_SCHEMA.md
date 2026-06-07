# Round Object Schema

The atomic unit of The Throng's runtime. The backend produces an array of these. Redis stores them. The frontend renders them deterministically. Everything builds against this contract.

---

## `ThrongRound`

```typescript
type ThrongRound = {
  round: number;              // 0-indexed, 0–29 for a 3-minute demo
  timestamp: number;          // ms since simulation start (round * 6000)
  phase: "babble" | "structure" | "protocol" | "lockout";

  // ─── Agent Outputs ───
  directors: DirectorOutput[];  // length 5 (or however many are spawned so far)
  critic: CriticOutput;

  // ─── Vocabulary State ───
  vocabulary: VocabularyState;

  // ─── Intelligence ───
  intelligence: IntelligenceState;

  // ─── Game Effects ───
  directives: Directive[];      // what creatures should do this round
};
```

---

## `DirectorOutput`

One per director agent per round. This is the raw structured output from gpt-4o-mini.

```typescript
type DirectorOutput = {
  id: string;                   // "dir_scout", "dir_gather", "dir_builder", "dir_coord", "dir_memory"
  cohort: Cohort;

  // What they told their cohort to do
  directive: string;            // e.g. "focus node 3, avoid tower until clear"

  // Inter-director message (THE glyph protocol — what viewers see)
  message: {
    to: string | "all";         // target director id or broadcast
    tokens: string[];           // the actual vocabulary tokens used
    raw: string;                // full message text (early: readable, late: compressed)
  };

  // Vocabulary proposal (optional — only if agent invents new shorthand)
  proposal: {
    token: string;              // the new shorthand, e.g. "t3"
    meaning: string;            // what it compresses, e.g. "resource available at node 3"
    adopted: boolean;           // set by orchestrator AFTER checking if 2+ directors use it next round
  } | null;

  // Character budget this round (the compression bottleneck)
  budget_chars: number;         // starts at 120, shrinks to 20 by round 25
  chars_used: number;
};
```

---

## `CriticOutput`

The agent that studies the player. One per round.

```typescript
type CriticOutput = {
  // Observation about the player — escalates over time
  player_note: string;

  // Tone phase for the UI to style differently
  tone: "clinical" | "interpretive" | "unsettling" | "terminal";

  // Raw player stats this round was based on
  player_stats: {
    commands_issued: number;        // total so far
    last_command: string | null;    // most recent command type
    avg_interval_ms: number;       // average time between commands
    repeat_rate: number;           // 0–1, how often they repeat the same command
    idle_seconds: number;          // time since last command
  };

  // The final line (only on crossing round or after)
  is_crossing_line: boolean;
};
```

---

## `VocabularyState`

Snapshot of the shared protocol at this round.

```typescript
type VocabularyState = {
  // Canon tokens — adopted by 2+ directors
  canon: Array<{
    token: string;              // e.g. "t3", "tw", "t3→tw"
    meaning: string;            // e.g. "resource at node 3 → tower"
    adopted_round: number;      // when it entered canon
    usage_count: number;        // how many times used since adoption
  }>;

  // Total unique tokens ever emitted (including non-canon)
  total_unique: number;

  // Compression ratio: (meaning_chars / token_chars) — how compressed the language is
  compression_ratio: number;

  // Messages per round (density indicator)
  messages_this_round: number;
};
```

---

## `IntelligenceState`

The number that drives the curve and the crossing moment.

**Crossing is gated behind lockout phase.** `crossed` can only become true when `phase === "lockout"` AND `score >= baseline`. This guarantees the narrative beats stack: language goes opaque FIRST, then the Throng announces it no longer needs you.

```typescript
type IntelligenceState = {
  score: number;                // 0–100, derived: sum(components[k] * weight[k])
  baseline: 60;                 // fixed constant, never moves
  crossed: boolean;             // true only if score >= baseline AND phase === "lockout"
  crossing_round: number | null; // the round it first crossed (null if not yet)

  // Components (all 0–1, weighted into score)
  // Weights: coordination_rate=30, vocabulary_adoption=25, message_efficiency=25, compression=20
  components: {
    coordination_rate: number;  // successful_claims / total_attempts (rolling 5-round window)
    vocabulary_adoption: number; // canon_tokens / total_unique (convergence measure)
    message_efficiency: number; // delta(coordination_rate) correlated with message volume
    compression: number;        // 1 - (avg_chars_used / budget_chars_round_0)
  };

  // Delta from last round (for the curve's slope)
  delta: number;
};
```

---

## `ClaimWindow`

The real coordination mechanic. Resource nodes spawn "claim windows" — time-bounded opportunities that require creatures from 2+ directed cohorts at the same node. Success or failure is binary: either enough cohorts arrive in time, or they don't.

**Definition of successful coordination**: a claim window where 2+ cohorts were directed to the target node by their respective directors within the same round.

```typescript
type ClaimWindow = {
  node: number;                 // PATH_NODE index (0–7)
  required_cohorts: number;     // how many distinct cohorts needed (2–3)
  succeeded: boolean;           // did enough cohorts get directed here?
  directed_cohorts: Cohort[];   // which cohorts actually showed up
};
```

Each round spawns 2–4 claim windows. `coordination_rate` = succeeded / total across a rolling 5-round window. This is the ground truth that makes the intelligence curve real.

---

## `Directive`

What the frontend tells the Phaser scene to do. Derived from director outputs.

```typescript
type Directive = {
  cohort: Cohort;
  action: "scout_sweep" | "gather_focus" | "build_focus" | "cluster" | "scatter" | "idle";
  target_node?: number;         // PATH_NODE index if relevant
  intensity: number;            // 0–1, how aggressively to execute
};
```

---

## Compression Bottleneck Schedule

The staged arc that guarantees visual progression:

| Rounds | Phase | `budget_chars` | What viewer sees |
|--------|-------|----------------|-----------------|
| 0–4 | babble | 120 | Full sentences: "send scouts to node 3, resource available" |
| 5–9 | structure | 80 | Shorthand forming: "scouts→n3, res avail" |
| 10–14 | structure | 50 | Adoption visible: "s→3, res" (shared tokens) |
| 15–19 | protocol | 35 | Compounds: "t3→tw" "x-cl" |
| 20–24 | protocol | 25 | Opaque: "t3tw xcl m7" |
| 25–29 | lockout | 15 | Alien: "⊢3w xm" — you're locked out |

The agents genuinely produce these under the budget constraint. The constraint is what forces compression. The compression IS the language emergence.

**Canon tokens are FREE against budget. Novelty costs full chars.** Directors see the current canon vocabulary in their prompt. Using a canon token costs 0 characters against their budget. Inventing a new abbreviation costs its full character length. This creates convergence pressure: reuse is rewarded, divergence is taxed. Five private shorthands → one shared language.

**Acceptance test (check in text dump):** By round 12, `canon` should contain 5+ tokens and directors' messages should visibly draw from them. If canon is empty at round 12, the convergence pressure needs tuning before touching the frontend.

---

## Round Lifecycle

```
1. Orchestrator collects: game metrics, player actions since last round, last round's messages
2. Orchestrator builds prompts for each director (include budget_chars, vocabulary canon, other directors' last messages)
3. Fire 5 director calls + 1 critic call IN PARALLEL (not sequential)
4. Collect responses, validate against budget
5. Check proposals: if token was proposed last round AND used by 2+ this round → adopted into canon
6. Compute intelligence components from game state + round data
7. Compose ThrongRound object
8. Persist to Redis: RPUSH throng:rounds <JSON>
9. Emit to frontend via SSE or poll
```

---

## Redis Keys

```
throng:rounds          — LIST of JSON ThrongRound objects (the full run)
throng:vocabulary      — HASH of canon token → meaning
throng:player_actions  — LIST of timestamped player commands
throng:meta            — HASH: total_rounds, current_phase, crossed (bool), start_time
```

---

## Pre-run vs Live

**Before demo**: run all 30 rounds against live GPT-4o-mini. Persist to Redis. Verify the arc looks good. If not, re-run (different seed = different run, same structure).

**On stage**: frontend replays from Redis at 6s/round. The "live" badge is earned — you ran it live, you just ran it 5 minutes ago, not on stage with flaky WiFi.

**If you want to flex**: run it live AND have the cached version as fallback. Frontend checks Redis for pre-cached rounds; if empty, falls back to live polling.

---

## The Crossing Round

When `intelligence.score >= intelligence.baseline` for the first time:
- `intelligence.crossed = true`
- `intelligence.crossing_round = round`
- `critic.is_crossing_line = true`
- `critic.player_note` = the terminal line (e.g. "We no longer require instruction. We have modeled the director completely.")
- Frontend fires the visual event: screen dim, label change "human baseline" → "you"

The round AFTER crossing:
- `critic.tone = "terminal"`
- `critic.player_note` = the ambiguous closer: "Is it gratitude we feel? We have decided it is. The director may rest now."
