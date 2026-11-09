import { readFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const destination = join(root, 'dist')
const svg = await readFile(join(root, 'assets/logo.svg'))
const icon = 'data:image/svg+xml;base64,' + svg.toString('base64')
const result = await Bun.build({
  entrypoints: [join(root, 'src/index.ts')],
  root,
  target: 'node',
  format: 'esm',
  naming: 'index.mjs',
  sourcemap: 'external',
  minify: false,
  splitting: false,
  external: ['node:*'],
  env: 'disable',
  plugins: [
    {
      name: 'inline-provider-icon',
      setup(build) {
        build.onLoad({ filter: /[/\\]src[/\\]icon\.ts$/ }, () => ({
          contents: `export const icon = ${JSON.stringify(icon)}`,
          loader: 'js',
        }))
      },
    },
  ],
})
if (!result.success) throw new AggregateError(result.logs, 'Plugin build failed.')
const artifacts = new Map(
  await Promise.all(result.outputs.map(async output => [basename(output.path), await output.text()])),
)
assert.deepEqual([...artifacts.keys()].sort(), ['index.mjs', 'index.mjs.map'])
artifacts.set('index.mjs', artifacts.get('index.mjs') + '\n//# sourceMappingURL=index.mjs.map\n')

if (process.argv.includes('--check')) {
  assert.deepEqual((await readdir(destination)).sort(), [...artifacts.keys()].sort(), 'Unexpected release artifacts.')
  for (const [name, contents] of artifacts) {
    assert.equal(await readFile(join(destination, name), 'utf8'), contents, `Stale ${name}; run bun run build.`)
  }
  console.log('Build matches TypeScript sources and icon.')
} else {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const [name, contents] of artifacts) await writeFile(join(destination, name), contents)
  console.log('Built dist/index.mjs with embedded icon and source map.')
}
