import type { Register } from 'claude-code'
import { band, clamp, fbm, Gfx, noise, ramp, rand, randInt, type Scene } from './kit'

// A lidless eye wreathed in flame watches from the band above the prompt while a model turn
// runs. Its slit pupil wanders; every tool call Claude makes flares the fire, narrows the
// pupil and snaps the gaze somewhere new. Embers drift up from the blaze.

const SKY_TOP = 0x050101
const SKY_BOTTOM = 0x0d0303
const FIRE: Array<[number, number]> = [
  [0, 0x0d0303],
  [0.12, 0x2a0400],
  [0.3, 0x7a0d00],
  [0.5, 0xd23400],
  [0.68, 0xff7a10],
  [0.84, 0xffc24a],
  [1, 0xfff3cf],
]
const EMBER = 0xff9a2e

type Ember = { x: number; y: number; vx: number; vy: number; life: number; max: number }

class Eye implements Scene {
  private readonly cx: number
  private readonly cy: number
  private readonly a: number // half width of the eye
  private readonly b: number // half height of the eye
  private t = 0
  private look = 0
  private lookTo = 0
  private lookIn = 30
  private flare = 0
  private embers: Ember[] = []

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.cx = width / 2
    this.cy = height / 2
    this.a = clamp(width * 0.2, 6, 18)
    this.b = height * 0.3
  }

  onTool(): void {
    this.flare = 1
    this.lookTo = rand(-1, 1)
    this.lookIn = randInt(25, 60)
    for (let i = 0; i < 8; i++) this.spawnEmber(true)
  }

  step(): void {
    this.t += 1
    this.flare *= 0.93
    if (--this.lookIn <= 0) {
      this.lookTo = Math.random() < 0.3 ? 0 : rand(-1, 1)
      this.lookIn = randInt(30, 90)
    }
    this.look += (this.lookTo - this.look) * 0.12
    if (Math.random() < 0.35 + this.flare) this.spawnEmber(false)
    for (const e of this.embers) {
      e.x += e.vx + Math.sin((this.t + e.max) * 0.2) * 0.05
      e.y += e.vy
      e.life -= 1
    }
    this.embers = this.embers.filter(e => e.life > 0 && e.y > -1)
  }

  private spawnEmber(burst: boolean): void {
    const u = rand(-1.1, 1.1)
    const life = randInt(14, 34)
    this.embers.push({
      x: this.cx + u * this.a,
      y: this.cy - (1 - Math.min(1, u * u)) * this.b - rand(0, 1.5),
      vx: rand(-0.08, 0.08) + (burst ? rand(-0.3, 0.3) : 0),
      vy: -rand(0.12, 0.3) * (burst ? 1.8 : 1),
      life,
      max: life,
    })
  }

  draw(g: Gfx): void {
    const { cx, cy, a, b } = this
    const t = this.t * 0.06
    const heat = 1 + this.flare * 0.55
    g.sky(SKY_TOP, SKY_BOTTOM)
    g.glow(cx, cy, a * 2.4, 0x5a0c00, 0.9 * heat, 0.45)

    const pupilX = cx + this.look * a * 0.38
    const slit = a * (0.075 - this.flare * 0.03)
    const reachX = a + b * 3.2
    g.shade(cx - reachX, 0, cx + reachX, this.height, (wx, wy, px, py) => {
      const u = (wx - cx) / a
      const v = (wy - cy) / b
      const lens = 1 - u * u // the eye's half height at u, in units of b
      let heatHere = 0
      if (lens > 0 && Math.abs(v) < lens) {
        // the iris: molten, brightest at the rim, striated
        const rim = 1 - Math.abs(v) / lens
        const around = Math.atan2(wy - cy, (wx - pupilX) * 0.45)
        const streak = noise(around * 4 + 30, Math.hypot(wx - pupilX, (wy - cy) * 2.2) * 0.45 - t * 0.8)
        heatHere = 0.5 + 0.22 * streak + 0.3 * Math.max(0, 1 - rim * 3.2) - 0.1 * Math.abs(u)
        // the slit pupil
        const du = Math.abs(wx - pupilX) / slit
        const dv = Math.abs(v) / (lens * 0.98)
        const inPupil = du < 1 - dv * dv
        if (inPupil) heatHere = 0.02 + 0.1 * du * du
        else if (du < 1.8 - dv * dv) heatHere *= 0.75 // dark halo around the slit
      } else {
        // the flame around it, licking upward
        const outside = lens > 0 ? Math.abs(v) - lens : Math.hypot((Math.abs(u) - 1) * (a / b), v)
        const above = clamp(0.5 - v * 0.8, 0, 1) // 1 over the eye, 0 under it, blended across
        const flame = fbm(wx * 0.42, wy * 0.5 + t * 1.3)
        const sideways = Math.max(0, Math.abs(u) - 1) * 0.6 // flames thin out past the corners
        const reach = Math.max(0, (0.35 + 1.25 * flame) * (0.7 + 0.8 * above) * heat - sideways)
        if (reach <= 0) return
        const f = 1 - outside / reach
        if (f <= 0) return
        heatHere = Math.pow(f, 1.4) * (0.4 + 0.45 * flame) * heat
      }
      const k = clamp(heatHere * heat, 0, 1)
      g.blendPx(px, py, ramp(FIRE, k), clamp(k * 2.2, 0, 1))
    })

    g.glow(pupilX, cy, b * 0.9, 0xff5a00, 0.25 + this.flare * 0.5, 1.6)
    for (const e of this.embers) {
      const f = e.life / e.max
      g.glow(e.x, e.y, 0.55, EMBER, 0.9 * f)
      g.disc(e.x, e.y, 0.09, 0xffe2a0, f)
    }
  }
}

export const register: Register = on =>
  band(on, {
    key: 'eye',
    alt: ' ',
    rows: 7,
    minColumns: 30,
    background: SKY_BOTTOM,
    maxScale: 5,
    make: (width, height) => new Eye(width, height),
  })
