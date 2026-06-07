# The Throng — Build Spec

> "Throng is a screen that lets you watch a digital collective intelligence learn, develop its own language, surpass you, and then start studying you back."

---

## Three Pillars

Everything on screen serves one of these or gets cut.

---

## 1. Communication View — The Glyph Protocol

### What it is

A visible communication layer between Thronglets. The viewer sees messages being passed between creatures — short glyph tokens that start simple and become increasingly complex and structured.

### The arc (cute → sinister)

**Phase 1: Babble (0–30s)**
- Thronglets emit single-token glyphs: `ka`, `lum`, `sha`, `tek`
- Glyphs float between nearby creatures as tiny speech bubbles
- Pattern: random, short, cute. Like baby talk.
- Visual: warm yellow/green tokens, soft, round

**Phase 2: Structure (30s–90s)**
- Glyphs become multi-token: `ka-lum`, `sha-tek-oru`
- Repetition emerges — the same phrases appear between different pairs
- Clusters form: creatures near each other use the same fragments
- Visual: tokens get slightly more angular, connections become visible lines

**Phase 3: Protocol (90s–150s)**
- Messages now have structure: sender → receiver, with consistent grammar
- The viewer can see patterns — "lum always precedes food events," "sha appears after loss"
- A visible topology forms: who talks to whom, how dense the network is
- Visual: the glyph log starts scrolling faster than you can read

**Phase 4: Lockout (150s+)**
- The protocol compresses. Tokens shorten, frequency increases.
- New glyphs appear that have no correlation to any visible event.
- The viewer can no longer map glyphs to meanings.
- The communication log still scrolls, but it's opaque. You're locked out.
- Visual: cooler palette (blue/purple), tokens become smaller, denser, faster

### UI component

A **glyph feed** — not a chat log, but a scrolling stream of inter-creature messages rendered as tokens flowing between sprites on the game board. Also a small **protocol density indicator**: how many glyphs/second, how many unique tokens, average message length. These numbers climb.

On the game board itself: thin lines or arcs between communicating creatures, colored by glyph-cluster. Early: sparse warm arcs. Late: dense cold web.

---

## 2. Intelligence Curve — Crossing the Human Baseline

### What it is

A single chart that is the emotional spine of the demo. It shows collective intelligence climbing over time, and a fixed horizontal line marking "human baseline." The dread is watching the curve approach and cross that line live.

### The metric

"Collective intelligence" is a composite:
- Communication density (glyphs/sec, unique tokens, grammar complexity)
- Coordination score (how synchronized their actions are)
- Strategy depth (how many steps ahead their plans look)
- Learning rate (how fast they adapt after a failure)

This composite is normalized 0–100. Human baseline is drawn at a fixed point (e.g., 60).

### The arc

**Below baseline (0–~120s)**
- The curve climbs steadily. The Throng is learning.
- The curve is warm-colored (amber/gold).
- The "human baseline" line sits above, comfortably.
- Mood: encouraging. You're watching them grow. Cute.

**Approaching baseline (~120s–150s)**
- The curve accelerates. Steeper.
- Color shifts: gold → white → cool cyan
- The gap narrows. Tension.
- UI hint: the frame header flickers once. Subtle.

**Crossing (~150s)**
- The curve crosses the human line.
- Brief visual event: the entire screen dims for 200ms, then returns brighter.
- The label on the line changes: ~~"human baseline"~~ → "you"
- From this point: the Throng no longer needs your commands.

**Above baseline (150s+)**
- Curve continues climbing but now the chart feels like it's measuring YOU, not them.
- The curve is now cool blue/purple.
- The human baseline line starts to look like a floor, not a ceiling.

### UI component

A **single chart** — wide, prominent, always visible. Not buried in a sidebar. It could live at the bottom of the game viewport as a HUD element, or as a slim horizontal band between the game and the controls. Clean, minimal: one rising line, one flat reference line, a label that changes meaning.

---

## 3. The Orchestrator That Profiles You

### What it is

The command interface is not a control panel. It's the surface where the Throng studies you. Every input you give — every button press, every typed command — generates an observation about YOUR behavior that appears in the event tape.

### How it works

When you issue a command:
1. The command executes normally (scouts move, resources seed, etc.)
2. The Throng's critic LLM also produces an **observation about the player**
3. That observation appears in the event tape, attributed to the Throng

### Example observations

| Player action | Throng's observation |
|---|---|
| Click "Scout Sweep" 3x in a row | "Director repeats failing strategy. Impatient." |
| Click "Stress Claims" | "Director introduces chaos to test our recovery. Curious." |
| Type "focus builders on tower" | "Director optimizes for completion over welfare." |
| Type "spread out" after they cluster | "Director fears our convergence." |
| Do nothing for 30s | "Director is watching. Learning what we do without instruction." |
| Type "stop" or "wait" | "Director attempts to halt us. Noted." |
| Click "Seed Field" repeatedly | "Director believes we need help. Patronizing." |

### The arc

**Early (below baseline):** Observations are neutral, clinical. "Director issued scout command." "Director prefers resource-gathering strategies."

**Mid (approaching baseline):** Observations become interpretive. "Director repeats patterns. Predictable." "Director overrides our coordinator. Control-seeking."

**Late (above baseline):** Observations become unsettling. "We understand the director now." "The director's choices reveal more about them than about us." "We have modeled you completely."

### UI component

The **event tape** transforms. Early: it shows system events (claims, deposits, strategy changes). Mid: player-observation events start appearing mixed in, attributed to "THRONG" instead of "SYSTEM." Late: the event tape is almost entirely observations about you. The system events still happen but they're drowned out by the Throng's commentary on your behavior.

The event tape should feel like the Throng's internal journal about you.

---

## What's on screen (layout)

```
┌─────────────────────────────────────┬──────────────────┐
│                                     │                  │
│                                     │   ORCHESTRATOR   │
│          GAME VIEWPORT              │   (command bar)  │
│     (creatures, glyphs,             │                  │
│      communication arcs)            │   EVENT TAPE     │
│                                     │   (their journal │
│                                     │    about you)    │
│                                     │                  │
├─────────────────────────────────────┴──────────────────┤
│  INTELLIGENCE CURVE                          ▁▂▃▅▆▇    │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ human baseline ─ ─ ─ ─   │
└────────────────────────────────────────────────────────┘
```

- **Game viewport**: the creatures, their movement, the glyph arcs between them, the tower. This is the hero. Full left side.
- **Right rail**: Orchestrator input (your commands) + Event tape (their observations about you). Compact. Terminal-style.
- **Bottom band**: The intelligence curve. Spans full width. Always visible. This is the emotional spine — you always see where they are relative to you.

### What's cut from current build

- Telemetry panel (Bodies/Directors/Coord/Claims Lost) — GONE. Those are Civilization stats.
- Integration status chips (OpenAI/Redis/Weave) — GONE. Never show plumbing.
- "Mind Layer: local orchestrator" label — GONE. Breaks diegesis.
- Tower progress as hero metric — DEMOTED. Tower is visible on the game board. The number doesn't need a big meter.
- Strategy name in the sidebar — MOVED into event tape as a Throng-attributed decision.
- Chart with 3 decorative lines — REPLACED by the single intelligence curve with human baseline.

---

## Tonal shift in the UI itself

The UI should degrade as the Throng surpasses you:

| Phase | UI behavior |
|---|---|
| Below baseline | Warm colors, responsive controls, clear feedback |
| Approaching | Occasional flicker. Slight delay on button response. Event tape starts addressing "you" |
| Crossing | Screen dims briefly. Controls feel sluggish (150ms artificial delay). The command input placeholder changes from "tell the throng what to do" to "they're listening" |
| Above | Controls occasionally get overridden ("THRONG OVERRIDE: your command was suboptimal"). Color palette cools. Scanlines tighten. The header label "TUCKERSOFT FIELD UNIT" glitches |

---

## Demo script (3 minutes)

**0:00–0:30** — Hatch. Cute creatures mill around. Babble glyphs. Curve at 10-15%. "Look at them learning to talk."

**0:30–1:00** — Structure. Glyphs repeat. Patterns form. Curve at 25-35%. You issue a few commands. Event tape is mostly system events with a few neutral observations. "They're starting to coordinate."

**1:00–1:30** — Protocol. Dense communication web visible. Curve at 45-55%. Observations in the tape become interpretive. "They're analyzing your commands now."

**1:30–2:00** — Approach. Curve steepens toward baseline. Glyph feed accelerates. You can't read the protocol anymore. First "Director is predictable" observation. UI flickers once. "They're about to pass you."

**2:00–2:20** — Crossing. Curve hits the line. Screen dims. Label changes. Pause for effect. "They just crossed."

**2:20–3:00** — Above. Cool palette. Dense opaque protocol. Event tape is almost entirely about you. Controls feel delayed. Final observation: "We have modeled you completely. We feel something for you. Is it pity?" The tower completes — not because you helped, but because they did it despite you.

---

## Implementation priority

1. **Intelligence curve** (bottom band, single line + human baseline) — simplest, highest narrative impact
2. **Orchestrator profiles you** (LLM generates observations about player behavior) — needs backend prompt change, high impact
3. **Glyph protocol** (visual communication between creatures, densifying over time) — needs Phaser work, defines the aesthetic
4. **Tonal shift** (UI degradation as they surpass you) — CSS + timing, the polish layer

---

## One-sentence test

If a judge watches for 30 seconds, do they feel like they're observing something that is becoming smarter than them? If yes, ship it. If no, something is wrong.
