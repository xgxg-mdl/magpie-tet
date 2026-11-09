import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { prepareRelease } from '../../scripts/release/prepare.mjs'

test('release staging contains a runnable package without source or install scripts', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'tet-stage-test-'))
  try {
    const manifest = await prepareRelease(join(temporary, 'package'))
    const notes = await readFile(join(temporary, 'notes.md'), 'utf8')
    assert(notes.trim().length > 0)
    assert(!notes.includes('## '))
    assert.equal(manifest.main, './dist/index.mjs')
    assert.equal(manifest.exports, './dist/index.mjs')
    assert.equal('scripts' in manifest, false)
    assert.equal('devDependencies' in manifest, false)
    assert.equal('packageManager' in manifest, false)
    assert.equal((await readFile(join(temporary, 'package/dist/index.mjs'), 'utf8')).includes('TetPlugin'), true)
    const archivePath = join(temporary, `TET-v${manifest.version}.tar.gz`)
    const archive = await readFile(archivePath)
    const header = gunzipSync(archive).subarray(0, 512)
    assert.equal(parseInt(header.subarray(136, 148).toString().replace(/\0/g, '').trim(), 8), 946684800)
    await prepareRelease(join(temporary, 'package'))
    assert.deepEqual(await readFile(archivePath), archive)
    await assert.rejects(prepareRelease(join(temporary, 'wrong'), { tag: 'v999.0.0' }), /Tag must match/)
    await assert.rejects(prepareRelease(join(temporary, 'wrong'), { commit: 'short' }), /full SHA/)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
