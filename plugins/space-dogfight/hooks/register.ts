import type { Register } from 'claude-code'
import { band, Gfx, mix, rand, randInt, type Scene } from './kit'

// A starfighter dogfight in the band above the prompt while a model turn runs: a rebel
// fighter in Claude-orange stripes holds the left of the screen and shoots down dark enemy
// interceptors weaving in from the right, over a scrolling starfield and nebulae.

const SKY_TOP = 0x05070e
const SKY_BOTTOM = 0x0a0f1d
const HULL = 0xe6e8ee
const HULL_SHADE = 0x9aa1ad
const WING = 0x8a919c
const STRIPE = 0xd97757
const CANOPY = 0x4fc8ff
const ENGINE = 0xff8a3d
const ENEMY_HULL = 0x4a525f
const ENEMY_WING = 0x7d8796
const ENEMY_EYE = 0xff3b3b
const HERO_LASER = 0xff4636
const ENEMY_LASER = 0x52ff5e
const SHIELD = 0x7fd4ff
const SCORE = 0xd97757

const FIGHTER_W = 13
const FIGHTER_H = 6
const ENEMY_W = 8
const ENEMY_H = 6

type Enemy = { x: number; y: number; vx: number; holdX: number; phase: number; wobble: number; cooldown: number }
type Bolt = { x: number; y: number; vx: number; fromHero: boolean }
type Blast = { x: number; y: number; age: number; size: number }
type Spark = { x: number; y: number; vx: number; vy: number; life: number; max: number }
type Star = { x: number; y: number; layer: number; tw: number }

class Dogfight implements Scene {
  private readonly heroX = 3
  private readonly maxEnemies: number
  private readonly stars: Star[]
  private readonly nebulae: Array<{ x: number; y: number; r: number; color: number }>
  private heroY: number
  private enemies: Enemy[] = []
  private bolts: Bolt[] = []
  private blasts: Blast[] = []
  private sparks: Spark[] = []
  private cooldown = 8
  private shield = 0
  private spawnIn = 6
  private frameNo = 0
  private kills = 0

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.heroY = (height - FIGHTER_H) / 2
    this.maxEnemies = Math.max(1, Math.min(4, Math.floor((width - 30) / 18) + 1))
    this.stars = Array.from({ length: Math.ceil((width * height) / 45) }, () => ({
      x: rand(0, width),
      y: rand(0, height),
      layer: randInt(0, 2),
      tw: rand(0, 6.28),
    }))
    this.nebulae = [
      { x: width * 0.35, y: height * 0.3, r: height * 1.6, color: 0x3a1d5c },
      { x: width * 0.8, y: height * 0.8, r: height * 1.3, color: 0x0f3b4a },
    ]
  }

  private get maxY(): number {
    return Math.max(0, this.height - FIGHTER_H)
  }

  step(): void {
    this.frameNo += 1
    for (const star of this.stars) {
      star.x -= [0.12, 0.3, 0.75][star.layer] ?? 0.3
      if (star.x < -2) {
        star.x += this.width + 2
        star.y = rand(0, this.height)
      }
    }
    for (const n of this.nebulae) {
      n.x -= 0.02
      if (n.x < -n.r) n.x = this.width + n.r
    }
    this.stepHero()
    this.stepEnemies()
    this.stepBolts()
    for (const b of this.blasts) b.age += 1
    this.blasts = this.blasts.filter(b => b.age < 14)
    for (const p of this.sparks) {
      p.x += p.vx
      p.y += p.vy
      p.vx *= 0.93
      p.vy *= 0.93
      p.life -= 1
    }
    this.sparks = this.sparks.filter(p => p.life > 0)
  }

  // Chase the nearest interceptor's line, weaving a little; fire when lined up.
  private stepHero(): void {
    if (this.shield > 0) this.shield -= 1
    this.cooldown -= 1
    const target = this.enemies.filter(e => e.x < this.width - ENEMY_W - 2).sort((a, b) => a.x - b.x)[0]
    const bob = Math.sin(this.frameNo / 9) * 0.8
    const wanted = target ? target.y + (ENEMY_H - FIGHTER_H) / 2 : this.maxY / 2 + bob
    this.heroY += Math.max(-0.4, Math.min(0.4, wanted - this.heroY))
    this.heroY = Math.max(0, Math.min(this.maxY, this.heroY))
    if (target && this.cooldown <= 0 && Math.abs(target.y + ENEMY_H / 2 - (this.heroY + FIGHTER_H / 2)) < 1.4) {
      const cy = this.heroY + FIGHTER_H / 2
      this.bolts.push({ x: this.heroX + FIGHTER_W, y: cy, vx: 2.6, fromHero: true })
      this.cooldown = randInt(9, 16)
    }
  }

  private stepEnemies(): void {
    this.spawnIn -= 1
    if (this.spawnIn <= 0 && this.enemies.length < this.maxEnemies) {
      this.enemies.push({
        x: this.width + 1,
        y: rand(0, Math.max(0, this.height - ENEMY_H)),
        vx: -rand(0.4, 0.9),
        holdX: rand(this.heroX + FIGHTER_W + 18, Math.max(this.heroX + FIGHTER_W + 19, this.width - 12)),
        phase: rand(0, Math.PI * 2),
        wobble: rand(0.6, 2),
        cooldown: randInt(15, 35),
      })
      this.spawnIn = randInt(14, 34)
    }
    for (const e of this.enemies) {
      e.phase += 0.1
      // Fly in to a station in front of the fighter, then strafe up and down there.
      if (e.x > e.holdX) e.x += e.vx
      else e.x += Math.sin(e.phase * 0.4) * 0.15
      e.y = Math.max(0, Math.min(this.height - ENEMY_H, e.y + Math.sin(e.phase) * e.wobble * 0.15))
      e.cooldown -= 1
      if (e.cooldown <= 0 && e.x < this.width - 6) {
        this.bolts.push({ x: e.x, y: e.y + ENEMY_H / 2, vx: -2, fromHero: false })
        e.cooldown = randInt(25, 55)
      }
    }
  }

  private stepBolts(): void {
    const kept: Bolt[] = []
    for (const bolt of this.bolts) {
      bolt.x += bolt.vx
      if (bolt.x < -4 || bolt.x > this.width + 4) continue
      if (bolt.fromHero) {
        const hit = this.enemies.find(
          e => e.x < this.width - ENEMY_W && bolt.x >= e.x && bolt.x <= e.x + ENEMY_W && bolt.y >= e.y && bolt.y <= e.y + ENEMY_H,
        )
        if (hit) {
          this.enemies = this.enemies.filter(e => e !== hit)
          this.kills += 1
          this.explode(hit.x + ENEMY_W / 2, hit.y + ENEMY_H / 2, 3.2, 16)
          continue
        }
      } else if (bolt.x <= this.heroX + FIGHTER_W && bolt.y >= this.heroY && bolt.y <= this.heroY + FIGHTER_H) {
        this.shield = 6
        this.explode(this.heroX + FIGHTER_W - 1, bolt.y, 1.2, 5)
        continue
      }
      kept.push(bolt)
    }
    this.bolts = kept
  }

  private explode(x: number, y: number, size: number, n: number): void {
    this.blasts.push({ x, y, age: 0, size })
    for (let i = 0; i < n; i++) {
      const angle = rand(0, Math.PI * 2)
      const speed = rand(0.2, 1.1) * size * 0.5
      const life = randInt(6, 14)
      this.sparks.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed * 0.6, life, max: life })
    }
  }

  draw(g: Gfx): void {
    g.sky(SKY_TOP, SKY_BOTTOM)
    for (const n of this.nebulae) g.glow(n.x, n.y, n.r, n.color, 0.55, 0.45)
    for (const star of this.stars) {
      const tw = 0.6 + 0.4 * Math.sin(star.tw + this.frameNo * 0.15)
      const color = [0x5c6577, 0x9aa6bb, 0xe8eeff][star.layer] ?? 0x9aa6bb
      if (star.layer === 2) g.line(star.x, star.y, star.x + 0.9, star.y, 0.1, color, 0.45)
      else g.disc(star.x, star.y, 0.08 + star.layer * 0.05, color, tw)
    }
    for (const e of this.enemies) this.drawEnemy(g, e.x, e.y)
    this.drawFighter(g, this.heroX, this.heroY)
    for (const bolt of this.bolts) {
      const dir = Math.sign(bolt.vx)
      const color = bolt.fromHero ? HERO_LASER : ENEMY_LASER
      g.glow(bolt.x - dir * 1.3, bolt.y, 2.6, color, 1.3, 0.3)
      g.line(bolt.x - dir * 2.6, bolt.y, bolt.x, bolt.y, 0.26, mix(color, 0xffffff, 0.55), 1, 0.8)
    }
    for (const b of this.blasts) {
      const t = b.age / 14
      g.glow(b.x, b.y, b.size * (0.6 + t * 1.6), 0xff7a2a, 1.6 * (1 - t))
      g.glow(b.x, b.y, b.size * (0.3 + t * 0.7), 0xffe7a0, 1.8 * (1 - t) * (1 - t))
      if (b.age < 8) g.ring(b.x, b.y, b.size * (0.4 + t * 2.4), 0.18, 0xffd9a0, 0.7 * (1 - t * 1.7))
    }
    for (const p of this.sparks) {
      const t = 1 - p.life / p.max
      const color = t < 0.3 ? 0xfff0b0 : t < 0.6 ? 0xffa040 : 0xd9452b
      g.line(p.x - p.vx * 1.5, p.y - p.vy * 1.5, p.x, p.y, 0.16, color, 1 - t * 0.6)
    }
    const label = `KO ${this.kills}`
    g.text(label, this.width - label.length * 1.2 - 1, 0.6, 0.3, SCORE, 0.85)
  }

  private drawFighter(g: Gfx, x: number, y: number): void {
    const cy = y + FIGHTER_H / 2
    const flick = 0.7 + Math.random() * 0.6
    // engine plume
    g.glow(x + 0.6, cy, 3.2 * flick, ENGINE, 0.9, 0.35)
    g.poly([x + 1, cy - 0.55, x - 1.8 * flick, cy, x + 1, cy + 0.55], 0xffd27a, 0.9)
    // wings: swept back, orange edge, cannons at the tips
    for (const side of [-1, 1]) {
      const tip = cy + side * 2.8
      g.poly([x + 2.4, cy + side * 0.5, x + 7.2, cy + side * 0.6, x + 4.4, tip, x + 1.6, tip], WING)
      g.poly([x + 1.6, tip, x + 4.4, tip, x + 4.1, tip - side * 0.5, x + 1.5, tip - side * 0.5], STRIPE)
      g.line(x + 1.2, tip - side * 0.25, x + 6.6, tip - side * 0.25, 0.22, 0xc9ced6)
      g.disc(x + 1.3, tip - side * 0.25, 0.3, 0x3a3f48)
    }
    // fuselage with a lower shade and a stripe
    g.poly([x + 0.8, cy - 0.95, x + 9, cy - 0.85, x + FIGHTER_W, cy, x + 9, cy + 0.85, x + 0.8, cy + 0.95], HULL)
    g.poly([x + 0.8, cy + 0.2, x + 10, cy + 0.2, x + FIGHTER_W, cy, x + 9, cy + 0.85, x + 0.8, cy + 0.95], HULL_SHADE, 0.55)
    g.poly([x + 2, cy - 0.12, x + 9.4, cy - 0.08, x + 9.4, cy + 0.12, x + 2, cy + 0.14], STRIPE)
    g.disc(x + 1, cy, 0.62, 0x2a2e36)
    // canopy with a glint
    g.poly([x + 6.6, cy - 0.15, x + 7.4, cy - 0.75, x + 9.3, cy - 0.65, x + 10, cy - 0.15], CANOPY)
    g.disc(x + 8.4, cy - 0.5, 0.16, 0xffffff, 0.9)
    if (this.shield > 0) g.glow(x + FIGHTER_W / 2, cy, FIGHTER_W * 0.62, SHIELD, 0.12 * this.shield, 0.45)
  }

  private drawEnemy(g: Gfx, x: number, y: number): void {
    const cy = y + ENEMY_H / 2
    g.glow(x + ENEMY_W - 1.2, cy, 2, 0xb04cff, 0.5, 0.5)
    // blade wings, forward swept
    for (const side of [-1, 1]) {
      g.poly([x + 3.2, cy + side * 0.7, x + 6.8, cy + side * 2.9, x + 7.9, cy + side * 2.6, x + 5.2, cy + side * 0.4], ENEMY_WING)
      g.line(x + 6.8, cy + side * 2.9, x + 7.9, cy + side * 2.6, 0.16, 0xb8c0cc)
    }
    // spike nose and pod
    g.poly([x + 3, cy - 0.6, x, cy, x + 3, cy + 0.6], ENEMY_HULL)
    g.disc(x + 4.2, cy, 1.45, ENEMY_HULL)
    g.disc(x + 3.9, cy - 0.45, 0.6, 0x6c7684, 0.8)
    // sensor eye
    g.disc(x + 2.9, cy, 0.42, ENEMY_EYE)
    g.glow(x + 2.9, cy, 1.6, ENEMY_EYE, 0.8)
  }
}

export const register: Register = on =>
  band(on, {
    key: 'dogfight',
    alt: ' ',
    rows: 7,
    minColumns: 30,
    background: SKY_BOTTOM,
    make: (width, height) => new Dogfight(width, height),
  })
