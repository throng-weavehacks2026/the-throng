import Phaser from "phaser";
import type { Cohort, ThrongCommand, ThrongEvent, ThrongMetrics } from "./types";

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
  x: number;
  y: number;
  tx: number;
  ty: number;
  speed: number;
  carrying: boolean;
  targetResource?: ResourceNode;
  claimUntil: number;
  thoughtUntil: number;
};

const WIDTH = 960;
const HEIGHT = 540;
const TOWER = { x: 485, y: 262 };

const COHORT_COLORS: Record<Cohort, number> = {
  scout: 0x87e7ff,
  gatherer: 0xffd166,
  builder: 0x9cffb0,
  coordinator: 0xff8bd1,
  critic: 0xff7a74,
  memory: 0xb8a7ff,
};

const STRATEGIES = [
  "wide scout sweep",
  "nearest-carrier assignment",
  "relay gathering line",
  "builder-first deposits",
  "failed-claim backoff",
  "tower orbit synchronization",
];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
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
  private towerProgress = 0;
  private deposits = 0;
  private failedClaims = 14;
  private callsSaved = 0.18;
  private strategyScore = 0.34;
  private coordination = 0.28;
  private deliveryRate = 0;
  private activeStrategy = STRATEGIES[0];
  private latestTrace = "weave://pending/scout-001";
  private showClaims = true;
  private lastMetricEmit = 0;
  private lastStrategyAt = 0;

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
    this.spawnResources(34);
    this.spawnCreatures(118);

    this.addEvent("system", "simulation booted: 7 director minds controlling 118 rendered thronglets");
    this.addEvent("trace", "Weave trace placeholder opened for ScoutDirector decision loop");
    this.emitUpdate(true);

    window.addEventListener("throng:command", this.onCommand);
  }

  shutdown() {
    window.removeEventListener("throng:command", this.onCommand);
  }

  update(_time: number, delta: number) {
    const dt = delta / 1000;
    this.worldAge += dt;

    this.updateCreatures(dt);
    this.updateResources();
    this.updateTower();
    this.updateMetrics(dt);
    this.drawRoutes();

    if (this.worldAge - this.lastStrategyAt > 13) {
      this.improveStrategy();
    }

    if (this.worldAge - this.lastMetricEmit > 0.35) {
      this.emitUpdate();
    }
  }

  private createTextures() {
    const makeCreature = (key: string, color: number) => {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(color, 1);
      g.fillRect(2, 1, 4, 1);
      g.fillRect(1, 2, 6, 3);
      g.fillRect(2, 5, 4, 1);
      g.fillStyle(0x0b0d12, 1);
      g.fillRect(2, 3, 1, 1);
      g.fillRect(5, 3, 1, 1);
      g.generateTexture(key, 8, 7);
      g.destroy();
    };

    Object.entries(COHORT_COLORS).forEach(([cohort, color]) => {
      makeCreature(`creature-${cohort}`, color);
    });

    const res = this.make.graphics({ x: 0, y: 0 }, false);
    res.fillStyle(0xd8f66e, 1);
    res.fillRect(2, 1, 4, 2);
    res.fillRect(1, 3, 6, 3);
    res.fillStyle(0x82b93b, 1);
    res.fillRect(3, 2, 2, 1);
    res.generateTexture("resource", 8, 7);
    res.destroy();
  }

  private drawTerrain() {
    const grid = this.add.graphics();
    grid.fillStyle(0x10141d, 1);
    grid.fillRect(0, 0, WIDTH, HEIGHT);

    for (let y = 0; y < HEIGHT; y += 12) {
      for (let x = 0; x < WIDTH; x += 12) {
        const noise = Phaser.Math.Between(0, 3);
        grid.fillStyle(noise === 0 ? 0x111722 : noise === 1 ? 0x0e141b : 0x121923, 1);
        grid.fillRect(x, y, 11, 11);
      }
    }

    grid.lineStyle(1, 0x263040, 0.25);
    for (let x = 0; x <= WIDTH; x += 24) grid.lineBetween(x, 0, x, HEIGHT);
    for (let y = 0; y <= HEIGHT; y += 24) grid.lineBetween(0, y, WIDTH, y);

    const fog = this.add.graphics();
    fog.fillStyle(0x030407, 0.26);
    fog.fillRect(0, 0, WIDTH, HEIGHT);
  }

  private createTower() {
    this.tower = this.add.container(TOWER.x, TOWER.y);
    const base = this.add.rectangle(0, 50, 86, 12, 0x30364a, 1);
    const mast = this.add.rectangle(0, 13, 18, 86, 0x5a637f, 1);
    const cap = this.add.rectangle(0, -34, 50, 8, 0x6f7da0, 1);
    this.towerCore = this.add.rectangle(0, -5, 10, 10, 0xc9fff2, 1);
    this.tower.add([base, mast, cap, this.towerCore]);

    for (let i = 0; i < 5; i += 1) {
      const ring = this.add.rectangle(0, 45 - i * 17, 28 + i * 18, 3, 0x8fa4d6, 0.16);
      this.towerRings.push(ring);
      this.tower.add(ring);
    }

    this.tweens.add({
      targets: this.towerCore,
      alpha: 0.35,
      yoyo: true,
      repeat: -1,
      duration: 760,
      ease: "Sine.easeInOut",
    });
  }

  private spawnResources(count: number) {
    for (let i = 0; i < count; i += 1) {
      this.addResource();
    }
  }

  private addResource() {
    const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
    const dist = Phaser.Math.Between(115, 235);
    const x = clamp(TOWER.x + Math.cos(angle) * dist + Phaser.Math.Between(-90, 90), 38, WIDTH - 38);
    const y = clamp(TOWER.y + Math.sin(angle) * dist + Phaser.Math.Between(-60, 60), 38, HEIGHT - 38);
    const sprite = this.add.image(x, y, "resource").setScale(1.5).setDepth(4);
    sprite.setTint(Phaser.Math.RND.pick([0xcaf66f, 0x9fe870, 0x80f0b2]));
    this.tweens.add({
      targets: sprite,
      scale: 1.75,
      yoyo: true,
      repeat: -1,
      duration: Phaser.Math.Between(900, 1500),
      ease: "Sine.easeInOut",
    });
    this.resources.push({ id: Phaser.Math.Between(1000, 9999), x, y, sprite, amount: 1 });
  }

  private spawnCreatures(count: number) {
    const cohorts: Cohort[] = ["scout", "gatherer", "builder", "coordinator", "critic", "memory"];
    for (let i = 0; i < count; i += 1) {
      const cohort = i < 8 ? cohorts[i % cohorts.length] : Phaser.Math.RND.pick(cohorts);
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const radius = Phaser.Math.Between(54, 180);
      const x = TOWER.x + Math.cos(angle) * radius;
      const y = TOWER.y + Math.sin(angle) * radius;
      const shadow = this.add.ellipse(x, y + 5, 8, 3, 0x000000, 0.28).setDepth(5);
      const sprite = this.add.image(x, y, `creature-${cohort}`).setScale(1.35).setDepth(8);
      sprite.setOrigin(0.5, 0.7);
      const creature: Creature = {
        id: i,
        cohort,
        sprite,
        shadow,
        x,
        y,
        tx: x,
        ty: y,
        speed: Phaser.Math.FloatBetween(30, 54),
        carrying: false,
        claimUntil: 0,
        thoughtUntil: 0,
      };
      this.creatures.push(creature);
      this.pickTask(creature);
    }
  }

  private updateCreatures(dt: number) {
    for (const creature of this.creatures) {
      const dx = creature.tx - creature.x;
      const dy = creature.ty - creature.y;
      const dist = Math.hypot(dx, dy);
      const step = creature.speed * dt;

      if (dist > 2) {
        creature.x += (dx / dist) * Math.min(step, dist);
        creature.y += (dy / dist) * Math.min(step, dist);
      } else {
        this.resolveArrival(creature);
      }

      creature.sprite.setPosition(creature.x, creature.y + Math.sin(this.worldAge * 9 + creature.id) * 0.9);
      creature.shadow.setPosition(creature.x, creature.y + 5);
      creature.sprite.setFlipX(dx < 0);

      const bob = creature.carrying ? 1.58 : 1.35 + Math.sin(this.worldAge * 7 + creature.id) * 0.05;
      creature.sprite.setScale(bob);
      if (creature.carrying) {
        creature.sprite.setTint(0xffffaa);
      } else {
        creature.sprite.clearTint();
      }
    }
  }

  private resolveArrival(creature: Creature) {
    if (creature.carrying) {
      const distanceToTower = Math.hypot(creature.x - TOWER.x, creature.y - TOWER.y);
      if (distanceToTower < 38) {
        creature.carrying = false;
        this.deposits += 1;
        this.towerProgress = clamp(this.towerProgress + Phaser.Math.FloatBetween(0.018, 0.032), 0, 1);
        this.deliveryRate = lerp(this.deliveryRate, 0.72 + this.strategyScore * 0.25, 0.16);
        this.flashAt(TOWER.x, TOWER.y, 0xc9fff2);
        if (this.deposits % 5 === 0) {
          this.addEvent("tower", `Signal Tower stage ${Math.min(5, Math.ceil(this.towerProgress * 5))}/5 assembled`);
          this.sayNear(TOWER.x, TOWER.y, "DEPOSIT OK");
        }
      }
    }

    if (creature.targetResource && !creature.carrying) {
      const resource = creature.targetResource;
      const distanceToResource = Math.hypot(creature.x - resource.x, creature.y - resource.y);
      if (distanceToResource < 14 && resource.amount > 0) {
        resource.amount = 0;
        resource.sprite.destroy();
        this.resources = this.resources.filter((item) => item !== resource);
        creature.carrying = true;
        creature.targetResource = undefined;
        creature.tx = TOWER.x + Phaser.Math.Between(-28, 28);
        creature.ty = TOWER.y + Phaser.Math.Between(18, 60);
        this.flashAt(creature.x, creature.y, 0xffd166);
      }
    }

    if (!creature.carrying) {
      this.pickTask(creature);
    } else {
      creature.tx = TOWER.x + Phaser.Math.Between(-28, 28);
      creature.ty = TOWER.y + Phaser.Math.Between(18, 60);
    }
  }

  private pickTask(creature: Creature) {
    if (creature.cohort === "builder" || creature.carrying) {
      creature.tx = TOWER.x + Phaser.Math.Between(-42, 42);
      creature.ty = TOWER.y + Phaser.Math.Between(20, 72);
      return;
    }

    const available = this.resources.filter((resource) => resource.amount > 0 && !resource.claimedBy);
    if (available.length > 0 && Phaser.Math.FloatBetween(0, 1) < 0.78) {
      const target = Phaser.Utils.Array.GetRandom(available);
      if (this.tryClaimResource(creature, target)) {
        creature.targetResource = target;
        creature.tx = target.x + Phaser.Math.Between(-5, 5);
        creature.ty = target.y + Phaser.Math.Between(-5, 5);
        return;
      }
    }

    const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
    const radius = creature.cohort === "scout" ? Phaser.Math.Between(120, 245) : Phaser.Math.Between(48, 155);
    creature.tx = clamp(TOWER.x + Math.cos(angle) * radius, 24, WIDTH - 24);
    creature.ty = clamp(TOWER.y + Math.sin(angle) * radius, 24, HEIGHT - 24);
  }

  private tryClaimResource(creature: Creature, resource: ResourceNode) {
    const contention = Phaser.Math.FloatBetween(0, 1);
    const successChance = clamp(0.54 + this.coordination * 0.38, 0.55, 0.92);
    if (contention < successChance) {
      resource.claimedBy = creature.id;
      creature.claimUntil = this.worldAge + 2.8;
      if (this.showClaims && Phaser.Math.FloatBetween(0, 1) < 0.16) {
        this.say(creature, "CLAIM NX");
        this.addEvent("claim", `Redis SET NX claim won: task resource:${resource.id} -> thronglet:${creature.id}`);
      }
      return true;
    }

    this.failedClaims += 1;
    if (this.showClaims && Phaser.Math.FloatBetween(0, 1) < 0.26) {
      this.say(creature, "CLAIM FAIL");
      this.addEvent("claim", `claim collision: resource:${resource.id} rejected duplicate worker`);
    }
    return false;
  }

  private updateResources() {
    if (this.resources.length < 28 && Phaser.Math.FloatBetween(0, 1) < 0.035) {
      this.addResource();
    }

    for (const resource of this.resources) {
      if (resource.claimedBy !== undefined) {
        const owner = this.creatures[resource.claimedBy];
        if (!owner || owner.carrying || owner.targetResource !== resource) {
          resource.claimedBy = undefined;
        }
      }
    }
  }

  private updateTower() {
    this.towerCore.setScale(1 + this.towerProgress * 2.9);
    this.towerCore.setFillStyle(this.towerProgress > 0.84 ? 0xffffff : 0xc9fff2, 1);

    this.towerRings.forEach((ring, index) => {
      const threshold = (index + 1) / this.towerRings.length;
      ring.setAlpha(this.towerProgress >= threshold ? 0.85 : 0.12 + this.towerProgress * 0.2);
      ring.width = 28 + index * 18 + this.towerProgress * 16;
    });

    if (this.towerProgress >= 0.99 && Phaser.Math.FloatBetween(0, 1) < 0.015) {
      this.broadcastFinale();
    }
  }

  private updateMetrics(dt: number) {
    this.coordination = clamp(lerp(this.coordination, 0.35 + this.strategyScore * 0.52, dt * 0.08), 0, 0.96);
    this.callsSaved = clamp(this.callsSaved + dt * 0.004, 0.18, 0.77);
    this.failedClaims = Math.max(0, this.failedClaims - dt * this.strategyScore * 0.13);
  }

  private improveStrategy() {
    this.lastStrategyAt = this.worldAge;
    const nextIndex = Math.min(STRATEGIES.length - 1, Math.floor(this.strategyScore * STRATEGIES.length));
    this.activeStrategy = STRATEGIES[nextIndex];
    this.strategyScore = clamp(this.strategyScore + Phaser.Math.FloatBetween(0.045, 0.09), 0, 0.96);
    this.latestTrace = `weave://trace/strategy-${Math.floor(this.worldAge)}-${nextIndex}`;
    this.addEvent("strategy", `Critic stored improved strategy: ${this.activeStrategy}`);
    this.addEvent("trace", `Weave traced reflection -> score ${this.strategyScore.toFixed(2)}`);
    this.syncPulse(0xb8a7ff);
  }

  private drawRoutes() {
    this.routeLines.clear();
    if (!this.showClaims) return;

    this.routeLines.lineStyle(1, 0x89f7ff, 0.18);
    for (const creature of this.creatures) {
      if (creature.targetResource && this.worldAge < creature.claimUntil) {
        this.routeLines.lineBetween(creature.x, creature.y, creature.targetResource.x, creature.targetResource.y);
      }
      if (creature.carrying && creature.id % 4 === 0) {
        this.routeLines.lineStyle(1, 0xffd166, 0.14);
        this.routeLines.lineBetween(creature.x, creature.y, TOWER.x, TOWER.y);
      }
    }
  }

  private flashAt(x: number, y: number, color: number) {
    const ring = this.add.circle(x, y, 4, color, 0.32).setDepth(20);
    this.tweens.add({
      targets: ring,
      scale: 5,
      alpha: 0,
      duration: 520,
      ease: "Cubic.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  private syncPulse(color: number) {
    for (const creature of this.creatures.filter((item) => item.id % 5 === 0)) {
      this.tweens.add({
        targets: creature.sprite,
        scale: 2.2,
        yoyo: true,
        duration: 180,
        ease: "Sine.easeOut",
      });
      this.flashAt(creature.x, creature.y, color);
    }
  }

  private say(creature: Creature, text: string) {
    if (this.worldAge < creature.thoughtUntil) return;
    creature.thoughtUntil = this.worldAge + 3;
    const bubble = this.add.container(creature.x, creature.y - 18).setDepth(30);
    const label = this.add.text(0, 0, text, {
      fontFamily: "monospace",
      fontSize: "7px",
      color: "#eafff7",
      backgroundColor: "rgba(8, 12, 18, 0.82)",
      padding: { x: 3, y: 2 },
    });
    label.setOrigin(0.5);
    bubble.add(label);
    this.bubbleLayer.add(bubble);
    this.tweens.add({
      targets: bubble,
      y: bubble.y - 14,
      alpha: 0,
      duration: 1400,
      ease: "Sine.easeOut",
      onComplete: () => bubble.destroy(),
    });
  }

  private sayNear(x: number, y: number, text: string) {
    const nearest = this.creatures
      .slice()
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
    if (nearest) this.say(nearest, text);
  }

  private broadcastFinale() {
    if (this.eventLog.some((event) => event.text.includes("collective broadcast"))) return;
    this.addEvent("tower", "Signal Tower online: collective broadcast generated");
    this.addEvent("message", "collective broadcast: WE LEARN FASTER WHEN YOU WATCH US BUILD");
    this.syncPulse(0xffffff);
  }

  private onCommand = (event: CustomEvent<ThrongCommand>) => {
    switch (event.detail.type) {
      case "drop_resources":
        this.spawnResources(10);
        this.addEvent("system", "player dropped extra signal shards into the field");
        break;
      case "stress_test":
        this.failedClaims += 8;
        this.coordination = clamp(this.coordination - 0.12, 0, 1);
        this.addEvent("system", "stress test injected: task contention increased");
        this.syncPulse(0xff7a74);
        break;
      case "boost_coordination":
        this.strategyScore = clamp(this.strategyScore + 0.1, 0, 1);
        this.addEvent("strategy", "player accepted Critic recommendation: tighter relay routing");
        this.syncPulse(0x9cffb0);
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
      activeCreatures: this.creatures.length,
      activeStrategy: this.activeStrategy,
      latestTrace: this.latestTrace,
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
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: WIDTH,
    height: HEIGHT,
  },
  scene: [ThrongScene],
};
