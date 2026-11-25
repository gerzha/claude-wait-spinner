// Drives a spinner's real hooks module with a stand-in engine on a virtual clock and writes
// the frames it paints as JSON, for tools/render_gif.py. Also checks the band survives a dialog:
// blits refused for a while, then the band comes back and the animation must resume.
//
//   npx tsx tools/capture.mts plugins/<name>/hooks/register.ts out.json [frames] [columns] [rows]

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type Hook = (...args: any[]) => any
type Clock = { ms: number; fn: () => void; due: number; live: boolean }

const [modPath, outPath, framesArg = '120', columnsArg = '80', rowsArg = '7'] = process.argv.slice(2)
if (!modPath || !outPath) throw new Error('usage: capture.mts <register.ts> <out.json> [frames] [columns] [rows]')
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
let denyBlits = false
let invalidations = 0
let mounted = { cells: '', columns: 0, rows: 0 }
const painted: string[] = []

const $ = {
  clock: {
    every(ms: number, fn: () => void) {
      const c: Clock = { ms, fn, due: now + ms, live: true }
      clocks.push(c)
      return { cancel: () => void (c.live = false) }
    },
  },
  ui: {
    async blit(args: { cells: string; columns: number; rows: number }) {
      if (denyBlits) return { deny: 'not mounted' }
      mounted = { cells: args.cells, columns: args.columns, rows: args.rows }
      return {}
    },
    invalidate() {
      invalidations += 1
    },
    resolve() {
      return { Raster: (props: { cells: string; columns: number; rows: number }) => ({ type: 'Raster', props }) }
    },
  },
}

function render(isWorking = true) {
  const e = {
    surface: 'terminal',
    requestId: 'band',
    props: { isWorking, hasSurvey: false, isCollapsed: false, bodyColumns: COLUMNS, maxRows: ROWS },
  }
  const out = hooks['ui.render']![0]!($, e, () => null)
  if (out?.type === 'Raster') mounted = { cells: out.props.cells, columns: out.props.columns, rows: out.props.rows }
  return out
}

async function advance(ms: number) {
  const end = now + ms
  while (true) {
    const next = clocks.filter(c => c.live).sort((a, b) => a.due - b.due)[0]
    if (!next || next.due > end) break
    now = next.due
    next.due += next.ms
    next.fn()
    await Promise.resolve() // let the blit's .then run
    await Promise.resolve()
  }
  now = end
}

const liveTimers = () => clocks.filter(c => c.live).map(c => c.ms)

const mod = await import(pathToFileURL(resolve(modPath)).href)
mod.register(on, {})
if (!render()) throw new Error('the render hook drew nothing while working')

// 1. The demo: one painted frame per FRAME_MS tick; tool calls now and then.
for (let f = 0; f < FRAMES; f++) {
  if (hooks['tool.call'] && f % 17 === 8) {
    await hooks['tool.call'][0]!($, { tool: TOOLS[((f / 17) | 0) % TOOLS.length] }, async () => ({}))
  }
  await advance(60)
  painted.push(mounted.cells)
}
const distinct = new Set(painted).size
if (distinct < FRAMES / 2) throw new Error(`only ${distinct} distinct frames of ${FRAMES}: not animating`)

// 2. A dialog takes the band away: blits are refused, the fast loop must park, not die.
denyBlits = true
await advance(3000)
const parked = liveTimers()
if (parked.includes(60)) throw new Error(`still blitting at the frame rate while refused: timers ${parked}`)
if (!parked.length || invalidations === 0) throw new Error('loop stopped for good while the band was away')

// 3. The dialog closes: the engine answers the invalidation by calling the render hook again.
denyBlits = false
render()
const before = mounted.cells
await advance(600)
if (!liveTimers().includes(60) || mounted.cells === before) throw new Error('animation did not resume after the dialog')

// 4. The turn ends: everything stops.
render(false)
await (hooks['turn.complete']?.[0]?.($, {}, async () => ({})) ?? Promise.resolve())
if (liveTimers().length) throw new Error(`timers left after the turn: ${liveTimers()}`)

writeFileSync(outPath, JSON.stringify({ columns: mounted.columns || COLUMNS, rows: mounted.rows || ROWS, frames: painted }))
console.log(`${modPath}: ${FRAMES} frames, ${distinct} distinct; dialog park/resume ok; stops at turn end`)
