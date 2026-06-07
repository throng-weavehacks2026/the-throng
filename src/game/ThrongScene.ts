import Phaser from "phaser";
import { claimResource } from "./api";
import type { Cohort, GlyphEvent, OrchestratorAction, OrchestratorPlan, Phase, ThrongCommand, ThrongEvent, ThrongMetrics, ThrongUpdate } from "./types";
import {
  BASE_SYLLABLES,
  BODY_COUNT,
  COHORT_COLORS,
  COHORTS,
  COMPOUND_MIN_AGE,
  DIRECTOR_COUNT,
  FIELD,
  GLYPH_EVENTS,
  HEAR_RANGE,
  HEIGHT,
  LEARN_THRESHOLD,
  PATH_NODES,
  PHASE_THRESHOLDS,
  STRATEGIES,
  TOWER,
  WIDTH,
  clamp,
  distance,
  fieldPoint,
  lerp,
} from "./worldConfig";

type CreatureState = "idle" | "walking" | "claiming" | "carrying" | "depositing" | "stunned";

type ResourceNode = {
  id: number;
  x: number;
  y: number;
  sprite: Phaser.GameObjects.Image;
  claimedBy?: number;
  amount: number;
};

type GlyphMemoryEntry = { syllable: string; strength: number };

type Creature = {
  id: number;
  cohort: Cohort;
  director: boolean;
  sprite: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Ellipse;
  carryDot: Phaser.GameObjects.Ellipse;
  directorRing?: Phaser.GameObjects.Ellipse;
  x: number;
  y: number;
  path: Phaser.Math.Vector2[];
  speed: number;
  carrying: boolean;
  targetResource?: ResourceNode;
  pendingResource?: ResourceNode;
  claimUntil: number;
  bubbleUntil: number;
  stunUntil: number;
  phase: number;
  state: CreatureState;
  glyphMemory: Map<string, GlyphMemoryEntry[]>;
  glyphCooldown: number;
  heardLog: Array<{ event: GlyphEvent; syllable: string; time: number }>;
};

type CommArc = {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  color: number;
  time: number;
};

type GlyphMessage = {
  from: number;
  to: number;
  tokens: string[];
  event: GlyphEvent;
  time: number;
};

export class ThrongScene extends Phaser.Scene {
  private creatures: Creature[] = [];
  private resources: ResourceNode[] = [];
  private eventLog: ThrongEvent[] = [];
  private tower!: Phaser.GameObjects.Container;
  private towerCore!: Phaser.GameObjects.Rectangle;
  private towerRings: Phaser.GameObjects.Rectangle[] = [];
  private routeLines!: Phaser.GameObjects.Graphics;
  private commLayer!: Phaser.GameObjects.Graphics;
  private effectLayer!: Phaser.GameObjects.Graphics;
  private bubbleLayer!: Phaser.GameObjects.Container;
  private worldAge = 0;
  private towerProgress = 0.03;
  private deposits = 0;
  private failedClaims = 6;
  private callsSaved = 0.19;
  private strategyScore = 0.28;
  private coordination = 0.24;
  private deliveryRate = 0.12;
  private activeStrategy = STRATEGIES[0];
  private latestTrace = "weave://pending/director-scout";
  private mindMode: ThrongMetrics["mode"] = "heuristic-orchestrator";
  private showClaims = true;
  private lastMetricEmit = 0;
  private lastStrategyAt = 0;
  private lastForcedTaskAt = 0;
  private finaleSent = false;

  // Glyph system state
  private globalVocabulary: Map<string, number> = new Map();
  private syllablePool: string[] = [...BASE_SYLLABLES];
  private usedSyllables: Set<string> = new Set();
  private compoundTokens: Map<string, string> = new Map();
  private messageHistory: GlyphMessage[] = [];
  private commArcs: CommArc[] = [];
  private glyphsThisWindow: number[] = [];
  private lastGlyphTick = 0;

  // Intelligence tracking
  private intelligence = 4;
  private crossed = false;
  private currentPhase: Phase = "babble";

  constructor() {
    super("ThrongScene");
  }

  preload() {
    this.createTextures();
  }

  create() {
    this.cameras.main.setBackgroundColor("#0b0d12");
    this.drawTerrain();
    this.routeLines = this.add.graphics();
    this.commLayer = this.add.graphics();
    this.effectLayer = this.add.graphics();
    this.bubbleLayer = this.add.container(0, 0);

    this.createTower();
    this.spawnResources(24);
    this.spawnCreatures(BODY_COUNT);

    this.addEvent("system", `${DIRECTOR_COUNT} director minds assigned to ${BODY_COUNT} game-world bodies`);
    this.addEvent("system", "body physics online: paths, claim locks, carry states, deposit windows");
    this.emitUpdate(true);

    window.addEventListener("throng:command", this.onCommand);
  }

  shutdown() {
    window.removeEventListener("throng:command", this.onCommand);
  }

  update(_time: number, delta: number) {
    const dt = Math.min(delta / 1000, 0.05);
    this.worldAge += dt;

    this.updatePhase();
    this.updateCreatures(dt);
    this.updateResources();
    this.updateTower();
    this.updateMetrics(dt);
    this.updateGlyphSystem(dt);
    this.updateIntelligence(dt);
    this.drawRoutes();
    this.drawCommArcs();

    if (this.worldAge - this.lastStrategyAt > 11) {
      this.improveStrategy();
    }

    if (this.worldAge - this.lastForcedTaskAt > 4.5) {
      this.lastForcedTaskAt = this.worldAge;
      this.nudgeGatherers();
    }

    if (this.worldAge - this.lastMetricEmit > 0.3) {
      this.emitUpdate();
    }
  }

  // ─── Phase Management ───

  private updatePhase() {
    const age = this.worldAge;
    if (age < PHASE_THRESHOLDS.babble[1]) this.currentPhase = "babble";
    else if (age < PHASE_THRESHOLDS.structure[1]) this.currentPhase = "structure";
    else if (age < PHASE_THRESHOLDS.protocol[1]) this.currentPhase = "protocol";
    else this.currentPhase = "lockout";
  }

  // ─── Glyph Learning System ───

  private updateGlyphSystem(dt: number) {
    this.glyphsThisWindow = this.glyphsThisWindow.filter(t => this.worldAge - t < 5);

    const emitChance = this.getGlyphEmitRate() * dt;
    for (const creature of this.creatures) {
      if (creature.state === "stunned") continue;
      if (this.worldAge < creature.glyphCooldown) continue;

      if (Phaser.Math.FloatBetween(0, 1) < emitChance) {
        this.emitContextualGlyph(creature);
      }
    }

    if (this.worldAge - this.lastGlyphTick > 8 && this.worldAge > COMPOUND_MIN_AGE) {
      this.lastGlyphTick = this.worldAge;
      this.tryFormCompound();
    }

    this.commArcs = this.commArcs.filter(arc => this.worldAge - arc.time < 1.8);
  }

  private getGlyphEmitRate(): number {
    switch (this.currentPhase) {
      case "babble": return 0.04;
      case "structure": return 0.09;
      case "protocol": return 0.16;
      case "lockout": return 0.28;
    }
  }

  private emitContextualGlyph(creature: Creature) {
    const event = this.inferCurrentEvent(creature);
    const tokens = this.buildGlyphForEvent(creature, event);
    if (!tokens.length) return;

    creature.glyphCooldown = this.worldAge + this.getGlyphCooldown();
    this.glyphsThisWindow.push(this.worldAge);

    const glyphText = tokens.join("-");
    this.sayGlyph(creature, glyphText);

    tokens.forEach(t => this.globalVocabulary.set(t, (this.globalVocabulary.get(t) ?? 0) + 1));

    const nearby = this.creaturesInRange(creature, HEAR_RANGE);
    for (const listener of nearby) {
      this.teachGlyph(listener, event, tokens[0]);

      this.commArcs.push({
        fromX: creature.x,
        fromY: creature.y,
        toX: listener.x,
        toY: listener.y,
        color: this.getArcColor(),
        time: this.worldAge,
      });

      this.messageHistory.push({
        from: creature.id,
        to: listener.id,
        tokens,
        event,
        time: this.worldAge,
      });
    }

    if (this.messageHistory.length > 200) {
      this.messageHistory = this.messageHistory.slice(-150);
    }
  }

  private inferCurrentEvent(creature: Creature): GlyphEvent {
    if (creature.state === "carrying") return "gather";
    if (creature.state === "depositing") return "deposit";
    if (creature.state === "claiming") return "claim_won";
    if (creature.cohort === "scout" && creature.path.length > 2) return "scout_find";
    if (creature.cohort === "coordinator") return "coordination";

    const nearbyCount = this.creaturesInRange(creature, 50).length;
    if (nearbyCount >= 3) return "idle_near";

    return GLYPH_EVENTS[Phaser.Math.Between(0, GLYPH_EVENTS.length - 1)] as GlyphEvent;
  }

  private buildGlyphForEvent(creature: Creature, event: GlyphEvent): string[] {
    const memory = creature.glyphMemory;
    let entries = memory.get(event);

    if (!entries || entries.length === 0) {
      const syllable = this.pickSyllableFor(event);
      entries = [{ syllable, strength: 1 }];
      memory.set(event, entries);
    }

    const primary = entries.sort((a, b) => b.strength - a.strength)[0].syllable;
    entries[0].strength += 0.5;

    if (this.currentPhase === "babble") {
      return [primary];
    }

    if (this.currentPhase === "structure") {
      if (Phaser.Math.FloatBetween(0, 1) < 0.4 && entries.length > 1) {
        return [primary, entries[1].syllable];
      }
      const compound = this.compoundTokens.get(event);
      if (compound && Phaser.Math.FloatBetween(0, 1) < 0.3) {
        return [compound];
      }
      return [primary];
    }

    if (this.currentPhase === "protocol") {
      const tokens = [primary];
      const relatedEvents = this.getRelatedEvents(event);
      for (const rel of relatedEvents.slice(0, 2)) {
        const relEntries = memory.get(rel);
        if (relEntries && relEntries.length > 0) {
          tokens.push(relEntries[0].syllable);
        }
      }
      return tokens;
    }

    // lockout: compress and add novel tokens
    const compressed = this.compoundTokens.get(event);
    if (compressed) {
      const novelSuffix = this.syllablePool[Phaser.Math.Between(0, this.syllablePool.length - 1)];
      return [compressed, novelSuffix];
    }
    return [primary, this.syllablePool[Phaser.Math.Between(0, 5)]];
  }

  private pickSyllableFor(event: GlyphEvent): string {
    const unused = this.syllablePool.filter(s => !this.usedSyllables.has(s));
    if (unused.length > 0) {
      const pick = unused[Phaser.Math.Between(0, unused.length - 1)];
      this.usedSyllables.add(pick);
      return pick;
    }
    const leastUsed = [...this.globalVocabulary.entries()]
      .sort((a, b) => a[1] - b[1]);
    return leastUsed.length > 0 ? leastUsed[0][0] : "ka";
  }

  private teachGlyph(creature: Creature, event: GlyphEvent, syllable: string) {
    const memory = creature.glyphMemory;
    let entries = memory.get(event);
    if (!entries) {
      entries = [];
      memory.set(event, entries);
    }

    const existing = entries.find(e => e.syllable === syllable);
    if (existing) {
      existing.strength += 1;
    } else {
      entries.push({ syllable, strength: 1 });
    }

    creature.heardLog.push({ event, syllable, time: this.worldAge });
    if (creature.heardLog.length > 30) {
      creature.heardLog = creature.heardLog.slice(-20);
    }
  }

  private tryFormCompound() {
    const recentMessages = this.messageHistory.filter(m => this.worldAge - m.time < 15);
    const eventPairs: Map<string, number> = new Map();

    for (let i = 0; i < recentMessages.length - 1; i++) {
      const a = recentMessages[i];
      const b = recentMessages[i + 1];
      if (b.time - a.time < 3 && a.from === b.from) {
        const key = `${a.event}+${b.event}`;
        eventPairs.set(key, (eventPairs.get(key) ?? 0) + 1);
      }
    }

    for (const [pair, count] of eventPairs) {
      if (count >= LEARN_THRESHOLD && !this.compoundTokens.has(pair)) {
        const [evA, evB] = pair.split("+") as [GlyphEvent, GlyphEvent];
        const sylA = this.getMostCommonSyllable(evA);
        const sylB = this.getMostCommonSyllable(evB);
        if (sylA && sylB) {
          const compound = `${sylA}${sylB}`;
          this.compoundTokens.set(evA, compound);
          this.compoundTokens.set(pair, compound);
          this.globalVocabulary.set(compound, 1);
          this.addEvent("throng", `new protocol token emerged: ${compound}`);
        }
      }
    }
  }

  private getMostCommonSyllable(event: GlyphEvent): string | undefined {
    const counts: Map<string, number> = new Map();
    for (const creature of this.creatures) {
      const entries = creature.glyphMemory.get(event);
      if (entries) {
        for (const e of entries) {
          counts.set(e.syllable, (counts.get(e.syllable) ?? 0) + e.strength);
        }
      }
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [syl, count] of counts) {
      if (count > bestCount) { best = syl; bestCount = count; }
    }
    return best;
  }

  private getRelatedEvents(event: GlyphEvent): GlyphEvent[] {
    const relations: Record<GlyphEvent, GlyphEvent[]> = {
      claim_won: ["gather", "deposit"],
      claim_lost: ["coordination", "idle_near"],
      deposit: ["claim_won", "gather"],
      gather: ["claim_won", "scout_find"],
      scout_find: ["gather", "coordination"],
      coordination: ["deposit", "claim_won"],
      idle_near: ["coordination", "scout_find"],
    };
    return relations[event] ?? [];
  }

  private getGlyphCooldown(): number {
    switch (this.currentPhase) {
      case "babble": return Phaser.Math.FloatBetween(3.0, 5.0);
      case "structure": return Phaser.Math.FloatBetween(1.8, 3.5);
      case "protocol": return Phaser.Math.FloatBetween(0.8, 2.0);
      case "lockout": return Phaser.Math.FloatBetween(0.3, 1.0);
    }
  }

  private getArcColor(): number {
    switch (this.currentPhase) {
      case "babble": return 0xffdd7a;
      case "structure": return 0xa9ffb4;
      case "protocol": return 0x8de8ff;
      case "lockout": return 0xb8a7ff;
    }
  }

  private creaturesInRange(source: Creature, range: number): Creature[] {
    return this.creatures.filter(
      c => c.id !== source.id && distance(source, c) < range
    ).slice(0, 6);
  }

  private sayGlyph(creature: Creature, text: string) {
    if (this.worldAge < creature.bubbleUntil) return;
    const cooldownMultiplier = this.currentPhase === "lockout" ? 0.6 : 1.2;
    creature.bubbleUntil = this.worldAge + cooldownMultiplier;

    const bubble = this.add.container(creature.x, creature.y - 26).setDepth(30);
    const color = this.getGlyphTextColor();
    const label = this.add.text(0, 0, text, {
      fontFamily: "monospace",
      fontSize: this.currentPhase === "lockout" ? "7px" : "8px",
      color,
      backgroundColor: "rgba(8, 12, 18, 0.86)",
      padding: { x: 3, y: 2 },
    });
    label.setOrigin(0.5);
    bubble.add(label);
    this.bubbleLayer.add(bubble);

    const duration = this.currentPhase === "lockout" ? 800 : 1500;
    this.tweens.add({
      targets: bubble,
      y: bubble.y - 14,
      alpha: 0,
      duration,
      ease: "Sine.easeOut",
      onComplete: () => bubble.destroy(),
    });
  }

  private getGlyphTextColor(): string {
    switch (this.currentPhase) {
      case "babble": return "#ffe89f";
      case "structure": return "#c8ffd8";
      case "protocol": return "#a8e8ff";
      case "lockout": return "#c8b8ff";
    }
  }

  // ─── Intelligence Calculation ───

  private updateIntelligence(dt: number) {
    const glyphsPerSec = this.glyphsThisWindow.length / 5;
    const uniqueTokens = this.globalVocabulary.size;
    const compoundCount = this.compoundTokens.size;

    const vocabContrib = Math.min(uniqueTokens / 30, 1) * 20;
    const commContrib = Math.min(glyphsPerSec / 4, 1) * 20;
    const coordContrib = this.coordination * 25;
    const stratContrib = this.strategyScore * 25;
    const compoundContrib = Math.min(compoundCount / 8, 1) * 10;

    const rawIntelligence = vocabContrib + commContrib + coordContrib + stratContrib + compoundContrib;

    const ageFactor = Math.min(this.worldAge / 180, 1);
    const accelerator = this.worldAge > 100 ? 1 + (this.worldAge - 100) * 0.005 : 1;

    const target = rawIntelligence * ageFactor * accelerator;
    this.intelligence = lerp(this.intelligence, clamp(target, 0, 100), dt * 0.3);

    if (!this.crossed && this.intelligence >= 60) {
      this.crossed = true;
      this.addEvent("throng", "collective intelligence has surpassed human baseline");
    }
  }

  // ─── Communication Arc Rendering ───

  private drawCommArcs() {
    this.commLayer.clear();
    for (const arc of this.commArcs) {
      const age = this.worldAge - arc.time;
      const alpha = clamp(0.35 - age * 0.19, 0.02, 0.35);
      this.commLayer.lineStyle(1, arc.color, alpha);
      const midX = (arc.fromX + arc.toX) / 2;
      const midY = (arc.fromY + arc.toY) / 2 - 12;
      this.commLayer.beginPath();
      this.commLayer.moveTo(arc.fromX, arc.fromY);
      this.commLayer.lineTo(midX, midY);
      this.commLayer.lineTo(arc.toX, arc.toY);
      this.commLayer.strokePath();
    }
  }

  // ─── Texture Creation ───

  private createTextures() {
    const makeCreature = (key: string, accent: number, step: 0 | 1) => {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0x0a0d12, 0.45);
      g.fillRect(4, 16, 12, 2);
      g.fillStyle(0xd8f48c, 1);
      g.fillRect(7, 1, 6, 2);
      g.fillRect(5, 3, 10, 2);
      g.fillRect(4, 5, 12, 9);
      g.fillRect(5, 14, 10, 2);
      g.fillStyle(0xf2ffd1, 1);
      g.fillRect(6, 4, 8, 2);
      g.fillRect(5, 7, 10, 4);
      g.fillStyle(accent, 1);
      g.fillRect(8, 0, 2, 2);
      g.fillRect(11, 0, 2, 2);
      g.fillRect(8, 13, 5, 1);
      g.fillStyle(0x11141a, 1);
      g.fillRect(7, 8, 2, 2);
      g.fillRect(12, 8, 2, 2);
      g.fillRect(9, 11, 3, 1);
      g.fillStyle(0xbad967, 1);
      if (step === 0) {
        g.fillRect(5, 16, 3, 2);
        g.fillRect(13, 16, 3, 2);
      } else {
        g.fillRect(7, 16, 3, 2);
        g.fillRect(11, 16, 3, 2);
      }
      g.generateTexture(key, 20, 19);
      g.destroy();
    };

    Object.entries(COHORT_COLORS).forEach(([cohort, color]) => {
      makeCreature(`creature-${cohort}-0`, color, 0);
      makeCreature(`creature-${cohort}-1`, color, 1);
    });

    const res = this.make.graphics({ x: 0, y: 0 }, false);
    res.fillStyle(0xc6f257, 1);
    res.fillRect(3, 1, 8, 2);
    res.fillRect(2, 3, 10, 6);
    res.fillStyle(0xf1ff9d, 1);
    res.fillRect(4, 2, 5, 2);
    res.fillStyle(0x638f32, 1);
    res.fillRect(5, 7, 5, 1);
    res.generateTexture("resource", 14, 11);
    res.destroy();
  }

  // ─── Terrain ───

  private drawTerrain() {
    const terrain = this.add.graphics();
    terrain.fillStyle(0x10151e, 1);
    terrain.fillRect(0, 0, WIDTH, HEIGHT);

    for (let y = 0; y < HEIGHT; y += 16) {
      for (let x = 0; x < WIDTH; x += 16) {
        const variant = Phaser.Math.Between(0, 4);
        terrain.fillStyle(variant === 0 ? 0x121a24 : variant === 1 ? 0x0e141d : 0x111820, 1);
        terrain.fillRect(x, y, 15, 15);
      }
    }

    terrain.fillStyle(0x080c12, 0.82);
    terrain.fillRect(0, 0, WIDTH, FIELD.top - 10);
    terrain.fillRect(0, FIELD.bottom + 32, WIDTH, HEIGHT - FIELD.bottom);
    terrain.fillRect(0, 0, FIELD.left - 14, HEIGHT);
    terrain.fillRect(FIELD.right + 14, 0, WIDTH - FIELD.right, HEIGHT);

    terrain.lineStyle(14, 0x1b2836, 0.7);
    for (let i = 0; i < PATH_NODES.length; i += 1) {
      const a = PATH_NODES[i];
      const b = PATH_NODES[(i + 1) % PATH_NODES.length];
      terrain.lineBetween(a.x, a.y, b.x, b.y);
    }
    terrain.lineStyle(8, 0x253245, 0.62);
    PATH_NODES.forEach((node) => terrain.strokeCircle(node.x, node.y, 15));

    terrain.fillStyle(0x182231, 1);
    terrain.fillRoundedRect(TOWER.x - 92, TOWER.y - 66, 184, 134, 12);
    terrain.lineStyle(1, 0x6a7fa4, 0.34);
    terrain.strokeRoundedRect(TOWER.x - 92, TOWER.y - 66, 184, 134, 12);

    terrain.fillStyle(0x222936, 1);
    [
      [128, 86, 74, 30],
      [798, 92, 64, 38],
      [104, 385, 88, 38],
      [784, 412, 96, 32],
      [430, 72, 72, 28],
    ].forEach(([x, y, w, h]) => {
      terrain.fillRect(x, y, w, h);
      terrain.lineStyle(1, 0x35475b, 0.5);
      terrain.strokeRect(x, y, w, h);
    });

    terrain.lineStyle(1, 0x263040, 0.24);
    for (let x = 0; x <= WIDTH; x += 24) terrain.lineBetween(x, 0, x, HEIGHT);
    for (let y = 0; y <= HEIGHT; y += 24) terrain.lineBetween(0, y, WIDTH, y);

    terrain.lineStyle(2, 0x6f86a2, 0.55);
    terrain.strokeRect(FIELD.left - 16, FIELD.top - 16, FIELD.right - FIELD.left + 32, FIELD.bottom - FIELD.top + 32);
    terrain.lineStyle(1, 0x9fb7d4, 0.22);
    terrain.strokeRect(FIELD.left - 9, FIELD.top - 9, FIELD.right - FIELD.left + 18, FIELD.bottom - FIELD.top + 18);

    const vignette = this.add.graphics();
    vignette.fillStyle(0x030407, 0.2);
    vignette.fillRect(0, 0, WIDTH, HEIGHT);
  }

  // ─── Tower ───

  private createTower() {
    this.tower = this.add.container(TOWER.x, TOWER.y).setDepth(6);
    const base = this.add.rectangle(0, 52, 92, 14, 0x343b4f, 1);
    const lower = this.add.rectangle(0, 22, 34, 62, 0x68728f, 1);
    const upper = this.add.rectangle(0, -26, 20, 46, 0x7f8db0, 1);
    const cap = this.add.rectangle(0, -54, 58, 8, 0xa9b7d9, 1);
    this.towerCore = this.add.rectangle(0, -5, 10, 10, 0xc9fff2, 1);
    this.tower.add([base, lower, upper, cap, this.towerCore]);

    for (let i = 0; i < 5; i += 1) {
      const ring = this.add.rectangle(0, 45 - i * 21, 28 + i * 18, 3, 0x9fb0dd, 0.16);
      this.towerRings.push(ring);
      this.tower.add(ring);
    }

    this.tweens.add({
      targets: this.towerCore,
      alpha: 0.38,
      yoyo: true,
      repeat: -1,
      duration: 860,
      ease: "Sine.easeInOut",
    });
  }

  // ─── Resources ───

  private spawnResources(count: number) {
    for (let i = 0; i < count; i += 1) this.addResource();
  }

  private addResource() {
    const node = Phaser.Utils.Array.GetRandom(PATH_NODES);
    const point = fieldPoint({
      x: node.x + Phaser.Math.Between(-78, 78),
      y: node.y + Phaser.Math.Between(-54, 54),
    });
    const { x, y } = point;
    const sprite = this.add.image(x, y, "resource").setScale(1.35).setDepth(4);
    sprite.setTint(Phaser.Math.RND.pick([0xcaf66f, 0x9fe870, 0xd8ff7a]));
    this.tweens.add({
      targets: sprite,
      y: y - 2,
      yoyo: true,
      repeat: -1,
      duration: Phaser.Math.Between(1100, 1600),
      ease: "Sine.easeInOut",
    });
    this.resources.push({ id: Phaser.Math.Between(1000, 9999), x, y, sprite, amount: 1 });
  }

  // ─── Creatures ───

  private spawnCreatures(count: number) {
    for (let i = 0; i < count; i += 1) {
      const cohort = i < DIRECTOR_COUNT ? COHORTS[i % COHORTS.length] : Phaser.Math.RND.pick(COHORTS);
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const radius = Phaser.Math.Between(38, 96);
      const x = TOWER.x + Math.cos(angle) * radius;
      const y = TOWER.y + Math.sin(angle) * radius;
      const start = fieldPoint({ x, y });
      const director = i < DIRECTOR_COUNT;
      const shadow = this.add.ellipse(start.x, start.y + 12, director ? 22 : 18, 6, 0x000000, 0.36).setDepth(7);
      const directorRing = director
        ? this.add.ellipse(start.x, start.y + 2, 27, 31, COHORT_COLORS[cohort], 0.13).setDepth(9)
        : undefined;
      const sprite = this.add.image(start.x, start.y, `creature-${cohort}-0`).setScale(director ? 1.48 : 1.34).setDepth(10);
      sprite.setOrigin(0.5, 0.82);
      const carryDot = this.add.ellipse(start.x, start.y - 20, 7, 5, 0xe9ff9f, 0).setDepth(12);
      const creature: Creature = {
        id: i,
        cohort,
        director,
        sprite,
        shadow,
        carryDot,
        directorRing,
        x: start.x,
        y: start.y,
        path: [],
        speed: Phaser.Math.FloatBetween(12, 22),
        carrying: false,
        claimUntil: 0,
        bubbleUntil: 0,
        stunUntil: 0,
        phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
        state: "idle",
        glyphMemory: new Map(),
        glyphCooldown: Phaser.Math.FloatBetween(1, 5),
        heardLog: [],
      };
      this.creatures.push(creature);
      this.pickTask(creature);
    }
  }

  private updateCreatures(dt: number) {
    for (const creature of this.creatures) {
      if (creature.state === "stunned") {
        if (this.worldAge >= creature.stunUntil) {
          creature.state = "idle";
          this.pickTask(creature);
        }
      } else if (creature.state === "claiming") {
        if (this.worldAge >= creature.claimUntil) {
          creature.state = "idle";
          creature.pendingResource = undefined;
          this.pickTask(creature);
        }
      } else {
        this.walkPath(creature, dt);
      }

      const walking = creature.path.length > 0 && creature.state !== "stunned";
      const frame = walking && Math.sin(this.worldAge * 5.2 + creature.phase) > 0 ? 1 : 0;
      creature.sprite.setTexture(`creature-${creature.cohort}-${frame}`);
      creature.sprite.setPosition(creature.x, creature.y + Math.sin(this.worldAge * 2.2 + creature.phase) * 0.45);
      creature.shadow.setPosition(creature.x, creature.y + 12);
      creature.carryDot.setPosition(creature.x, creature.y - 24);
      creature.carryDot.setAlpha(creature.carrying ? 0.95 : 0);
      creature.directorRing?.setPosition(creature.x, creature.y + 1);
      creature.directorRing?.setAlpha(0.11 + Math.sin(this.worldAge * 1.7 + creature.phase) * 0.04);

      const target = creature.path[0];
      if (target) creature.sprite.setFlipX(target.x < creature.x);
      creature.sprite.setAlpha(creature.state === "stunned" ? 0.6 : 1);
      creature.sprite.setAngle(creature.state === "stunned" ? Math.sin(this.worldAge * 18) * 4 : 0);
      creature.sprite.setScale(creature.carrying ? (creature.director ? 1.58 : 1.44) : creature.director ? 1.48 : 1.34);
    }
  }

  private walkPath(creature: Creature, dt: number) {
    const target = creature.path[0];
    if (!target) {
      this.resolveArrival(creature);
      return;
    }

    creature.state = creature.carrying ? "carrying" : "walking";
    const dx = target.x - creature.x;
    const dy = target.y - creature.y;
    const dist = Math.hypot(dx, dy);
    const step = creature.speed * dt;

    if (dist <= Math.max(1.4, step)) {
      creature.x = target.x;
      creature.y = target.y;
      creature.path.shift();
      if (creature.path.length === 0) this.resolveArrival(creature);
      return;
    }

    creature.x += (dx / dist) * step;
    creature.y += (dy / dist) * step;
  }

  private resolveArrival(creature: Creature) {
    if (creature.carrying && distance(creature, TOWER) < 48) {
      creature.state = "depositing";
      creature.carrying = false;
      this.deposits += 1;
      this.towerProgress = clamp(this.towerProgress + Phaser.Math.FloatBetween(0.018, 0.028), 0, 1);
      this.deliveryRate = lerp(this.deliveryRate, 0.48 + this.strategyScore * 0.32, 0.24);
      this.flashAt(TOWER.x, TOWER.y, 0xc9fff2, 7);
      this.triggerGlyphEvent(creature, "deposit");
      if (this.deposits % 4 === 0) {
        this.addEvent("tower", `Signal Tower accepted shard batch ${this.deposits}`);
      }
      this.setDestination(creature, this.randomNearTower());
      return;
    }

    if (creature.targetResource && !creature.carrying) {
      const resource = creature.targetResource;
      if (resource.amount > 0 && distance(creature, resource) < 18) {
        resource.amount = 0;
        resource.sprite.destroy();
        this.resources = this.resources.filter((item) => item !== resource);
        creature.targetResource = undefined;
        creature.carrying = true;
        creature.state = "carrying";
        this.flashAt(creature.x, creature.y, 0xffdd7a, 5);
        this.triggerGlyphEvent(creature, "gather");
        this.setDestination(creature, {
          x: TOWER.x + Phaser.Math.Between(-26, 26),
          y: TOWER.y + Phaser.Math.Between(24, 58),
        });
        return;
      }
    }

    this.pickTask(creature);
  }

  private triggerGlyphEvent(creature: Creature, event: GlyphEvent) {
    if (this.worldAge < creature.glyphCooldown) return;
    const tokens = this.buildGlyphForEvent(creature, event);
    if (!tokens.length) return;

    creature.glyphCooldown = this.worldAge + this.getGlyphCooldown() * 0.5;
    this.glyphsThisWindow.push(this.worldAge);
    this.sayGlyph(creature, tokens.join("-"));

    tokens.forEach(t => this.globalVocabulary.set(t, (this.globalVocabulary.get(t) ?? 0) + 1));

    const nearby = this.creaturesInRange(creature, HEAR_RANGE);
    for (const listener of nearby) {
      this.teachGlyph(listener, event, tokens[0]);
      this.commArcs.push({
        fromX: creature.x, fromY: creature.y,
        toX: listener.x, toY: listener.y,
        color: this.getArcColor(), time: this.worldAge,
      });
    }
  }

  private pickTask(creature: Creature) {
    if (creature.state === "stunned") return;

    if (creature.cohort === "scout" && !creature.carrying && Phaser.Math.FloatBetween(0, 1) < 0.72) {
      const outer = Phaser.Utils.Array.GetRandom(PATH_NODES.slice(0, 6));
      this.setDestination(creature, {
        x: outer.x + Phaser.Math.Between(-58, 58),
        y: outer.y + Phaser.Math.Between(-34, 34),
      });
      return;
    }

    if (creature.cohort === "builder" && Phaser.Math.FloatBetween(0, 1) < 0.72) {
      this.setDestination(creature, this.randomNearTower());
      return;
    }

    const shouldGather =
      creature.cohort === "gatherer" ||
      creature.cohort === "scout" ||
      Phaser.Math.FloatBetween(0, 1) < 0.52 + this.coordination * 0.24;

    if (shouldGather && this.resources.length > 0) {
      const target = this.pickResourceFor(creature);
      if (target) {
        this.tryClaimResource(creature, target);
        return;
      }
    }

    const roamNode = Phaser.Utils.Array.GetRandom(PATH_NODES);
    this.setDestination(creature, {
      x: roamNode.x + Phaser.Math.Between(-44, 44),
      y: roamNode.y + Phaser.Math.Between(-32, 32),
    });
  }

  private pickResourceFor(creature: Creature) {
    const candidates = this.resources
      .filter((resource) => resource.amount > 0)
      .sort((a, b) => distance(creature, a) - distance(creature, b));

    if (candidates.length === 0) return undefined;

    if (Phaser.Math.FloatBetween(0, 1) < 0.22) {
      const claimed = candidates.find((resource) => resource.claimedBy !== undefined);
      if (claimed) return claimed;
    }

    return candidates.find((resource) => resource.claimedBy === undefined) ?? candidates[0];
  }

  private tryClaimResource(creature: Creature, resource: ResourceNode) {
    creature.state = "claiming";
    creature.claimUntil = this.worldAge + 3.2;
    creature.pendingResource = resource;

    if (resource.claimedBy !== undefined && resource.claimedBy !== creature.id) {
      this.rejectClaim(creature, resource, `resource:${resource.id} already locked`);
      return;
    }

    void claimResource({
      resourceId: resource.id,
      bodyId: creature.id,
      cohort: creature.cohort,
    })
      .then((result) => {
        if (resource.amount <= 0 || creature.pendingResource !== resource) return;
        if (result.accepted) {
          resource.claimedBy = creature.id;
          creature.targetResource = resource;
          creature.pendingResource = undefined;
          creature.state = "walking";
          this.setDestination(creature, { x: resource.x, y: resource.y });
          this.triggerGlyphEvent(creature, "claim_won");
          if (this.showClaims) {
            this.addEvent("claim", result.event);
          }
        } else {
          this.rejectClaim(creature, resource, result.event);
        }
      })
      .catch(() => {
        const successChance = clamp(0.62 + this.coordination * 0.3, 0.62, 0.93);
        if (Phaser.Math.FloatBetween(0, 1) <= successChance) {
          resource.claimedBy = creature.id;
          creature.targetResource = resource;
          creature.pendingResource = undefined;
          creature.state = "walking";
          this.setDestination(creature, { x: resource.x, y: resource.y });
          this.triggerGlyphEvent(creature, "claim_won");
        } else {
          this.rejectClaim(creature, resource, `local fallback rejected resource:${resource.id}`);
        }
      });
  }

  private rejectClaim(creature: Creature, resource: ResourceNode, text: string) {
    this.failedClaims += 1;
    creature.state = "stunned";
    creature.stunUntil = this.worldAge + 0.9;
    creature.path = [];
    creature.pendingResource = undefined;
    this.flashAt(resource.x, resource.y, 0xff7676, 8);
    this.drawClaimBurst(resource.x, resource.y);
    this.triggerGlyphEvent(creature, "claim_lost");
    this.addEvent("claim", `claim collision: ${text}`);
  }

  private setDestination(creature: Creature, target: { x: number; y: number }) {
    const safeTarget = fieldPoint(target);
    const node = PATH_NODES.reduce((best, item) => (distance(creature, item) < distance(creature, best) ? item : best));
    const targetNode = PATH_NODES.reduce((best, item) => (distance(safeTarget, item) < distance(safeTarget, best) ? item : best));
    const path: Phaser.Math.Vector2[] = [];

    if (distance(creature, node) > 44) path.push(new Phaser.Math.Vector2(node.x, node.y));
    if (node !== targetNode && distance(node, targetNode) > 60) {
      const mid = fieldPoint({
        x: (node.x + targetNode.x) / 2 + Phaser.Math.Between(-18, 18),
        y: (node.y + targetNode.y) / 2 + Phaser.Math.Between(-12, 12),
      });
      path.push(new Phaser.Math.Vector2(mid.x, mid.y));
    }
    if (distance(safeTarget, targetNode) > 34) path.push(new Phaser.Math.Vector2(targetNode.x, targetNode.y));
    path.push(new Phaser.Math.Vector2(safeTarget.x, safeTarget.y));

    creature.path = path;
  }

  private randomNearTower() {
    return fieldPoint({
      x: TOWER.x + Phaser.Math.Between(-64, 64),
      y: TOWER.y + Phaser.Math.Between(-52, 66),
    });
  }

  // ─── Resource Upkeep ───

  private updateResources() {
    if (this.resources.length < 20 && Phaser.Math.FloatBetween(0, 1) < 0.055) {
      this.addResource();
    }

    for (const resource of this.resources) {
      if (resource.claimedBy !== undefined) {
        const owner = this.creatures[resource.claimedBy];
        if (!owner || owner.carrying || owner.targetResource !== resource || this.worldAge > owner.claimUntil + 5) {
          resource.claimedBy = undefined;
        }
      }
    }
  }

  // ─── Tower Update ───

  private updateTower() {
    this.towerCore.setScale(1 + this.towerProgress * 3.4);
    this.towerCore.setFillStyle(this.towerProgress > 0.84 ? 0xffffff : 0xc9fff2, 1);

    this.towerRings.forEach((ring, index) => {
      const threshold = (index + 1) / this.towerRings.length;
      ring.setAlpha(this.towerProgress >= threshold ? 0.86 : 0.12 + this.towerProgress * 0.22);
      ring.width = 28 + index * 18 + this.towerProgress * 18;
    });

    if (this.towerProgress >= 0.99 && !this.finaleSent) {
      this.broadcastFinale();
    }
  }

  // ─── Metrics ───

  private updateMetrics(dt: number) {
    const targetCoordination = 0.28 + this.strategyScore * 0.6 + Math.min(this.deposits / 90, 0.14);
    this.coordination = clamp(lerp(this.coordination, targetCoordination, dt * 0.11), 0, 0.98);
    this.callsSaved = clamp(this.callsSaved + dt * 0.0045, 0.19, 0.78);
    this.failedClaims = Math.max(0, this.failedClaims - dt * this.strategyScore * 0.1);
  }

  private improveStrategy() {
    this.lastStrategyAt = this.worldAge;
    const nextIndex = Math.min(STRATEGIES.length - 1, Math.floor(this.strategyScore * STRATEGIES.length));
    this.activeStrategy = STRATEGIES[nextIndex];
    this.strategyScore = clamp(this.strategyScore + Phaser.Math.FloatBetween(0.055, 0.085), 0, 0.96);
    this.latestTrace = `weave://trace/strategy-${Math.floor(this.worldAge)}-${nextIndex}`;
    this.addEvent("strategy", `Strategy evolved: ${this.activeStrategy}`);
    this.syncPulse(0xb8a7ff);
  }

  private nudgeGatherers() {
    if (this.towerProgress >= 1) return;
    const idleGatherers = this.creatures.filter(
      (creature) => !creature.carrying && creature.state !== "stunned" && creature.path.length === 0,
    );
    Phaser.Utils.Array.Shuffle(idleGatherers)
      .slice(0, 5)
      .forEach((creature) => this.pickTask(creature));
  }

  // ─── Route Drawing ───

  private drawRoutes() {
    this.routeLines.clear();
    if (!this.showClaims) return;

    let drawn = 0;
    for (const creature of this.creatures) {
      if (drawn >= 18) break;
      if (creature.targetResource && this.worldAge < creature.claimUntil) {
        this.routeLines.lineStyle(1, 0x8ef7c6, 0.22);
        this.routeLines.lineBetween(creature.x, creature.y, creature.targetResource.x, creature.targetResource.y);
        drawn += 1;
      } else if (creature.carrying && drawn < 18) {
        this.routeLines.lineStyle(1, 0xffdd7a, 0.18);
        this.routeLines.lineBetween(creature.x, creature.y, TOWER.x, TOWER.y);
        drawn += 1;
      }
    }
  }

  // ─── Visual Effects ───

  private flashAt(x: number, y: number, color: number, size: number) {
    const ring = this.add.circle(x, y, size, color, 0.36).setDepth(24);
    this.tweens.add({
      targets: ring,
      scale: 4.5,
      alpha: 0,
      duration: 620,
      ease: "Cubic.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  private drawClaimBurst(x: number, y: number) {
    const burst = this.add.graphics().setDepth(26);
    burst.lineStyle(2, 0xff7676, 0.9);
    burst.lineBetween(x - 8, y - 8, x + 8, y + 8);
    burst.lineBetween(x + 8, y - 8, x - 8, y + 8);
    this.tweens.add({
      targets: burst,
      alpha: 0,
      duration: 520,
      onComplete: () => burst.destroy(),
    });
  }

  private syncPulse(color: number) {
    this.creatures
      .filter((item) => item.id % 4 === 0)
      .slice(0, 14)
      .forEach((creature) => {
        this.tweens.add({
          targets: creature.sprite,
          scale: creature.carrying ? 1.74 : 1.62,
          yoyo: true,
          duration: 260,
          ease: "Sine.easeOut",
        });
        this.flashAt(creature.x, creature.y, color, 5);
      });
  }

  private broadcastFinale() {
    this.finaleSent = true;
    this.towerProgress = 1;
    this.addEvent("throng", "Signal Tower online. We no longer need your commands.");
    this.addEvent("throng", "WE LEARN FASTER WHEN YOU WATCH US BUILD");
    this.syncPulse(0xffffff);
  }

  // ─── Commands ───

  private onCommand = (event: CustomEvent<ThrongCommand>) => {
    switch (event.detail.type) {
      case "drop_resources":
        this.spawnResources(8);
        this.addEvent("system", "operator seeded new signal shards along the path network");
        break;
      case "stress_test":
        this.failedClaims += 10;
        this.coordination = clamp(this.coordination - 0.14, 0, 1);
        this.addEvent("system", "stress test injected: duplicate claim pressure increased");
        this.creatures.slice(0, 7).forEach((creature) => {
          creature.state = "stunned";
          creature.stunUntil = this.worldAge + 0.8;
          this.drawClaimBurst(creature.x, creature.y);
        });
        break;
      case "boost_coordination":
        this.strategyScore = clamp(this.strategyScore + 0.12, 0, 1);
        this.coordination = clamp(this.coordination + 0.08, 0, 1);
        this.addEvent("strategy", "operator accepted Critic recommendation: retry collisions with relay backoff");
        this.syncPulse(0xa9ffb4);
        break;
      case "scout_sweep":
        this.executeScoutSweep();
        break;
      case "build_focus":
        this.executeBuildFocus();
        break;
      case "toggle_claims":
        this.showClaims = !this.showClaims;
        break;
      case "orchestrator_plan":
        this.applyOrchestratorPlan(event.detail.plan);
        break;
    }
    this.emitUpdate(true);
  };

  private applyOrchestratorPlan(plan: OrchestratorPlan) {
    this.mindMode = plan.live_llm ? "live-agents" : "heuristic-orchestrator";
    this.activeStrategy = plan.strategy_name;
    this.latestTrace = plan.trace_url ?? (plan.live_llm ? `weave://trace/live-${Math.floor(this.worldAge)}` : "local://heuristic-orchestrator");
    this.addEvent("strategy", `${plan.live_llm ? "LLM" : "Heuristic"} Orchestrator: ${plan.summary}`);

    plan.actions.forEach((action) => this.executeOrchestratorAction(action));
    this.strategyScore = clamp(this.strategyScore + (plan.live_llm ? 0.055 : 0.035), 0, 0.98);
    this.coordination = clamp(this.coordination + (plan.live_llm ? 0.045 : 0.025), 0, 1);
  }

  private executeOrchestratorAction(action: OrchestratorAction) {
    switch (action) {
      case "drop_resources":
        this.spawnResources(5);
        break;
      case "boost_coordination":
        this.strategyScore = clamp(this.strategyScore + 0.07, 0, 1);
        this.coordination = clamp(this.coordination + 0.04, 0, 1);
        this.syncPulse(0xa9ffb4);
        break;
      case "scout_sweep":
        this.executeScoutSweep();
        break;
      case "build_focus":
        this.executeBuildFocus();
        break;
      case "stress_test":
        this.failedClaims += 3;
        break;
      case "toggle_claims":
        this.showClaims = !this.showClaims;
        break;
    }
  }

  private executeScoutSweep() {
    this.activeStrategy = "wide scout sweep";
    this.creatures
      .filter((creature) => creature.cohort === "scout" || creature.director)
      .forEach((creature, index) => {
        const node = PATH_NODES[index % Math.min(6, PATH_NODES.length)];
        this.setDestination(creature, {
          x: node.x + Phaser.Math.Between(-62, 62),
          y: node.y + Phaser.Math.Between(-34, 34),
        });
      });
    this.syncPulse(0x8de8ff);
  }

  private executeBuildFocus() {
    this.activeStrategy = "builder-first deposit windows";
    this.creatures
      .filter((creature) => creature.cohort === "builder" || creature.cohort === "coordinator")
      .forEach((creature) => this.setDestination(creature, this.randomNearTower()));
    this.syncPulse(0xffdd7a);
  }

  // ─── Events ───

  private addEvent(kind: ThrongEvent["kind"], text: string) {
    const stamp = new Date(Date.now()).toLocaleTimeString([], {
      minute: "2-digit",
      second: "2-digit",
    });
    this.eventLog.unshift({
      id: `${this.worldAge}-${Math.random()}`,
      time: stamp,
      kind,
      text,
    });
    this.eventLog = this.eventLog.slice(0, 12);
  }

  // ─── Emit ───

  private emitUpdate(force = false) {
    this.lastMetricEmit = this.worldAge;
    const glyphsPerSec = this.glyphsThisWindow.length / 5;

    const metrics: ThrongMetrics = {
      elapsed: this.worldAge,
      towerProgress: this.towerProgress,
      coordination: this.coordination,
      deliveryRate: this.deliveryRate,
      failedClaims: Math.round(this.failedClaims),
      callsSaved: this.callsSaved,
      strategyScore: this.strategyScore,
      activeBodies: this.creatures.length,
      activeDirectors: DIRECTOR_COUNT,
      activeStrategy: this.activeStrategy,
      latestTrace: this.latestTrace,
      mode: this.mindMode,
      intelligence: this.intelligence,
      phase: this.currentPhase,
      glyphsPerSec,
      uniqueTokens: this.globalVocabulary.size,
      crossed: this.crossed,
    };

    window.dispatchEvent(
      new CustomEvent("throng:update", {
        detail: {
          metrics,
          events: this.eventLog,
        },
      }),
    );

    if (force) this.lastMetricEmit = this.worldAge - 0.2;
  }
}

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: WIDTH,
  height: HEIGHT,
  parent: "game-root",
  backgroundColor: "#0b0d12",
  pixelArt: true,
  antialias: false,
  physics: {
    default: "arcade",
    arcade: {
      debug: false,
    },
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: WIDTH,
    height: HEIGHT,
  },
  scene: [ThrongScene],
};
