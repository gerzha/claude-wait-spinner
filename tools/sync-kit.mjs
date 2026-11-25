// Copies shared/kit.ts into every spinner that draws with it (plugins/*/hooks/register.ts
// importing './kit'). Each plugin must stay self-contained, so the kit travels as a copy.
//   node tools/sync-kit.mjs
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const kit = readFileSync(join(root, 'shared/kit.ts'), 'utf8')
const header = '// GENERATED from shared/kit.ts by tools/sync-kit.mjs; edit that file instead.\n'
for (const name of readdirSync(join(root, 'plugins'))) {
  const register = join(root, 'plugins', name, 'hooks/register.ts')
  if (!existsSync(register) || !readFileSync(register, 'utf8').includes("from './kit'")) continue
  writeFileSync(join(root, 'plugins', name, 'hooks/kit.ts'), header + kit)
  console.log(`kit -> plugins/${name}/hooks/kit.ts`)
}
