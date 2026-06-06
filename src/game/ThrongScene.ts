import Phaser from "phaser";
import type { Cohort, ThrongCommand, ThrongEvent, ThrongMetrics } from "./types";

type CreatureState = "idle" | "walking" | "claiming" | "carrying" | "depositing" | "stunned";

type ResourceNode = {
  id: number;
  x: number;
  y: number;
  sprite: Phaser.GameObjects.Image;
  claimedBy?: number;
  amount: number;
};

type Creature = {
  id: number;
  cohort: Cohort;
  sprite: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Ellipse;
  carryDot: Phaser.GameObjects.Ellipse;
  x: number;
  y: number;
  path: Phaser.Math.Vector2[];
  speed: number;
  carrying: boolean;
  targetResource?: ResourceNode;
  claimUntil: number;
  bubbleUntil: number;
  stunUntil: number;
  phase: number;
  state: CreatureState;
};

const WIDTH = 960;
const HEIGHT = 540;
const TOWER = { x: 486, y: 278 };
const DIRECTOR_COUNT = 7;
const BODY_COUNT = 52;

const COHORT_COLORS: Record<Cohort, number> = {
  scout: 0x8de8ff,
  gatherer: 0xffdd7a,
  builder: 0xa9ffb4,
  coordinator: 0xff9ce2,
  critic: 0xff827a,
  memory: 0xc4b5ff,
};

const COHORTS: Cohort[] = ["scout", "gatherer", "builder", "coordinator", "critic", "memory"];

const STRATEGIES = [
  "wide scout sweep",
  "nearest-carrier assignment",
  "two-hop relay routing",
  "claim backoff after collision",
  "builder-first deposit windows",
  "tower orbit synchronization",
];

const PATH_NODES = [
  { x: 304, y: 132 },
  { x: 650, y: 130 },
  { x: 760, y: 300 },
  { x: 620, y: 430 },
  { x: 340, y: 426 },
  { x: 206, y: 292 },
  { x: 388, y: 266 },
  { x: 576, y: 276 },
];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class ThrongScene extends Phaser.Scene {
  private creatures: Creature[] = [];
  private resources: ResourceNode[] = [];
  private eventLog: ThrongEvent[] = [];
  private tower!: Phaser.GameObjects.Container;
  private towerCore!: Phaser.GameObjects.Rectangle;
  private towerRings: Phaser.GameObjects.Rectangle[] = [];
  private routeLines!: Phaser.GameObjects.Graphics;
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
  private showClaims = true;
  private lastMetricEmit = 0;
  private lastStrategyAt = 0;
  private lastForcedTaskAt = 0;
  private finaleSent = false;

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
    this.effectLayer = this.add.graphics();
    this.bubbleLayer = this.add.container(0, 0);

    this.createTower();
    this.spawnResources(24);
    this.spawnCreatures(BODY_COUNT);

    this.addEvent("system", `${DIRECTOR_COUNT} director minds assigned to ${BODY_COUNT} game-world bodies`);
    this.addEvent("trace", "prototype mode: LLM, Redis, and Weave hooks are not live yet");
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

    this.updateCreatures(dt);
    this.updateResources();
    this.updateTower();
    this.updateMetrics(dt);
    this.drawRoutes();

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

    const vignette = this.add.graphics();
    vignette.fillStyle(0x030407, 0.2);
    vignette.fillRect(0, 0, WIDTH, HEIGHT);
  }

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

  private spawnResources(count: number) {
    for (let i = 0; i < count; i += 1) this.addResource();
  }

  private addResource() {
    const node = Phaser.Utils.Array.GetRandom(PATH_NODES);
    const x = clamp(node.x + Phaser.Math.Between(-78, 78), 46, WIDTH - 46);
    const y = clamp(node.y + Phaser.Math.Between(-54, 54), 46, HEIGHT - 46);
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

  private spawnCreatures(count: number) {
    for (let i = 0; i < count; i += 1) {
      const cohort = i < DIRECTOR_COUNT ? COHORTS[i % COHORTS.length] : Phaser.Math.RND.pick(COHORTS);
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const radius = Phaser.Math.Between(38, 96);
      const x = TOWER.x + Math.cos(angle) * radius;
      const y = TOWER.y + Math.sin(angle) * radius;
      const shadow = this.add.ellipse(x, y + 12, 18, 6, 0x000000, 0.36).setDepth(7);
      const sprite = this.add.image(x, y, `creature-${cohort}-0`).setScale(1.38).setDepth(10);
      sprite.setOrigin(0.5, 0.82);
      const carryDot = this.add.ellipse(x, y - 20, 7, 5, 0xe9ff9f, 0).setDepth(12);
      const creature: Creature = {
        id: i,
        cohort,
        sprite,
        shadow,
        carryDot,
        x,
        y,
        path: [],
        speed: Phaser.Math.FloatBetween(12, 22),
        carrying: false,
        claimUntil: 0,
        bubbleUntil: 0,
        stunUntil: 0,
        phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
        state: "idle",
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
      } else {
        this.walkPath(creature, dt);
      }

      const walking = creature.path.length > 0 && creature.state !== "stunned";
      const frame = walking && Math.sin(this.worldAge * 5.2 + creature.phase) > 0 ? 1 : 0;
      creature.sprite.setTexture(`creature-${creature.cohort}-${frame}`);
      creature.sprite.setPosition(creature.x, creature.y + Math.sin(this.worldAge * 3.8 + creature.phase) * 0.9);
      creature.shadow.setPosition(creature.x, creature.y + 12);
      creature.carryDot.setPosition(creature.x, creature.y - 24);
      creature.carryDot.setAlpha(creature.carrying ? 0.95 : 0);

      const target = creature.path[0];
      if (target) creature.sprite.setFlipX(target.x < creature.x);
      creature.sprite.setAlpha(creature.state === "stunned" ? 0.6 : 1);
      creature.sprite.setAngle(creature.state === "stunned" ? Math.sin(this.worldAge * 18) * 4 : 0);
      creature.sprite.setScale(creature.carrying ? 1.48 : 1.38);
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
      this.say(creature, "DELIVERED");
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
        this.setDestination(creature, {
          x: TOWER.x + Phaser.Math.Between(-26, 26),
          y: TOWER.y + Phaser.Math.Between(24, 58),
        });
        return;
      }
    }

    this.pickTask(creature);
  }

  private pickTask(creature: Creature) {
    if (creature.state === "stunned") return;

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
      if (target && this.tryClaimResource(creature, target)) {
        creature.targetResource = target;
        this.setDestination(creature, { x: target.x, y: target.y });
        return;
      }
    }

    const roamNode = Phaser.Utils.Array.GetRandom(PATH_NODES);
    this.setDestination(creature, {
      x: clamp(roamNode.x + Phaser.Math.Between(-44, 44), 34, WIDTH - 34),
      y: clamp(roamNode.y + Phaser.Math.Between(-32, 32), 34, HEIGHT - 34),
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

    if (resource.claimedBy !== undefined && resource.claimedBy !== creature.id) {
      this.rejectClaim(creature, resource, `resource:${resource.id} already locked`);
      return false;
    }

    const successChance = clamp(0.62 + this.coordination * 0.3, 0.62, 0.93);
    if (Phaser.Math.FloatBetween(0, 1) <= successChance) {
      resource.claimedBy = creature.id;
      if (this.showClaims && Phaser.Math.FloatBetween(0, 1) < 0.34) {
        this.say(creature, "LOCK OK");
        this.addEvent("claim", `Redis SET NX claim won: resource:${resource.id} -> body:${creature.id}`);
      }
      return true;
    }

    this.rejectClaim(creature, resource, `resource:${resource.id} rejected duplicate worker`);
    return false;
  }

  private rejectClaim(creature: Creature, resource: ResourceNode, text: string) {
    this.failedClaims += 1;
    creature.state = "stunned";
    creature.stunUntil = this.worldAge + 0.9;
    creature.path = [];
    this.flashAt(resource.x, resource.y, 0xff7676, 8);
    this.drawClaimBurst(resource.x, resource.y);
    this.say(creature, "LOCK FAIL");
    this.addEvent("claim", `claim collision: ${text}`);
  }

  private setDestination(creature: Creature, target: { x: number; y: number }) {
    const node = PATH_NODES.reduce((best, item) => (distance(creature, item) < distance(creature, best) ? item : best));
    const targetNode = PATH_NODES.reduce((best, item) => (distance(target, item) < distance(target, best) ? item : best));
    const path: Phaser.Math.Vector2[] = [];

    if (distance(creature, node) > 44) path.push(new Phaser.Math.Vector2(node.x, node.y));
    if (node !== targetNode && distance(node, targetNode) > 60) {
      const mid = {
        x: (node.x + targetNode.x) / 2 + Phaser.Math.Between(-18, 18),
        y: (node.y + targetNode.y) / 2 + Phaser.Math.Between(-12, 12),
      };
      path.push(new Phaser.Math.Vector2(mid.x, mid.y));
    }
    if (distance(target, targetNode) > 34) path.push(new Phaser.Math.Vector2(targetNode.x, targetNode.y));
    path.push(new Phaser.Math.Vector2(target.x, target.y));

    creature.path = path;
  }

  private randomNearTower() {
    return {
      x: TOWER.x + Phaser.Math.Between(-64, 64),
      y: TOWER.y + Phaser.Math.Between(-52, 66),
    };
  }

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
    this.addEvent("strategy", `Critic stored improved strategy: ${this.activeStrategy}`);
    this.addEvent("trace", `Weave placeholder: strategy score ${this.strategyScore.toFixed(2)}`);
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

  private say(creature: Creature, text: string) {
    if (this.worldAge < creature.bubbleUntil) return;
    creature.bubbleUntil = this.worldAge + 3.2;
    const bubble = this.add.container(creature.x, creature.y - 26).setDepth(30);
    const label = this.add.text(0, 0, text, {
      fontFamily: "monospace",
      fontSize: "8px",
      color: "#eafff7",
      backgroundColor: "rgba(8, 12, 18, 0.86)",
      padding: { x: 4, y: 2 },
    });
    label.setOrigin(0.5);
    bubble.add(label);
    this.bubbleLayer.add(bubble);
    this.tweens.add({
      targets: bubble,
      y: bubble.y - 16,
      alpha: 0,
      duration: 1500,
      ease: "Sine.easeOut",
      onComplete: () => bubble.destroy(),
    });
  }

  private broadcastFinale() {
    this.finaleSent = true;
    this.towerProgress = 1;
    this.addEvent("tower", "Signal Tower online: collective broadcast generated");
    this.addEvent("message", "collective broadcast: WE LEARN FASTER WHEN YOU WATCH US BUILD");
    this.syncPulse(0xffffff);
  }

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
      case "toggle_claims":
        this.showClaims = !this.showClaims;
        this.addEvent("system", `claim route overlay ${this.showClaims ? "enabled" : "disabled"}`);
        break;
    }
    this.emitUpdate(true);
  };

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
    this.eventLog = this.eventLog.slice(0, 8);
  }

  private emitUpdate(force = false) {
    this.lastMetricEmit = this.worldAge;
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
      mode: "visual-prototype",
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
