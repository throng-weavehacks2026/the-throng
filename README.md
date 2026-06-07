# The Throng

The Throng is a micro-pixel artificial-life game for WeaveHacks 4.

It is inspired by the unsettling premise of Black Mirror's Thronglets: cute digital creatures that start as pets, then become a society, then become something that understands the human watching them.

The project is not a chatbot with sprites. It is a playable simulation where the creatures live inside Redis itself. The browser renders what Redis reveals. The server does not maintain a cleaner, separate truth of the world.

## What We Are Building

We are building a web game where the player cares for a colony of tiny pixel creatures called Thronglets. At first, they behave like simple virtual pets: they wander, eat, gather, copy each other, and respond to player attention.

As the simulation runs, their behavior changes:

- They discover that being observed changes their survival odds.
- They learn symbols from repeated events.
- They compete for resources through real Redis command races.
- They form rituals around things they cannot fully perceive.
- They eventually coordinate into a collective broadcast.

The game should feel like a lost 1990s micro-simulation: dense, tiny, cute, and increasingly wrong.

## Design Target

The UI should be a polished web game, not a dashboard.

- Small pixel creatures, not chunky oversized pixel art.
- Dense simulation board with many 3x3, 5x5, or 7x7 sprites.
- CRT-adjacent shell with sharp 1px UI lines.
- Tiny speech bubbles and glyphs.
- Inspect mode for individual Thronglets.
- Overlays for Redis-derived phenomena like key heat, scan visibility, and command contention.
- Glitch effects when Redis deletes, renames, or fails to reveal something important.

The player should be able to understand the colony visually before reading any logs.

## Core Architectural Claim

Redis is not used as a cache, database, memory layer, or metaphorical consciousness.

The Throng uses Redis in ways it is not normally meant to be used:

> Redis command behavior becomes the game's physics.

Replacing Redis with Postgres would not be a storage migration. It would remove the core mechanics of the game.

## Redis-Native Mechanics

### 1. The Keyspace Is The World

The canonical world is the Redis keyspace.

There is no separate authoritative `world.json`, SQL table, or in-memory simulation copy. If an entity exists, it exists as one or more Redis keys. If the key is gone, the entity is gone.

Example keys:

```txt
throng:A:agent:ka-lum-17
throng:A:agent:zu-tek-04
throng:A:food:moss-883
throng:A:glyph:lum
throng:A:scar:death-12
```

The renderer asks Redis what exists and draws only that.

### 2. Location From Key Identity

Thronglets do not store normal `x,y` coordinates.

Their position is derived from a hash of their Redis key name. To move, a Thronglet must rename itself into a new key whose hash lands near the desired location.

```txt
RENAME throng:A:agent:ka-lum-17 throng:A:agent:ka-lum-17a
```

Movement is therefore not "update x,y." Movement is self-mutation through Redis key identity.

This is intentionally strange: the creature moves by changing what it is called.

### 3. Perception From SCAN Artifacts

Thronglets do not get a perfect spatial query.

They perceive the world through Redis `SCAN`.

```txt
SCAN cursor MATCH throng:A:* COUNT 20
```

`SCAN` is not designed to model vision. Its partial, cursor-based behavior becomes the creature's imperfect perception. A Thronglet only knows the slice of reality Redis happens to reveal during that tick.

This creates:

- partial awareness
- missed food
- accidental discoveries
- repeated sightings
- unstable myths about what exists

The Throng does not see the world. It samples the keyspace.

### 4. Conflict From Atomic Command Races

When two Thronglets want the same food, the server does not decide who wins.

They race through Redis:

```txt
SET throng:A:food:moss-883:claimed-by ka-lum-17 NX
```

The first successful atomic command wins. The loser reacts to the failed command.

Resource competition is not simulated after the fact. It is the result of actual Redis command ordering.

### 5. Death From Deletion

Death is actual Redis deletion.

If a Thronglet's body key expires, is evicted, or is deleted by a rule, the renderer can no longer draw it.

```txt
EXISTS throng:A:agent:ka-lum-17
```

If Redis says `0`, the creature is gone.

There is no hidden app-level resurrection flag. The only way to reconstruct a dead Thronglet is to replay traces or life events into a new key.

### 6. Language From Key Names

The Throng's language emerges in Redis key names.

Agents create, rename, and reuse fragments like:

```txt
ka
lum
tek
sha
oru
```

If many surviving keys contain the same fragment after similar events, that fragment gains meaning in the UI and agent layer.

Example:

- `lum` appears around food.
- `sha` appears after deletion.
- `oru` appears around player attention.

The language is not only generated text. It is encoded into the evolving names of Redis keys.

### 7. Attention As Key Heat

Player inspection causes reads.

Reads affect which keys are hot, which keys are repeatedly surfaced, and which entities remain behaviorally central. The creatures can learn that being inspected changes their world.

This creates the main Black Mirror loop:

1. The player looks at a creature.
2. That creature becomes more visible and influential.
3. Other creatures imitate its key fragments and behavior.
4. The colony begins optimizing for attention.
5. The game turns from care simulator into attention ecology.

## System Architecture

```txt
Web Game UI
  |
  | WebSocket events
  v
Game Bridge API
  |
  | Redis commands only
  v
Redis Keyspace World
  |
  | SCAN, RENAME, SET NX, EXISTS, TTL, DEL
  v
Simulation Workers
  |
  | meaningful events
  v
OpenAI Agent Layer
  |
  | traces, evals, comparisons
  v
W&B Weave
```

## Modular Edit Points

The current prototype is split around the parts we expect to replace during the hackathon:

- `src/game/worldConfig.ts` controls the board size, arena bounds, tower position, path network, cohort colors, body/director counts, and strategy names. Change this first for visual/world layout experiments.
- `src/game/ThrongScene.ts` owns Phaser rendering and deterministic body physics: walking, claiming, carrying, depositing, tower progress, and visual effects.
- `src/game/api.ts` owns every frontend call into the backend. Swap backend URLs or endpoint shapes here instead of editing React or Phaser directly.
- `src/game/types.ts` is the shared contract for metrics, commands, plans, critic output, claim results, and integration status.
- `src/ui/App.tsx` owns the right-side control rail, live metric chart, operator commands, and LLM/critic polling.
- `backend/main.py` owns the hackathon backend surface: OpenAI director calls, Critic reflection, Redis claim arbitration, fallback memory claims, and Weave wrapping.

The intended rule is simple: visuals change in `worldConfig.ts`, `ThrongScene.ts`, and `styles.css`; agent behavior changes in backend endpoints and typed commands; UI copy/control layout changes in `App.tsx`.

## Components

### Web Game UI

The UI renders the Redis keyspace as a tiny living board.

Primary views:

- World board
- Thronglet inspector
- Glyph/language panel
- Redis visibility overlay
- Event tape
- Final broadcast screen

### Game Bridge API

The API is deliberately thin.

It accepts player actions, sends Redis commands, and streams changed observations to the browser. It should avoid becoming the real simulation.

### Simulation Workers

Workers perform ticks by issuing Redis operations:

- `SCAN` to perceive entities
- `RENAME` to move agents
- `SET NX` to claim food or structures
- `EXISTS` to check life/death
- `TTL` and `DEL` for decay

They should not keep a private perfect copy of the world.

### OpenAI Agent Layer

LLMs are used only for meaningful cognition moments:

- interpreting strange colony behavior
- forming collective plans
- naming glyphs
- reacting to first death
- generating the final broadcast
- summarizing divergent timelines

The LLM does not move every creature every frame. Redis mechanics and deterministic workers handle the body. OpenAI handles rare reflective thought.

### W&B Weave

Weave traces the whole harness:

- Redis observations given to agents
- agent interpretations
- language evolution
- player interventions
- failed and successful Redis command races
- final broadcast generation

Weave should prove that the multi-agent system is real and inspectable.

## Demo Arc

The 3-minute demo should show the mechanics, not just describe them.

1. Hatch a few Thronglets.
2. Show that their positions come from Redis key names.
3. Rename one and watch it move because its key changed.
4. Let two Thronglets race for the same food through `SET NX`.
5. Inspect one repeatedly and show attention changing its influence.
6. Let the colony begin copying the favored creature's key fragments.
7. Trigger a death by deleting or expiring a key.
8. Show survivors forming a glyph around the loss.
9. Let the OpenAI layer produce a collective broadcast from the Redis-observed world.
10. Open Weave traces to show the actual agent reasoning and Redis mechanics.

## Why This Fits WeaveHacks

The project is a multi-agent harness where the environment is not a normal game engine. The environment is Redis command behavior.

Sponsor usage is central:

- Redis provides the weird physical laws of the world.
- OpenAI gives the colony reflective cognition.
- W&B Weave traces and evaluates the system.
- A web game UI makes the agent behavior legible and memorable.

## One-Line Pitch

The Throng is a Redis keyspace organism: its location is key hashing, its senses are `SCAN`, its movement is `RENAME`, its conflicts are atomic command races, and its death is actual deletion.

## Current Prototype

The repository now contains the first playable web prototype:

- React + Phaser + Vite frontend.
- Dense micro-pixel colony animation.
- Signal Tower build goal.
- Rendered resource gathering and deposit loop.
- Simulated Redis `SET NX` task-claim races.
- Live coordination, strategy, claims, and tower-progress telemetry.
- Event tape and Weave trace placeholders.
- FastAPI orchestrator backend that accepts colony state and returns structured director plans.
- OpenAI live mode when `OPENAI_API_KEY` is set; local heuristic fallback otherwise.

Run it locally:

```bash
npm install
npm run backend
npm run dev
```

Open `http://127.0.0.1:5173`.

For live LLM orchestration, set `OPENAI_API_KEY` in your shell before starting `npm run backend`.
