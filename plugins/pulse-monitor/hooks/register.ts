import type { EngineInterface, Register, Timer } from 'claude-code'

// A heart monitor in the band above the prompt while a model turn runs: a phosphor-green
// trace sweeps left to right in braille dots, fading behind its head. Every tool call
// Claude makes fires an extra beat and quickens the pulse; the readout on the right shows
// the beats per minute and the last tool. The row disappears when the turn ends.

const FRAME_MS = 60
const BAND_ROWS = 6
const MAX_DENIES = 20 // consecutive refused blits before the loop parks itself
const PARK_MS = 500 // while parked, how often to ask for a redraw of the band
const RASTER_KEY = 'pulse'
const MAX_COLUMNS = 512
const MIN_COLUMNS = 24
const READOUT_COLUMNS = 9 // right-hand panel: heart, BPM, last tool

const SPEED = 3 // dot columns the sweep advances per frame
const GAP = 8 // blank dot columns ahead of the sweep head
const REST_BPM = 66
const MAX_BPM = 132
const BPM_PER_CALL = 9
const ACTIVITY_DECAY = 0.985 // per frame: a burst of tool calls calms down over ~6 s

const DEFAULT_COLOR = 0x01000000
const SPACE = 0x20
const BRAILLE = 0x2800
// Braille dot bits by [column][row] inside one cell (2 x 4 dots).
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

// Phosphor, newest to oldest: only the head is bright, the tail settles to a dim glow fast.
const TRACE = [0xe0ffe0, 0x86ff97, 0x52e06c, 0x38b954, 0x2a9343, 0x1f7334, 0x18582a, 0x134522]
const FADE_SHARE = 0.45 // share of a sweep over which the trace dims to its last shade
const HEART_ON = 0xff4d5e
const HEART_OFF = 0x8a2a35
const LABEL = 0x4f8a5c
const VALUE = 0x9cf0a8
const GRID = 0x0f2614

// One PQRST complex, one sample per dot column: P bump, Q dip, R spike, S dip, T bump.
const COMPLEX = [0, 0.05, 0.1, 0.11, 0.06, 0, 0, -0.07, 1, -0.3, -0.08, 0, 0, 0, 0.05, 0.12, 0.17, 0.17, 0.12, 0.05, 0]

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_CODES = Array.from(B64).map(ch => ch.charCodeAt(0))

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

// Survives scene rebuilds (a resize) within a turn; reset when the turn ends.
const vitals = { activity: 0, lastTool: '', pendingBeat: false }

class Monitor {
  readonly columns: number
  readonly rows: number
  private readonly traceColumns: number
  private readonly dotsWide: number
  private readonly dotsHigh: number
  private readonly baseline: number
  private readonly amplitude: number
  private readonly top: Int16Array // per dot column: highest dot row lit (-1 none)
  private readonly bottom: Int16Array
  private readonly written: Int32Array // frame each dot column was drawn at
  private readonly words: Uint32Array
  private head = 0
  private frameNo = 0
  private lastY: number
  private beatPos = -1 // index into COMPLEX, -1 between beats
  private untilBeat = 4
  private bpm = REST_BPM
  private heartGlow = 0

  constructor(columns: number, rows: number) {
    this.columns = columns
    this.rows = rows
    this.traceColumns = columns >= 40 ? columns - READOUT_COLUMNS : columns
    this.dotsWide = this.traceColumns * 2
    this.dotsHigh = rows * 4
    this.baseline = Math.round(this.dotsHigh * 0.66)
    this.amplitude = this.dotsHigh * 0.72
    this.lastY = this.baseline
    this.top = new Int16Array(this.dotsWide).fill(-1)
    this.bottom = new Int16Array(this.dotsWide).fill(-1)
    this.written = new Int32Array(this.dotsWide).fill(-100000)
    this.words = new Uint32Array(columns * rows * 3)
  }

  private beatInterval(): number {
    return Math.round((60_000 / this.bpm / FRAME_MS) * SPEED)
  }

  step(): void {
    this.frameNo += 1
    vitals.activity *= ACTIVITY_DECAY
    const target = Math.min(MAX_BPM, REST_BPM + vitals.activity * BPM_PER_CALL)
    this.bpm += (target - this.bpm) * 0.08
    if (this.heartGlow > 0) this.heartGlow -= 1
    for (let k = 0; k < SPEED; k++) this.advance()
  }

  private advance(): void {
    // A tool call fires a beat right away, unless one is already being drawn.
    if (vitals.pendingBeat && this.beatPos < 0) {
      vitals.pendingBeat = false
      this.untilBeat = 0
    }
    let value = 0
    if (this.beatPos >= 0) {
      value = COMPLEX[this.beatPos] ?? 0
      if ((COMPLEX[this.beatPos] ?? 0) >= 1) this.heartGlow = 4 // the R peak
      this.beatPos += 1
      if (this.beatPos >= COMPLEX.length) {
        this.beatPos = -1
        this.untilBeat = Math.max(2, this.beatInterval() - COMPLEX.length)
      }
    } else if (--this.untilBeat <= 0) {
      this.beatPos = 0
    }
    const y = Math.max(0, Math.min(this.dotsHigh - 1, Math.round(this.baseline - value * this.amplitude)))
    const x = this.head
    // One dot a column; a steep stroke fills down (or up) to just short of the last dot, so
    // the line stays one dot thin and still unbroken.
    const toward = y > this.lastY ? this.lastY + 1 : y < this.lastY ? this.lastY - 1 : y
    this.top[x] = Math.min(y, toward)
    this.bottom[x] = Math.max(y, toward)
    this.written[x] = this.frameNo
    this.lastY = y
    this.head = (this.head + 1) % this.dotsWide
    for (let g = 1; g <= GAP; g++) {
      const ahead = (this.head + g - 1) % this.dotsWide
      this.top[ahead] = -1
      this.bottom[ahead] = -1
    }
  }

  private colorOf(dotColumn: number): number {
    const age = this.frameNo - (this.written[dotColumn] ?? 0)
    const fadeFrames = (this.dotsWide / SPEED) * FADE_SHARE
    const shade = age <= 1 ? 0 : Math.min(TRACE.length - 1, 1 + Math.floor((age / fadeFrames) * (TRACE.length - 2)))
    return TRACE[shade] ?? TRACE[TRACE.length - 1]!
  }

  frame(): string {
    const { words, columns, rows } = this
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < columns; cx++) {
        const i = (cy * columns + cx) * 3
        words[i] = SPACE
        words[i + 1] = DEFAULT_COLOR
        words[i + 2] = DEFAULT_COLOR
        if (cx >= this.traceColumns) continue
        let bits = 0
        let newest = -1
        for (let dx = 0; dx < 2; dx++) {
          const col = cx * 2 + dx
          const lo = this.top[col] ?? -1
          const hi = this.bottom[col] ?? -1
          if (lo < 0) continue
          let colBits = 0
          for (let dy = 0; dy < 4; dy++) {
            const row = cy * 4 + dy
            if (row >= lo && row <= hi) colBits |= DOT_BITS[dx]![dy]!
          }
          bits |= colBits
          if (colBits && (newest < 0 || (this.written[col] ?? 0) > (this.written[newest] ?? 0))) newest = col
        }
        if (bits) {
          words[i] = BRAILLE + bits
          words[i + 1] = this.colorOf(newest)
        } else if (cy === rows - 1 && cx % 6 === 0) {
          words[i] = 0x00b7 // a faint grid tick along the bottom
          words[i + 1] = GRID
        }
      }
    }
    if (this.traceColumns < columns) this.readout()
    return toBase64(new Uint8Array(words.buffer))
  }

  private readout(): void {
    const x = this.traceColumns + 2
    this.text('♥', x, 0, this.heartGlow > 0 ? HEART_ON : HEART_OFF)
    this.text(String(Math.round(this.bpm)).padStart(3), x + 2, 0, VALUE)
    this.text('bpm', x + 2, 1, LABEL)
    if (vitals.lastTool && this.rows > 3) this.text(vitals.lastTool.slice(0, READOUT_COLUMNS - 2), x, 3, LABEL)
  }

  private text(s: string, x: number, row: number, color: number): void {
    Array.from(s).forEach((ch, k) => {
      const cx = x + k
      if (cx >= this.columns || row >= this.rows) return
      const i = (row * this.columns + cx) * 3
      this.words[i] = ch.codePointAt(0) ?? SPACE
      this.words[i + 1] = color
      this.words[i + 2] = DEFAULT_COLOR
    })
  }
}

// Module state: a hot reload runs the module again and starts it over.
let scene: Monitor | null = null
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
    if (!scene || scene.columns !== columns || scene.rows !== rows) scene = new Monitor(columns, rows)
    site = e.requestId
    start($)
    const { Raster } = $.ui.resolve(e)
    return Raster({ key: RASTER_KEY, columns, rows, cells: scene.frame() })
  })

  // Observe only: count the call and hand it on untouched.
  on('tool.call', ($, e, next) => {
    vitals.activity += 1
    vitals.lastTool = String(e.tool).replace(/^mcp__[^_]+__/, '')
    vitals.pendingBeat = true
    return next(e)
  }).catch(($, e, next) => next(e)) // never stand in a tool call's way

  on('turn.complete', ($, e, next) => {
    stop()
    scene = null
    vitals.activity = 0
    vitals.lastTool = ''
    vitals.pendingBeat = false
    $.ui.invalidate('ui.render')
    return next(e)
  })
}
