import type { EngineInterface, Register, Timer } from 'claude-code'

// A starfighter dogfight in the band above the prompt while a model turn runs: a rebel
// fighter in Claude-orange stripes holds the left of the screen and shoots down dark enemy
// interceptors weaving in from the right, over a scrolling starfield. Drawn with half blocks
// (two pixels per cell, true colour); the row disappears when the turn ends.

const FRAME_MS = 60
const BAND_ROWS = 7
const MAX_DENIES = 20 // consecutive refused blits before the loop parks itself
const PARK_MS = 500 // while parked, how often to ask for a redraw of the band
const RASTER_KEY = 'dogfight'
const MAX_COLUMNS = 512
const MIN_COLUMNS = 30

const DEFAULT_COLOR = 0x01000000
const EMPTY = DEFAULT_COLOR
const SPACE = 0x20
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584

const PALETTE: Record<string, number> = {
  W: 0xe8e8ec, // hull
  G: 0x8a8f98, // wings
  O: 0xd97757, // stripes, Claude orange
  C: 0x5ad1ff, // canopy
  S: 0x9aa6b6, // interceptor plating
  s: 0x58616e, // interceptor edges
  R: 0xff4040, // interceptor sensor light
}

// 12 x 5, facing right; the cannon fires from the nose, the engine glows at the tail.
const FIGHTER = [
  '.OOO........',
  '..GGGG......',
  '.WWWWWWWCCWW',
  '..GGGG......',
  '.OOO........',
]
// 7 x 5, facing left.
const INTERCEPTOR = [
  '....ss.',
  '..sSSSS',
  'RSSSSSS',
  '..sSSSS',
  '....ss.',
]

const ENGINE = [0xffd27a, 0xff8a3d, 0xff5a2a]
const HERO_BOLT = [0xffffff, 0xff5040, 0xe02a1e, 0x9c1a12]
const ENEMY_BOLT = [0xffffff, 0x6dff6a, 0x2fd13a]
const BLAST = [0xffffff, 0xfff2a8, 0xffc04a, 0xff7a2a, 0xd9452b, 0x7a2a1c]
const SHIELD = 0x8fd8ff
const STARS = [0x343841, 0x555c68, 0x8f97a5] // far, mid, near
const SCORE_COLOR = 0xa8552f

type Sprite = { w: number; h: number; px: Uint32Array }
type Enemy = { x: number; y: number; vx: number; holdX: number; phase: number; wobble: number; cooldown: number }
type Bolt = { x: number; y: number; vx: number; colors: number[]; fromHero: boolean }
type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number }
type Star = { x: number; y: number; layer: number }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_CODES = Array.from(B64).map(ch => ch.charCodeAt(0))

const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))
const rand = (min: number, max: number) => min + Math.random() * (max - min)

function sprite(rows: string[]): Sprite {
  const h = rows.length
  const w = rows[0]?.length ?? 0
  const px = new Uint32Array(w * h).fill(EMPTY)
  rows.forEach((row, y) => {
    Array.from(row).forEach((ch, x) => {
      const color = PALETTE[ch]
      if (color !== undefined) px[y * w + x] = color
    })
  })
  return { w, h, px }
}

const FIGHTER_SPRITE = sprite(FIGHTER)
const ENEMY_SPRITE = sprite(INTERCEPTOR)

// Byte length is always a multiple of 12 (3 u32 per cell), so no padding is needed.
function toBase64(bytes: Uint8Array): string {
  const out = new Uint8Array((bytes.length / 3) * 4)
  for (let i = 0, o = 0; i < bytes.length; i += 3, o += 4) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out[o] = B64_CODES[(n >> 18) & 63] ?? 0
    out[o + 1] = B64_CODES[(n >> 12) & 63] ?? 0
    out[o + 2] = B64_CODES[(n >> 6) & 63] ?? 0
    out[o + 3] = B64_CODES[n & 63] ?? 0
  }
  let text = ''
  for (let i = 0; i < out.length; i += 8192) {
    text += String.fromCharCode(...out.subarray(i, i + 8192))
  }
  return text
}

class Dogfight {
  readonly columns: number
  readonly rows: number
  private readonly width: number
  private readonly height: number
  private readonly heroX = 3
  private readonly maxEnemies: number
  private readonly pixels: Uint32Array
  private readonly words: Uint32Array
  private readonly stars: Star[]
  private heroY: number
  private enemies: Enemy[] = []
  private bolts: Bolt[] = []
  private particles: Particle[] = []
  private cooldown = 8
  private shield = 0
  private spawnIn = 6
  private frameNo = 0
  private kills = 0

  constructor(columns: number, rows: number) {
    this.columns = columns
    this.rows = rows
    this.width = columns
    this.height = rows * 2
    this.heroY = (this.height - FIGHTER_SPRITE.h) / 2
    this.maxEnemies = Math.max(1, Math.min(4, Math.floor((columns - 30) / 18) + 1))
    this.pixels = new Uint32Array(this.width * this.height)
    this.words = new Uint32Array(columns * rows * 3)
    this.stars = Array.from({ length: Math.ceil((this.width * this.height) / 60) }, () => ({
      x: rand(0, this.width),
      y: randInt(0, this.height - 1),
      layer: randInt(0, 2),
    }))
  }

  private get maxY(): number {
    return Math.max(0, this.height - FIGHTER_SPRITE.h)
  }

  step(): void {
    this.frameNo += 1
    for (const star of this.stars) {
      star.x -= [0.15, 0.35, 0.8][star.layer] ?? 0.3
      if (star.x < 0) {
        star.x += this.width
        star.y = randInt(0, this.height - 1)
      }
    }
    this.stepHero()
    this.stepEnemies()
    this.stepBolts()
    for (const p of this.particles) {
      p.x += p.vx
      p.y += p.vy
      p.vx *= 0.92
      p.vy *= 0.92
      p.life -= 1
    }
    this.particles = this.particles.filter(p => p.life > 0)
  }

  // Chase the nearest interceptor's line, weaving a little; fire when lined up.
  private stepHero(): void {
    if (this.shield > 0) this.shield -= 1
    this.cooldown -= 1
    const onScreen = this.enemies.filter(e => e.x < this.width - ENEMY_SPRITE.w - 3)
    const target = onScreen.sort((a, b) => a.x - b.x)[0]
    const bob = Math.sin(this.frameNo / 9) * 0.8
    const wanted = target ? target.y : this.maxY / 2 + bob
    this.heroY += Math.max(-0.45, Math.min(0.45, wanted - this.heroY))
    this.heroY = Math.max(0, Math.min(this.maxY, this.heroY))
    if (target && this.cooldown <= 0 && Math.abs(target.y - this.heroY) < 1.5) {
      const y = Math.round(this.heroY) + 2
      this.bolts.push({ x: this.heroX + FIGHTER_SPRITE.w, y, vx: 4, colors: HERO_BOLT, fromHero: true })
      this.cooldown = randInt(9, 16)
    }
  }

  private stepEnemies(): void {
    this.spawnIn -= 1
    if (this.spawnIn <= 0 && this.enemies.length < this.maxEnemies) {
      this.enemies.push({
        x: this.width + 1,
        y: rand(0, this.maxY),
        vx: -rand(0.5, 1.1),
        holdX: rand(this.heroX + FIGHTER_SPRITE.w + 20, Math.max(this.heroX + FIGHTER_SPRITE.w + 21, this.width - 14)),
        phase: rand(0, Math.PI * 2),
        wobble: rand(0.6, 2.2),
        cooldown: randInt(15, 35),
      })
      this.spawnIn = randInt(12, 30)
    }
    for (const e of this.enemies) {
      e.phase += 0.12
      // Fly in to a station in front of the fighter, then strafe up and down there.
      if (e.x > e.holdX) e.x += e.vx
      else e.x += Math.sin(e.phase * 0.4) * 0.2
      e.y = Math.max(0, Math.min(this.maxY, e.y + Math.sin(e.phase) * e.wobble * 0.18))
      e.cooldown -= 1
      if (e.cooldown <= 0 && e.x < this.width - 6) {
        this.bolts.push({ x: Math.round(e.x) - 1, y: Math.round(e.y) + 2, vx: -3, colors: ENEMY_BOLT, fromHero: false })
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
          e =>
            e.x < this.width - ENEMY_SPRITE.w &&
            bolt.x + 3 >= e.x &&
            bolt.x <= e.x + ENEMY_SPRITE.w &&
            bolt.y >= Math.round(e.y) &&
            bolt.y < Math.round(e.y) + ENEMY_SPRITE.h,
        )
        if (hit) {
          this.enemies = this.enemies.filter(e => e !== hit)
          this.kills += 1
          this.explode(hit.x + ENEMY_SPRITE.w / 2, hit.y + ENEMY_SPRITE.h / 2, 14)
          continue
        }
      } else {
        const top = Math.round(this.heroY)
        if (bolt.x <= this.heroX + FIGHTER_SPRITE.w && bolt.y >= top && bolt.y < top + FIGHTER_SPRITE.h) {
          this.shield = 4
          this.explode(this.heroX + FIGHTER_SPRITE.w, bolt.y, 4)
          continue
        }
      }
      kept.push(bolt)
    }
    this.bolts = kept
  }

  private explode(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const angle = rand(0, Math.PI * 2)
      const speed = rand(0.3, 1.6)
      const life = randInt(5, 12)
      this.particles.push({ x, y, vx: Math.cos(angle) * speed * 1.6, vy: Math.sin(angle) * speed * 0.7, life, max: life })
    }
  }

  private plot(x: number, y: number, color: number): void {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return
    this.pixels[yi * this.width + xi] = color
  }

  private blitSprite(s: Sprite, x: number, y: number, tint?: number): void {
    const x0 = Math.round(x)
    const y0 = Math.round(y)
    for (let sy = 0; sy < s.h; sy++) {
      for (let sx = 0; sx < s.w; sx++) {
        const c = s.px[sy * s.w + sx] ?? EMPTY
        if (c !== EMPTY) this.plot(x0 + sx, y0 + sy, tint ?? c)
      }
    }
  }

  frame(): string {
    const { pixels, words, width, columns, rows } = this
    pixels.fill(EMPTY)
    for (const star of this.stars) this.plot(star.x, star.y, STARS[star.layer] ?? STARS[0]!)
    for (const e of this.enemies) this.blitSprite(ENEMY_SPRITE, e.x, e.y)
    const heroTop = Math.round(this.heroY)
    this.blitSprite(FIGHTER_SPRITE, this.heroX, heroTop, this.shield % 2 === 1 ? SHIELD : undefined)
    const flame = ENGINE[this.frameNo % ENGINE.length] ?? ENGINE[0]!
    this.plot(this.heroX, heroTop + 2, flame)
    if (this.frameNo % 3 !== 0) this.plot(this.heroX - 1, heroTop + 2, ENGINE[2]!)
    for (const bolt of this.bolts) {
      bolt.colors.forEach((c, k) => this.plot(bolt.x - Math.sign(bolt.vx) * k, bolt.y, c))
    }
    for (const p of this.particles) {
      const age = 1 - p.life / p.max
      this.plot(p.x, p.y, BLAST[Math.min(BLAST.length - 1, Math.floor(age * BLAST.length))] ?? BLAST[0]!)
    }

    // Two pixels per cell: the upper one as the glyph's colour, the lower one as its background.
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < columns; cx++) {
        const hi = pixels[2 * cy * width + cx] ?? EMPTY
        const lo = pixels[(2 * cy + 1) * width + cx] ?? EMPTY
        const i = (cy * columns + cx) * 3
        if (hi === EMPTY && lo === EMPTY) {
          words[i] = SPACE
          words[i + 1] = DEFAULT_COLOR
          words[i + 2] = DEFAULT_COLOR
        } else if (hi === EMPTY) {
          words[i] = LOWER_HALF
          words[i + 1] = lo
          words[i + 2] = DEFAULT_COLOR
        } else {
          words[i] = UPPER_HALF
          words[i + 1] = hi
          words[i + 2] = lo
        }
      }
    }
    this.text(`KO ${this.kills}`, columns - 7, 0, SCORE_COLOR)
    return toBase64(new Uint8Array(words.buffer))
  }

  private text(s: string, x: number, row: number, color: number): void {
    Array.from(s).forEach((ch, k) => {
      const cx = x + k
      if (cx < 0 || cx >= this.columns || row >= this.rows) return
      const i = (row * this.columns + cx) * 3
      this.words[i] = ch.codePointAt(0) ?? SPACE
      this.words[i + 1] = color
      this.words[i + 2] = DEFAULT_COLOR
    })
  }
}

// Module state: a hot reload runs the module again and starts it over.
let scene: Dogfight | null = null
let site = ''
let timer: Timer | null = null
let park: Timer | null = null
let denies = 0

function stop(): void {
  timer?.cancel()
  timer = null
  park?.cancel()
  park = null
}

// The band is not mounted (a question or permission dialog holds the screen), so blits are
// refused. When it comes back the engine repaints its cached answer without calling the render
// hook, so nothing would restart the loop: ask for a redraw until the hook runs again. The redraw
// also stops everything once the turn is over (isWorking false).
function parkUntilMounted($: EngineInterface): void {
  timer?.cancel()
  timer = null
  if (park) return
  park = $.clock.every(PARK_MS, () => $.ui.invalidate('ui.render'))
}

function start($: EngineInterface): void {
  park?.cancel()
  park = null
  if (timer) return
  denies = 0
  timer = $.clock.every(FRAME_MS, () => {
    const current = scene
    if (!current) return stop()
    current.step()
    void $.ui
      .blit({ requestId: site, key: RASTER_KEY, cells: current.frame(), columns: current.columns, rows: current.rows })
      .then(result => {
        denies = result.deny ? denies + 1 : 0
        if (denies >= MAX_DENIES) parkUntilMounted($)
      })
      .catch(() => parkUntilMounted($))
  })
}

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    const isIdle = !e.props.isWorking || e.props.hasSurvey || e.props.isCollapsed
    if (e.surface !== 'terminal' || isIdle || e.props.bodyColumns < MIN_COLUMNS) {
      stop()
      return next(e)
    }
    const columns = Math.min(e.props.bodyColumns, MAX_COLUMNS)
    const rows = Math.min(BAND_ROWS, Math.max(e.props.maxRows, 1))
    if (!scene || scene.columns !== columns || scene.rows !== rows) scene = new Dogfight(columns, rows)
    site = e.requestId
    start($)
    const { Raster } = $.ui.resolve(e)
    return Raster({ key: RASTER_KEY, columns, rows, cells: scene.frame() })
  })

  on('turn.complete', ($, e, next) => {
    stop()
    scene = null
    $.ui.invalidate('ui.render')
    return next(e)
  })
}
