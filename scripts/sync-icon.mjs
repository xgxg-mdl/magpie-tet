import { readFile, writeFile } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
const pkgPath = new URL('package.json', root)
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
const svg = await readFile(new URL('assets/logo.svg', root))
pkg.magpie = { ...pkg.magpie, icon: 'data:image/svg+xml;base64,' + svg.toString('base64') }
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
