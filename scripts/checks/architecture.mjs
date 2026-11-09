import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const source = resolve(root, 'src')
const portable = file => file.split(sep).join('/')
const files = (await readdir(source, { recursive: true }))
  .filter(file => file.endsWith('.ts') && !portable(file).split('/').includes('__tests__'))
  .map(file => resolve(source, file))
const known = new Set(files)
const graph = new Map()
const allowed = {
  auth: new Set(['auth', 'config', 'validation.ts']),
  config: new Set(['config', 'protocols.ts', 'validation.ts']),
  gateway: new Set(['gateway', 'auth', 'config', 'protocols.ts', 'errors.ts', 'validation.ts']),
  codeplane: new Set(['codeplane', 'auth', 'config', 'validation.ts']),
}

for (const file of files) {
  const ast = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const imports = []
  const collect = node => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.fail(`Runtime dynamic imports must be declared in the architecture check: ${relative(root, file)}`)
    }
    ts.forEachChild(node, collect)
  }
  collect(ast)
  const layer = portable(relative(source, file)).split('/')[0]
  const dependencies = []
  for (const specifier of imports) {
    if (specifier.startsWith('node:')) continue
    assert(specifier.startsWith('.'), `Unexpected runtime dependency: ${specifier}`)
    const dependency = resolve(dirname(file), specifier)
    assert(
      known.has(dependency),
      `Production code must import production modules: ${relative(root, file)} -> ${specifier}`,
    )
    const target = portable(relative(source, dependency))
    if (allowed[layer]) {
      assert(allowed[layer].has(target.split('/')[0]), `Invalid dependency: ${relative(root, file)} -> ${target}`)
      if (layer !== 'auth' && target.startsWith('auth/')) {
        assert.equal(target, 'auth/types.ts', 'Business modules must not decode or encode host authentication.')
      }
    }
    dependencies.push(dependency)
  }
  graph.set(file, dependencies)
}

const checked = new Set()
function visit(file, trail = []) {
  assert(
    !trail.includes(file),
    `Circular module dependency: ${[...trail, file].map(item => relative(source, item)).join(' -> ')}`,
  )
  if (checked.has(file)) return
  for (const dependency of graph.get(file)) visit(dependency, [...trail, file])
  checked.add(file)
}
for (const file of files) visit(file)
console.log('Module ownership, production imports and acyclic dependencies verified.')
