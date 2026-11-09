import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))

/**
 * 从已有构建和白名单重建发布目录及对应归档；调用前须完成 build。
 * @param destination 可删除并重建的独立输出目录。
 * @param options 可选源码标签与完整提交 SHA，用于校验版本和记录来源。
 * @returns 不含开发依赖及生命周期脚本的发布清单；归档和版本说明写入输出目录的父目录。
 * @throws 版本、标签、提交、构建文件清单或归档操作不符合要求时拒绝。
 */
export async function prepareRelease(destination, { tag, commit } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'Release versions must be stable X.Y.Z versions.')
  if (tag !== undefined) assert.equal(tag, 'v' + pkg.version, 'Tag must match package.json version.')
  if (commit !== undefined) assert.match(commit, /^[a-f0-9]{40}$/, 'Source commit must be a full SHA.')
  const changelog = (await readFile(join(root, 'CHANGELOG.md'), 'utf8')).split('\n')
  const heading = changelog.findIndex(line => line.startsWith('## ' + pkg.version + '（'))
  assert(heading >= 0, 'CHANGELOG.md must contain the release version.')
  const following = changelog.slice(heading + 1)
  const next = following.findIndex(line => line.startsWith('## '))
  const notes = following
    .slice(0, next < 0 ? undefined : next)
    .join('\n')
    .trim()
  assert(notes, 'Release notes must not be empty.')
  assert.deepEqual((await readdir(join(root, 'dist'))).sort(), ['index.mjs', 'index.mjs.map'])
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const file of ['dist', 'README.md', 'LICENSE'])
    await cp(join(root, file), join(destination, file), { recursive: true })
  const { scripts, devDependencies, packageManager, ...metadata } = pkg
  const manifest = {
    ...metadata,
    main: './dist/index.mjs',
    exports: './dist/index.mjs',
    files: ['dist', 'README.md', 'LICENSE'],
    ...(commit ? { gitHead: commit } : {}),
  }
  await writeFile(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(dirname(destination), 'notes.md'), notes + '\n')
  const temporary = await mkdtemp(join(tmpdir(), 'tet-package-index-'))
  try {
    const git = args => {
      const result = spawnSync('git', args, {
        cwd: destination,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_DIR: join(root, '.git'),
          GIT_WORK_TREE: resolve(destination),
          GIT_INDEX_FILE: join(temporary, 'index'),
        },
      })
      assert.equal(result.status, 0, result.error?.message ?? result.stderr)
      return result.stdout.trim()
    }
    git(['read-tree', '--empty'])
    git(['add', '--all', '--force', '.'])
    // Git 将时间戳 0 当作未指定，必须使用非零固定时间保证重跑归档一致。
    git([
      'archive',
      '--format=tar.gz',
      '--prefix=package/',
      '--mtime=2000-01-01T00:00:00Z',
      '--output=' + resolve(dirname(destination), `TET-v${pkg.version}.tar.gz`),
      git(['write-tree']),
    ])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = join(root, '.release/package')
  await prepareRelease(destination, {
    ...(process.env.GITHUB_REF_TYPE === 'tag' ? { tag: process.env.GITHUB_REF_NAME } : {}),
    ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}),
  })
  console.log('Prepared the GitHub Release archive and notes.')
}
