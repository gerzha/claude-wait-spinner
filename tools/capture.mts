// Drives a spinner's real hooks module with a stand-in engine on a virtual clock and writes
// the frames it paints as JSON, for tools/render_gif.py. Along the way it checks that:
// the band animates; it survives a dialog (blits refused for a while, then the band comes
// back and the animation must resume); it stops when the turn ends; and, for spinners that
// draw pictures, that a terminal without pictures gets half blocks instead.
//
//   npx tsx tools/capture.mts plugins/<name>/hooks/register.ts out.json [frames] [columns] [rows] [--no-pictures]

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type Hook = (...args: any[]) => any
type Clock = { ms: number; fn: () => void; due: number; live: boolean }
type Frame = { kind: 'image'; rgba: string; width: number; height: number } | { kind: 'raster'; cells: string }

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const noPictures = process.argv.includes('--no-pictures')
const [modPath, outPath, framesArg = '120', columnsArg = '80', rowsArg = '7'] = args
if (!modPath || !outPath) throw new Error('usage: capture.mts <register.ts> <out.json> [frames] [columns] [rows] [--no-pictures]')
const FRAMES = Number(framesArg)
const COLUMNS = Number(columnsArg)
const ROWS = Number(rowsArg)
const TOOLS = ['Read', 'Bash', 'Grep', 'Edit', 'Bash', 'WebSearch', 'Write', 'Bash']

const hooks: Record<string, Hook[]> = {}
const on = (event: string, matcherOrHook: unknown, maybeHook?: Hook) => {
  const hook = (maybeHook ?? matcherOrHook) as Hook
  ;(hooks[event] ??= []).push(hook)
  return { catch: () => undefined }
}

let now = 0
const clocks: Clock[] = []
let mountedKind: 'image' | 'raster' | null = null
let bandShown = true // false while a dialog holds the screen
let engineRedraws = true // the engine answers an invalidation by calling the render hook
let invalidations = 0
let current: Frame | null = null
let frameMs: number[] = []

const $ = {
  clock: {
    every(ms: number, fn: () => void) {
      const c: Clock = { ms, fn, due: now + ms, live: true }
      clocks.push(c)
      return { cancel: () => void (c.live = false) }
    },
  },
  ui: {
    async blit(a: { source?: { rgba: string; width: number; height: number }; cells?: string }) {
      if (!bandShown || !mountedKind) return { deny: 'nothing of this plugin is mounted there' }
      if (a.source) {
        if (mountedKind !== 'image') return { deny: 'not the mounted element' }
        if (noPictures) return { deny: 'the Image draws its `alt` there: no placeholder images' }
        current = { kind: 'image', rgba: a.source.rgba, width: a.source.width, height: a.source.height }
      } else if (a.cells) {
        if (mountedKind !== 'raster') return { deny: 'not the mounted element' }
        current = { kind: 'raster', cells: a.cells }
      }
      return {}
    },
    invalidate() {
      invalidations += 1
      if (engineRedraws) queueMicrotask(() => render())
    },
    resolve() {
      return {
        Raster: (props: { cells: string }) => ({ type: 'Raster', props }),
        Image: (props: { source: { rgba: string; width: number; height: number } }) => ({ type: 'Image', props }),
      }
    },
  },
}

let lastColumns = COLUMNS
let lastRows = ROWS
let working = true
function render(isWorking = working) {
  const e = {
    surface: 'terminal',
    requestId: 'band',
    props: { isWorking, hasSurvey: false, isCollapsed: false, bodyColumns: COLUMNS, maxRows: ROWS },
  }
  const out = hooks['ui.render']![0]!($, e, () => null)
  mountedKind = null
  if (out?.type === 'Raster') {
    mountedKind = 'raster'
    current = { kind: 'raster', cells: out.props.cells }
    lastColumns = out.props.columns
    lastRows = out.props.rows
  } else if (out?.type === 'Image') {
    mountedKind = 'image'
    if (!noPictures) current = { kind: 'image', ...out.props.source }
    lastColumns = out.props.columns
    lastRows = out.props.rows
  }
  return out
}

async function advance(ms: number) {
  const end = now + ms
  while (true) {
    const next = clocks.filter(c => c.live).sort((a, b) => a.due - b.due)[0]
    if (!next || next.due > end) break
    now = next.due
    next.due += next.ms
    const t0 = performance.now()
    next.fn()
    if (next.ms < 200) frameMs.push(performance.now() - t0)
    for (let i = 0; i < 4; i++) await Promise.resolve() // let the blit's .then and redraws run
  }
  now = end
}

const liveTimers = () => clocks.filter(c => c.live).map(c => c.ms)
const frameRate = () => Math.min(...clocks.filter(c => c.live).map(c => c.ms))

const mod = await import(pathToFileURL(resolve(modPath)).href)
mod.register(on, {})
if (!render()) throw new Error('the render hook drew nothing while working')

// 1. The demo, one frame per tick; tool calls now and then.
await advance(200) // a terminal without pictures shows itself on the first blits
const painted: Frame[] = []
const tick = frameRate()
for (let f = 0; f < FRAMES; f++) {
  if (hooks['tool.call'] && f % 17 === 8) {
    await hooks['tool.call'][0]!($, { tool: TOOLS[((f / 17) | 0) % TOOLS.length] }, async () => ({}))
  }
  await advance(tick)
  painted.push(current!)
}
const kinds = new Set(painted.map(p => p.kind))
if (noPictures && kinds.has('image')) throw new Error('pictures sent to a terminal that cannot draw them')
const distinct = new Set(painted.map(p => (p.kind === 'image' ? p.rgba : p.cells))).size
if (distinct < FRAMES / 2) throw new Error(`only ${distinct} distinct frames of ${FRAMES}: not animating`)

// 2. A dialog takes the band away: blits are refused, the fast loop must park, not die.
bandShown = false
engineRedraws = false
const invalidationsBefore = invalidations
await advance(3000)
const parked = liveTimers()
if (parked.includes(tick)) throw new Error(`still blitting at the frame rate while refused: timers ${parked}`)
if (!parked.length || invalidations === invalidationsBefore) throw new Error('loop stopped for good while the band was away')

// 3. The dialog closes: the engine calls the render hook again; the animation must resume.
bandShown = true
engineRedraws = true
render()
const before = JSON.stringify(current)
await advance(600)
if (!liveTimers().includes(tick) || JSON.stringify(current) === before) throw new Error('animation did not resume after the dialog')

// 4. The turn ends: everything stops.
working = false
render()
await (hooks['turn.complete']?.[0]?.($, {}, async () => ({})) ?? Promise.resolve())
await advance(1000)
if (liveTimers().length) throw new Error(`timers left after the turn: ${liveTimers()}`)

frameMs.sort((a, b) => a - b)
const p50 = frameMs[(frameMs.length / 2) | 0]?.toFixed(1)
const p95 = frameMs[(frameMs.length * 0.95) | 0]?.toFixed(1)
writeFileSync(outPath, JSON.stringify({ columns: lastColumns, rows: lastRows, frameMs: tick, frames: painted }))
console.log(
  `${modPath}: ${FRAMES} ${[...kinds].join('+')} frames (${distinct} distinct) every ${tick} ms; ` +
    `frame time p50 ${p50} ms, p95 ${p95} ms; dialog park/resume ok; stops at turn end`,
)
