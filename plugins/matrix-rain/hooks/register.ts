import type { EngineInterface, Register, Timer } from 'claude-code'

// Matrix-style rain in Claude orange, drawn as a strip in the band above the prompt
// while a model turn runs; the band row disappears when the turn ends.

const FRAME_MS = 60
const BAND_ROWS = 7
const GLITCH_SHARE = 0.01 // share of cells re-rolled each frame
const MAX_DENIES = 20 // consecutive refused blits before the loop parks itself
const PARK_MS = 500 // while parked, how often to ask for a redraw of the band
const RASTER_KEY = 'rain'
const MAX_COLUMNS = 512

// Half-width katakana + digits + symbols, as in the film; all are width-1 BMP characters.
const GLYPHS = Array.from('ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789Z:."=*+-<>¦|').map(
  ch => ch.codePointAt(0) ?? 0x30,
)

// Claude orange ramp, 0x00RRGGBB: head, bright, mid, dim.
const HEAD = 0xfff1e8
const BRIGHT = 0xf4a582
const MID = 0xd97757
const DIM = 0x7a3c28
const DEFAULT_COLOR = 0x01000000
const SPACE = 0x20

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_CODES = Array.from(B64).map(ch => ch.charCodeAt(0))

type Drop = { y: number; speed: number; length: number; tick: number }

const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))
const randGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? 0x30

function shade(dist: number, length: number): number {
  if (dist === 0) return HEAD
  if (dist === 1) return BRIGHT
  if (dist < length * 0.6) return MID
  return DIM
}

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

class Rain {
  readonly columns: number
  readonly rows: number
  private readonly drops: Drop[]
  private readonly glyphs: Uint32Array
  private readonly blank: Uint32Array
  private readonly words: Uint32Array

  constructor(columns: number, rows: number) {
    this.columns = columns
    this.rows = rows
    const cells = columns * rows
    this.glyphs = new Uint32Array(cells).map(randGlyph)
    this.blank = new Uint32Array(cells * 3)
    for (let i = 0; i < cells; i++) {
      this.blank[i * 3] = SPACE
      this.blank[i * 3 + 1] = DEFAULT_COLOR
      this.blank[i * 3 + 2] = DEFAULT_COLOR
    }
    this.words = new Uint32Array(cells * 3)
    this.drops = Array.from({ length: columns }, () => this.spawn(true))
  }

  private spawn(initial: boolean): Drop {
    const length = randInt(3, this.rows + 4)
    return {
      y: initial ? randInt(-this.rows, this.rows + length) : randInt(-this.rows, -1),
      speed: randInt(1, 3),
      length,
      tick: 0,
    }
  }

  step(): void {
    const { columns, rows } = this
    this.drops.forEach((drop, x) => {
      drop.tick += 1
      if (drop.tick < drop.speed) return
      drop.tick = 0
      drop.y += 1
      if (drop.y >= 0 && drop.y < rows) this.glyphs[drop.y * columns + x] = randGlyph()
      if (drop.y - drop.length >= rows) this.drops[x] = this.spawn(false)
    })
    const glitches = Math.ceil(columns * rows * GLITCH_SHARE)
    for (let n = 0; n < glitches; n++) {
      this.glyphs[Math.floor(Math.random() * this.glyphs.length)] = randGlyph()
    }
  }

  frame(): string {
    const { columns, rows, words, glyphs } = this
    words.set(this.blank)
    this.drops.forEach((drop, x) => {
      for (let k = 0; k < drop.length; k++) {
        const r = drop.y - k
        if (r < 0) break
        if (r >= rows) continue
        const idx = r * columns + x
        words[idx * 3] = glyphs[idx] ?? SPACE
        words[idx * 3 + 1] = shade(k, drop.length)
      }
    })
    return toBase64(new Uint8Array(words.buffer))
  }
}

// Module state: a hot reload runs the module again and starts it over.
let rain: Rain | null = null
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
    const current = rain
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
    if (e.surface !== 'terminal' || isIdle) {
      stop()
      return next(e)
    }
    const columns = Math.min(Math.max(e.props.bodyColumns, 1), MAX_COLUMNS)
    const rows = Math.min(BAND_ROWS, Math.max(e.props.maxRows, 1))
    if (!rain || rain.columns !== columns || rain.rows !== rows) rain = new Rain(columns, rows)
    site = e.requestId
    start($)
    const { Raster } = $.ui.resolve(e)
    return Raster({ key: RASTER_KEY, columns, rows, cells: rain.frame() })
  })

  on('turn.complete', ($, e, next) => {
    stop()
    $.ui.invalidate('ui.render')
    return next(e)
  })
}
