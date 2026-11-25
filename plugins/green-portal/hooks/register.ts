import type { Register } from 'claude-code'
import { band, clamp, Gfx, mix, noise, ramp, rand, randInt, textWidth, type Scene } from './kit'

// A swirling green portal hangs in the band above the prompt while a model turn runs. Every
// tool call Claude makes comes flying out of it by name, growing as it nears, and the
// portal pulses and spits goo.

const SKY_TOP = 0x020604
const SKY_BOTTOM = 0x06100a
const SWIRL: Array<[number, number]> = [
  [0, 0x041f0b],
  [0.35, 0x0f6a22],
  [0.6, 0x2fbf3a],
  [0.82, 0x8cff5a],
  [1, 0xe6ffb8],
]
const GLOW = 0x5cff3a
const LABEL = 0xd6ffb0

type Word = { text: string; x: number; y: number; vx: number; vy: number; age: number; spin: number }
type Drop = { x: number; y: number; vx: number; vy: number; life: number; r: number }

class Portal implements Scene {
  private readonly cx: number
  private readonly cy: number
  private readonly r: number
  private t = 0
  private pulse = 0
  private words: Word[] = []
  private drops: Drop[] = []
  private idle = 0

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.r = height * 0.44
    this.cx = Math.max(this.r * 1.6, width - this.r * 2.2)
    this.cy = height / 2
  }

  onTool(name: string): void {
    this.pulse = 1
    this.idle = 0
    const y = this.cy + rand(-0.3, 0.3) * this.height
    this.words.push({ text: name.slice(0, 14), x: this.cx, y, vx: -rand(0.45, 0.8), vy: (this.cy - y) * -0.01, age: 0, spin: rand(-1, 1) })
    for (let i = 0; i < 10; i++) this.spit(1.6)
  }

  private spit(force: number): void {
    const angle = rand(0, Math.PI * 2)
    const speed = rand(0.15, 0.5) * force
    this.drops.push({
      x: this.cx + Math.cos(angle) * this.r,
      y: this.cy + Math.sin(angle) * this.r,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 0.6,
      life: randInt(10, 26),
      r: rand(0.15, 0.38),
    })
  }

  step(): void {
    this.t += 1
    this.pulse *= 0.9
    if (++this.idle > 45 && Math.random() < 0.04) this.spit(1)
    if (Math.random() < 0.25) this.spit(0.7)
    for (const w of this.words) {
      w.age += 1
      w.x += w.vx * (1 + w.age * 0.012)
      w.y += w.vy
    }
    this.words = this.words.filter(w => w.x > -textWidth(w.text, 0.6))
    for (const d of this.drops) {
      d.x += d.vx
      d.y += d.vy
      d.vy += 0.03
      d.life -= 1
    }
    this.drops = this.drops.filter(d => d.life > 0)
  }

  draw(g: Gfx): void {
    const { cx, cy } = this
    const t = this.t * 0.05
    const r = this.r * (1 + this.pulse * 0.08)
    g.sky(SKY_TOP, SKY_BOTTOM)
    g.glow(cx, cy, r * 3, 0x0f4a14, 0.8 + this.pulse * 0.6, 0.7)

    g.shade(cx - r * 1.5, cy - r * 1.5, cx + r * 1.5, cy + r * 1.5, (wx, wy, px, py) => {
      const dx = wx - cx
      const dy = wy - cy
      const d = Math.hypot(dx, dy) / r
      const angle = Math.atan2(dy, dx)
      const rim = 1 + 0.09 * (noise(angle * 2.2 + 20, t * 1.4) - 0.5) * 2 + 0.03 * Math.sin(angle * 9 + t * 5)
      if (d < rim) {
        const depth = d / rim
        const arms = 0.5 + 0.5 * Math.sin(angle * 3 - t * 4 + Math.log(depth + 0.06) * 6.5)
        const grain = noise(angle * 4 + t, depth * 6 - t * 2)
        let k = 0.18 + 0.5 * depth + 0.28 * arms * depth + 0.1 * grain
        if (depth > 0.86) k = Math.max(k, 0.82 + (depth - 0.86) * 1.2)
        const edge = clamp((rim - d) * r * 3, 0, 1)
        g.blendPx(px, py, ramp(SWIRL, clamp(k, 0, 1)), edge)
        if (edge < 1) g.addPx(px, py, GLOW, 0.75 * (1 - edge) * (1 + this.pulse))
      } else {
        const out = (d - rim) * r
        if (out < 1.6) g.addPx(px, py, GLOW, 0.75 * Math.pow(1 - out / 1.6, 2) * (1 + this.pulse))
      }
    })

    for (const d of this.drops) {
      const f = d.life / 26
      g.disc(d.x, d.y, d.r, mix(0x2fbf3a, 0xb8ff7a, f), Math.min(1, f * 2))
    }
    for (const w of this.words) {
      const size = Math.min(0.55, 0.12 + w.age * 0.012)
      const fade = clamp(w.x / (this.width * 0.35), 0, 1)
      const tx = w.x - textWidth(w.text, size) / 2
      const ty = w.y - size * 2.5 + Math.sin(w.age * 0.15) * 0.3 * w.spin
      g.glow(w.x, w.y, textWidth(w.text, size) * 0.6, GLOW, 0.25 * fade, 0.35)
      g.text(w.text, tx, ty, size, LABEL, fade)
    }
  }
}

export const register: Register = on =>
  band(on, {
    key: 'portal',
    alt: ' ',
    rows: 7,
    minColumns: 30,
    background: SKY_BOTTOM,
    make: (width, height) => new Portal(width, height),
  })
