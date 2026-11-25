import type { Register } from 'claude-code'
import { band, Gfx, mix, rand, randInt, textWidth, type Scene } from './kit'

// Two light cycles race on a neon grid in the band above the prompt while a model turn runs:
// Claude orange against cyan. Each leaves a wall of light; whoever runs into a wall derezzes,
// the round goes to the other, and the arena clears for the next one.

const FLOOR_TOP = 0x02060a
const FLOOR_BOTTOM = 0x040b12
const GRID = 0x15526b
const ORANGE = 0xff8a3d
const CYAN = 0x3fe6ff
const STEP_FRAMES = 2 // frames per grid cell
const ROUND_PAUSE = 28 // frames between a crash and the next round

type Dir = { dx: number; dy: number }
type Cycle = {
  color: number
  x: number
  y: number
  dir: Dir
  corners: Array<[number, number]> // trail: start, turns; the head is (x, y)
  alive: boolean
  wins: number
}
type Shard = { x: number; y: number; vx: number; vy: number; life: number; color: number }

const LEFT = (d: Dir): Dir => ({ dx: d.dy, dy: -d.dx })
const RIGHT = (d: Dir): Dir => ({ dx: -d.dy, dy: d.dx })

class Arena implements Scene {
  private readonly grid: Uint8Array
  private readonly cycles: Cycle[]
  private shards: Shard[] = []
  private frameNo = 0
  private pause = 0
  private fade = 1

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.grid = new Uint8Array(width * height)
    this.cycles = [
      { color: ORANGE, x: 0, y: 0, dir: { dx: 1, dy: 0 }, corners: [], alive: true, wins: 0 },
      { color: CYAN, x: 0, y: 0, dir: { dx: -1, dy: 0 }, corners: [], alive: true, wins: 0 },
    ]
    this.reset()
  }

  private reset(): void {
    this.grid.fill(0)
    const [a, b] = this.cycles as [Cycle, Cycle]
    const top = Math.max(1, Math.round(this.height * 0.25))
    const bottom = Math.min(this.height - 2, Math.round(this.height * 0.75) - 1)
    Object.assign(a, { x: 2, y: top, dir: { dx: 1, dy: 0 }, alive: true })
    Object.assign(b, { x: this.width - 3, y: bottom, dir: { dx: -1, dy: 0 }, alive: true })
    for (const [i, c] of this.cycles.entries()) {
      c.corners = [[c.x, c.y]]
      this.grid[c.y * this.width + c.x] = i + 1
    }
    this.fade = 1
  }

  private free(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height && this.grid[y * this.width + x] === 0
  }

  // Free cells reachable from (x, y), counted up to a cap.
  private room(x: number, y: number, cap = 90): number {
    if (!this.free(x, y)) return 0
    const seen = new Set<number>([y * this.width + x])
    const queue: Array<[number, number]> = [[x, y]]
    while (queue.length && seen.size < cap) {
      const [cx, cy] = queue.shift()!
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as Array<[number, number]>) {
        const k = ny * this.width + nx
        if (!seen.has(k) && this.free(nx, ny)) {
          seen.add(k)
          queue.push([nx, ny])
        }
      }
    }
    return seen.size
  }

  private decide(c: Cycle): Dir {
    const options = [c.dir, LEFT(c.dir), RIGHT(c.dir)].map((dir, i) => {
      const room = this.room(c.x + dir.dx, c.y + dir.dy)
      // keep straight unless boxed in; now and then swerve for show
      const bias = i === 0 ? 6 : Math.random() < 0.06 ? 12 : 0
      return { dir, score: room === 0 ? -1 : room + bias + rand(0, 3) }
    })
    options.sort((p, q) => q.score - p.score)
    return options[0]!.dir
  }

  step(): void {
    this.frameNo += 1
    for (const s of this.shards) {
      s.x += s.vx
      s.y += s.vy
      s.vx *= 0.9
      s.vy *= 0.9
      s.life -= 1
    }
    this.shards = this.shards.filter(s => s.life > 0)
    if (this.pause > 0) {
      this.pause -= 1
      this.fade = Math.min(1, this.pause / 12)
      if (this.pause === 0) this.reset()
      return
    }
    if (this.frameNo % STEP_FRAMES !== 0) return
    const moving = this.cycles.filter(c => c.alive)
    for (const c of moving) {
      const dir = this.decide(c)
      if (dir.dx !== c.dir.dx || dir.dy !== c.dir.dy) c.corners.push([c.x, c.y])
      c.dir = dir
    }
    const targets = moving.map(c => [c.x + c.dir.dx, c.y + c.dir.dy] as [number, number])
    moving.forEach((c, i) => {
      const [nx, ny] = targets[i]!
      const headOn = targets.some((t, j) => j !== i && t[0] === nx && t[1] === ny)
      if (!this.free(nx, ny) || headOn) {
        c.alive = false
        this.derez(c)
        return
      }
      c.x = nx
      c.y = ny
      this.grid[ny * this.width + nx] = this.cycles.indexOf(c) + 1
    })
    const alive = this.cycles.filter(c => c.alive)
    if (alive.length < this.cycles.length) {
      if (alive.length === 1) alive[0]!.wins += 1
      this.pause = ROUND_PAUSE
    }
  }

  private derez(c: Cycle): void {
    for (let i = 0; i < 22; i++) {
      const angle = rand(0, Math.PI * 2)
      const speed = rand(0.15, 0.9)
      this.shards.push({ x: c.x + 0.5, y: c.y + 0.5, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed * 0.6, life: randInt(10, 24), color: c.color })
    }
  }

  draw(g: Gfx): void {
    g.sky(FLOOR_TOP, FLOOR_BOTTOM)
    for (let x = 0; x <= this.width; x += 3) g.rect(x, 0, 0.14, this.height, GRID, 0.55)
    for (let y = 0; y <= this.height; y += 3) g.rect(0, y, this.width, 0.14, GRID, 0.55)
    const sub = this.pause > 0 ? 0 : (this.frameNo % STEP_FRAMES) / STEP_FRAMES
    for (const c of this.cycles) {
      const alpha = (c.alive ? 1 : 0.8) * (this.pause > 0 ? this.fade : 1)
      if (alpha <= 0.02) continue
      const headX = c.x + 0.5 + (c.alive ? c.dir.dx * sub : 0)
      const headY = c.y + 0.5 + (c.alive ? c.dir.dy * sub : 0)
      const pts = [...c.corners.map(([x, y]) => [x + 0.5, y + 0.5] as [number, number]), [headX, headY] as [number, number]]
      const core = mix(c.color, 0xffffff, 0.45)
      for (let i = 1; i < pts.length; i++) {
        const [xa, ya] = pts[i - 1]!
        const [xb, yb] = pts[i]!
        g.line(xa, ya, xb, yb, 0.34, core, alpha, 0.9 * alpha)
      }
      if (c.alive) this.drawBike(g, headX, headY, c)
    }
    for (const s of this.shards) {
      const f = s.life / 24
      g.rect(s.x - 0.2, s.y - 0.2, 0.4, 0.4, mix(s.color, 0xffffff, 0.3), Math.min(1, f * 1.6))
      g.glow(s.x, s.y, 0.9, s.color, 0.5 * f)
    }
    const [a, b] = this.cycles as [Cycle, Cycle]
    const size = 0.3
    const parts: Array<[string, number]> = [[String(a.wins), ORANGE], [':', 0x7d8a96], [String(b.wins), CYAN]]
    let x = this.width / 2 - textWidth(parts.map(p => p[0]).join(''), size) / 2
    for (const [text, color] of parts) {
      g.text(text, x, 0.6, size, color, 0.9)
      x += text.length * 4 * size
    }
  }

  private drawBike(g: Gfx, x: number, y: number, c: Cycle): void {
    const { dx, dy } = c.dir
    const bx = x - dx * 2
    const by = y - dy * 2
    g.glow(x - dx * 0.6, y - dy * 0.6, 3, c.color, 0.75)
    // body, a canopy stripe, two wheels and a headlight
    g.line(bx, by, x + dx * 0.6, y + dy * 0.6, 1.25, 0x0b1218, 1)
    g.line(bx, by, x + dx * 0.6, y + dy * 0.6, 1.25, c.color, 0.3)
    g.line(bx + dx * 0.4, by + dy * 0.4, x + dx * 0.2, y + dy * 0.2, 0.36, mix(c.color, 0xffffff, 0.55))
    g.ring(bx + dx * 0.35, by + dy * 0.35, 0.42, 0.14, c.color, 0.9)
    g.ring(x + dx * 0.1, y + dy * 0.1, 0.42, 0.14, c.color, 0.9)
    g.disc(x + dx * 0.62, y + dy * 0.62, 0.22, 0xffffff)
    g.glow(x + dx * 1.2, y + dy * 1.2, 1.6, 0xffffff, 0.35)
  }
}

export const register: Register = on =>
  band(on, {
    key: 'cycles',
    alt: ' ',
    rows: 7,
    minColumns: 30,
    background: FLOOR_BOTTOM,
    make: (width, height) => new Arena(width, height),
  })
