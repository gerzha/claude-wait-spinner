// Shared by every spinner in this repository: tools/sync-kit.mjs copies this file to
// plugins/<spinner>/hooks/kit.ts. Edit it here, then run the sync.
//
// A scene paints each frame into a Gfx, in world units (one unit = one terminal column = half
// a row, so units are square). Where the terminal shows pictures (kitty, Ghostty, iTerm2 3.5+
// in fullscreen rendering) the band is an Image at up to 8 pixels a unit; elsewhere the same
// frame is boiled down to half blocks, two units a cell, in a Raster.

import type { EngineInterface, Register, Timer } from 'claude-code'

export type On = Parameters<Register>[0]

export interface Scene {
  step(): void
  draw(g: Gfx): void
  onTool?(name: string): void
}

export type BandOptions = {
  key: string
  alt: string
  rows: number // band height in terminal rows, at most
  minColumns?: number
  frameMs?: number
  background: number // 0xRRGGBB the scene's sky; in a Raster it becomes the terminal's own
  maxScale?: number // cap on pixels per unit in a picture, for scenes that shade every pixel
  make: (width: number, height: number) => Scene
}

const MAX_DENIES = 20 // consecutive refused blits before the loop parks itself
const PARK_MS = 500 // while parked, how often to ask for a redraw of the band
const MAX_IMAGE_PX = 960 // widest picture sent, in pixels
const MAX_SCALE = 8 // pixels per unit in a picture
const IMAGE_COLUMNS = 255 // widest Image, in cells
const RASTER_COLUMNS = 512
const DEFAULT_COLOR = 0x01000000
const SPACE = 0x20
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584

// ---------------------------------------------------------------- drawing

export const rgb = (r: number, g: number, b: number) => (clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b)
const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0)
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const rand = (min: number, max: number) => min + Math.random() * (max - min)
export const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))

export function mix(c1: number, c2: number, t: number): number {
  const k = clamp(t, 0, 1)
  return rgb(
    lerp((c1 >> 16) & 255, (c2 >> 16) & 255, k),
    lerp((c1 >> 8) & 255, (c2 >> 8) & 255, k),
    lerp(c1 & 255, c2 & 255, k),
  )
}

// A colour ramp: stops as [position 0..1, colour].
export function ramp(stops: Array<[number, number]>, t: number): number {
  const x = clamp(t, 0, 1)
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]!
    const [p0, c0] = stops[i - 1]!
    if (x <= p1) return mix(c0, c1, (x - p0) / Math.max(1e-6, p1 - p0))
  }
  return stops[stops.length - 1]![1]
}

// 2D value noise, smooth, about 0..1.
function HASH(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) & 0xffff) / 0xffff
}
export function noise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = HASH(xi, yi)
  const b = HASH(xi + 1, yi)
  const c = HASH(xi, yi + 1)
  const d = HASH(xi + 1, yi + 1)
  return lerp(lerp(a, b, u), lerp(c, d, u), v)
}
export const fbm = (x: number, y: number) => noise(x, y) * 0.6 + noise(x * 2.1, y * 2.1) * 0.3 + noise(x * 4.3, y * 4.3) * 0.1

// 3 x 5 pixel font, upper case.
const FONT: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
  E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
  I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
  Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111', '0': '111101101101111', '1': '010110010010111',
  '2': '110001010100111', '3': '110001010001110', '4': '101101111001001', '5': '111100110001110',
  '6': '011100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001110',
  ':': '000010000010000', '-': '000000111000000', '_': '000000000000111', '.': '000000000000010',
  ' ': '000000000000000', '?': '110001010000010',
}
export const textWidth = (s: string, size: number) => Math.max(0, s.length * 4 - 1) * size

export class Gfx {
  readonly w: number // pixels
  readonly h: number
  readonly s: number // pixels per world unit
  readonly data: Uint8Array // RGBA

  constructor(units: number, unitsHigh: number, scale: number) {
    this.s = scale
    this.w = Math.max(1, Math.round(units * scale))
    this.h = Math.max(1, Math.round(unitsHigh * scale))
    this.data = new Uint8Array(this.w * this.h * 4)
  }

  clear(color: number): void {
    const r = (color >> 16) & 255
    const g = (color >> 8) & 255
    const b = color & 255
    const d = this.data
    for (let i = 0; i < d.length; i += 4) {
      d[i] = r
      d[i + 1] = g
      d[i + 2] = b
      d[i + 3] = 255
    }
  }

  // Vertical gradient over the whole frame.
  sky(top: number, bottom: number): void {
    for (let y = 0; y < this.h; y++) {
      const c = mix(top, bottom, y / Math.max(1, this.h - 1))
      const r = (c >> 16) & 255
      const g = (c >> 8) & 255
      const b = c & 255
      for (let x = 0; x < this.w; x++) {
        const i = (y * this.w + x) * 4
        this.data[i] = r
        this.data[i + 1] = g
        this.data[i + 2] = b
        this.data[i + 3] = 255
      }
    }
  }

  blendPx(px: number, py: number, color: number, a: number): void {
    if (a <= 0 || px < 0 || py < 0 || px >= this.w || py >= this.h) return
    const i = (py * this.w + px) * 4
    const k = a > 1 ? 1 : a
    const d = this.data
    d[i] = d[i]! + (((color >> 16) & 255) - d[i]!) * k
    d[i + 1] = d[i + 1]! + (((color >> 8) & 255) - d[i + 1]!) * k
    d[i + 2] = d[i + 2]! + ((color & 255) - d[i + 2]!) * k
  }

  addPx(px: number, py: number, color: number, k: number): void {
    if (k <= 0 || px < 0 || py < 0 || px >= this.w || py >= this.h) return
    const i = (py * this.w + px) * 4
    const d = this.data
    d[i] = Math.min(255, d[i]! + ((color >> 16) & 255) * k)
    d[i + 1] = Math.min(255, d[i + 1]! + ((color >> 8) & 255) * k)
    d[i + 2] = Math.min(255, d[i + 2]! + (color & 255) * k)
  }

  // Calls fn for every pixel centre inside the world box, with world coordinates.
  shade(x0: number, y0: number, x1: number, y1: number, fn: (wx: number, wy: number, px: number, py: number) => void): void {
    const s = this.s
    const pxa = Math.max(0, Math.floor(x0 * s))
    const pya = Math.max(0, Math.floor(y0 * s))
    const pxb = Math.min(this.w - 1, Math.ceil(x1 * s))
    const pyb = Math.min(this.h - 1, Math.ceil(y1 * s))
    for (let py = pya; py <= pyb; py++) {
      const wy = (py + 0.5) / s
      for (let px = pxa; px <= pxb; px++) fn((px + 0.5) / s, wy, px, py)
    }
  }

  rect(x: number, y: number, w: number, h: number, color: number, a = 1): void {
    this.shade(x, y, x + w, y + h, (wx, wy, px, py) => {
      if (wx >= x && wx < x + w && wy >= y && wy < y + h) this.blendPx(px, py, color, a)
    })
  }

  // Filled polygon [x0, y0, x1, y1, ...], anti-aliased by 2 x 2 samples a pixel.
  poly(pts: number[], color: number, a = 1): void {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]!)
      x1 = Math.max(x1, pts[i]!)
      y0 = Math.min(y0, pts[i + 1]!)
      y1 = Math.max(y1, pts[i + 1]!)
    }
    const q = 0.25 / this.s
    this.shade(x0, y0, x1, y1, (wx, wy, px, py) => {
      const cover =
        (inside(pts, wx - q, wy - q) ? 1 : 0) +
        (inside(pts, wx + q, wy - q) ? 1 : 0) +
        (inside(pts, wx - q, wy + q) ? 1 : 0) +
        (inside(pts, wx + q, wy + q) ? 1 : 0)
      if (cover) this.blendPx(px, py, color, (cover / 4) * a)
    })
  }

  disc(cx: number, cy: number, r: number, color: number, a = 1): void {
    const edge = 1 / this.s
    this.shade(cx - r - edge, cy - r - edge, cx + r + edge, cy + r + edge, (wx, wy, px, py) => {
      const d = Math.hypot(wx - cx, wy - cy)
      const cover = clamp((r - d) / edge + 0.5, 0, 1)
      if (cover > 0) this.blendPx(px, py, color, cover * a)
    })
  }

  ring(cx: number, cy: number, r: number, width: number, color: number, a = 1): void {
    const edge = 1 / this.s
    const o = r + width / 2 + edge
    this.shade(cx - o, cy - o, cx + o, cy + o, (wx, wy, px, py) => {
      const d = Math.abs(Math.hypot(wx - cx, wy - cy) - r)
      const cover = clamp((width / 2 - d) / edge + 0.5, 0, 1)
      if (cover > 0) this.blendPx(px, py, color, cover * a)
    })
  }

  // Additive light, falling off to nothing at radius r (world units); rx/ry stretch it.
  glow(cx: number, cy: number, r: number, color: number, k = 1, squash = 1): void {
    const ry = r * squash
    this.shade(cx - r, cy - ry, cx + r, cy + ry, (wx, wy, px, py) => {
      const d = Math.hypot((wx - cx) / r, (wy - cy) / ry)
      if (d < 1) this.addPx(px, py, color, k * (1 - d) * (1 - d))
    })
  }

  // A capsule between two points: solid core, optional additive halo.
  line(xa: number, ya: number, xb: number, yb: number, width: number, color: number, a = 1, halo = 0): void {
    const pad = width / 2 + halo + 1 / this.s
    const dx = xb - xa
    const dy = yb - ya
    const len2 = dx * dx + dy * dy || 1e-6
    const edge = 1 / this.s
    this.shade(Math.min(xa, xb) - pad, Math.min(ya, yb) - pad, Math.max(xa, xb) + pad, Math.max(ya, yb) + pad, (wx, wy, px, py) => {
      const t = clamp(((wx - xa) * dx + (wy - ya) * dy) / len2, 0, 1)
      const d = Math.hypot(wx - (xa + dx * t), wy - (ya + dy * t))
      const cover = clamp((width / 2 - d) / edge + 0.5, 0, 1)
      if (cover > 0) this.blendPx(px, py, color, cover * a)
      if (halo > 0 && d < width / 2 + halo) {
        const f = 1 - Math.max(0, d - width / 2) / halo
        this.addPx(px, py, color, 0.55 * f * f)
      }
    })
  }

  text(s: string, x: number, y: number, size: number, color: number, a = 1): void {
    Array.from(s.toUpperCase()).forEach((ch, k) => {
      const glyph = FONT[ch] ?? FONT['?']!
      for (let gy = 0; gy < 5; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          if (glyph[gy * 3 + gx] === '1') this.rect(x + (k * 4 + gx) * size, y + gy * size, size, size, color, a)
        }
      }
    })
  }
}

function inside(pts: number[], x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i]!
    const yi = pts[i + 1]!
    const xj = pts[j]!
    const yj = pts[j + 1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

// ---------------------------------------------------------------- encoding

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_CODES = Array.from(B64).map(ch => ch.charCodeAt(0))

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
  const full = bytes.length - (bytes.length % 3)
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4)
  let o = 0
  for (let i = 0; i < full; i += 3, o += 4) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out[o] = B64_CODES[(n >> 18) & 63]!
    out[o + 1] = B64_CODES[(n >> 12) & 63]!
    out[o + 2] = B64_CODES[(n >> 6) & 63]!
    out[o + 3] = B64_CODES[n & 63]!
  }
  const rest = bytes.length - full
  if (rest) {
    const n = (bytes[full]! << 16) | ((rest > 1 ? bytes[full + 1]! : 0) << 8)
    out[o] = B64_CODES[(n >> 18) & 63]!
    out[o + 1] = B64_CODES[(n >> 12) & 63]!
    out[o + 2] = rest > 1 ? B64_CODES[(n >> 6) & 63]! : 61
    out[o + 3] = 61
  }
  let text = ''
  for (let i = 0; i < out.length; i += 8192) text += String.fromCharCode(...out.subarray(i, i + 8192))
  return text
}

// Half blocks from a Gfx: each cell is one unit wide and two tall, each half the average of its
// pixels; a half close to the scene's sky is left to the terminal's own background.
function toCells(g: Gfx, columns: number, rows: number, background: number): string {
  const words = new Uint32Array(columns * rows * 3)
  const s = g.s
  const br = (background >> 16) & 255
  const bg = (background >> 8) & 255
  const bb = background & 255
  const half = (ux: number, uy: number): number => {
    let r = 0
    let gg = 0
    let b = 0
    let n = 0
    const x0 = Math.round(ux * s)
    const y0 = Math.round(uy * s)
    for (let y = y0; y < Math.min(g.h, y0 + s); y++) {
      for (let x = x0; x < Math.min(g.w, x0 + s); x++) {
        const i = (y * g.w + x) * 4
        r += g.data[i]!
        gg += g.data[i + 1]!
        b += g.data[i + 2]!
        n++
      }
    }
    if (!n) return DEFAULT_COLOR
    r /= n
    gg /= n
    b /= n
    if (Math.abs(r - br) + Math.abs(gg - bg) + Math.abs(b - bb) < 36) return DEFAULT_COLOR
    return rgb(r, gg, b)
  }
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      const hi = half(cx, cy * 2)
      const lo = half(cx, cy * 2 + 1)
      const i = (cy * columns + cx) * 3
      if (hi === DEFAULT_COLOR && lo === DEFAULT_COLOR) {
        words[i] = SPACE
        words[i + 1] = DEFAULT_COLOR
        words[i + 2] = DEFAULT_COLOR
      } else if (hi === DEFAULT_COLOR) {
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
  return toBase64(new Uint8Array(words.buffer))
}

// ---------------------------------------------------------------- the band

type Painted = { source: { rgba: string; width: number; height: number } } | { cells: string }

type Band = {
  opt: BandOptions
  scene: Scene | null
  gfx: Gfx | null
  columns: number
  rows: number
  site: string
  timer: Timer | null
  park: Timer | null
  denies: number
  pictures: boolean // until the terminal shows it cannot draw them; then half blocks for the session
}

function stopBand(b: Band): void {
  b.timer?.cancel()
  b.timer = null
  b.park?.cancel()
  b.park = null
}

// The band is not mounted (a question or permission dialog holds the screen), so blits are
// refused. When it comes back the engine repaints its cached answer without calling the
// render hook, so nothing would restart the loop: ask for a redraw until the hook runs again.
// The redraw also stops everything once the turn is over (isWorking false).
function parkBand($: EngineInterface, b: Band): void {
  b.timer?.cancel()
  b.timer = null
  if (b.park) return
  b.park = $.clock.every(PARK_MS, () => $.ui.invalidate('ui.render'))
}

function paintBand(b: Band): Painted | null {
  if (!b.scene || !b.gfx) return null
  b.scene.draw(b.gfx)
  return b.pictures
    ? { source: { rgba: toBase64(b.gfx.data), width: b.gfx.w, height: b.gfx.h } }
    : { cells: toCells(b.gfx, b.columns, b.rows, b.opt.background) }
}

function startBand($: EngineInterface, b: Band): void {
  b.park?.cancel()
  b.park = null
  if (b.timer) return
  b.denies = 0
  b.timer = $.clock.every(b.opt.frameMs ?? 66, () => {
    if (!b.scene) return stopBand(b)
    b.scene.step()
    const frame = paintBand(b)
    if (!frame) return stopBand(b)
    void $.ui
      .blit({ requestId: b.site, key: b.opt.key, columns: b.columns, rows: b.rows, ...frame })
      .then(result => {
        if (!result.deny) {
          b.denies = 0
          return
        }
        if (b.pictures && (result.fix === 'tmux-passthrough' || /\balt\b/i.test(result.deny))) {
          b.pictures = false // the Image shows its alt here: switch to half blocks
          b.gfx = null
          stopBand(b)
          $.ui.invalidate('ui.render')
          return
        }
        b.denies += 1
        if (b.denies >= MAX_DENIES) parkBand($, b)
      })
      .catch(() => parkBand($, b))
  })
}

export function band(on: On, opt: BandOptions): void {
  const b: Band = {
    opt,
    scene: null,
    gfx: null,
    columns: 0,
    rows: 0,
    site: '',
    timer: null,
    park: null,
    denies: 0,
    pictures: true,
  }

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    const isIdle = !e.props.isWorking || e.props.hasSurvey || e.props.isCollapsed
    if (e.surface !== 'terminal' || isIdle || e.props.bodyColumns < (opt.minColumns ?? 24)) {
      stopBand(b)
      return next(e)
    }
    const columns = Math.min(e.props.bodyColumns, b.pictures ? IMAGE_COLUMNS : RASTER_COLUMNS)
    const rows = Math.min(opt.rows, Math.max(e.props.maxRows, 1))
    if (!b.scene || columns !== b.columns || rows !== b.rows) {
      b.columns = columns
      b.rows = rows
      b.scene = opt.make(columns, rows * 2)
      b.gfx = null
    }
    if (!b.gfx) {
      const scale = b.pictures ? clamp(Math.floor(MAX_IMAGE_PX / columns), 2, opt.maxScale ?? MAX_SCALE) : 2
      b.gfx = new Gfx(columns, rows * 2, scale)
    }
    b.site = e.requestId
    startBand($, b)
    const frame = paintBand(b)!
    const { Raster, Image } = $.ui.resolve(e)
    return 'source' in frame
      ? Image({ key: opt.key, source: frame.source, columns, rows, alt: opt.alt })
      : Raster({ key: opt.key, columns, rows, cells: frame.cells })
  })

  // Observe only: hand every call on untouched.
  on('tool.call', ($, e, next) => {
    b.scene?.onTool?.(String(e.tool).replace(/^mcp__.+?__/, ''))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    stopBand(b)
    b.scene = null
    b.gfx = null
    $.ui.invalidate('ui.render')
    return next(e)
  })
}
