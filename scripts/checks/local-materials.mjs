import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getFileInfo } from 'prettier'

/**
 * 校验本地材料的仓库与格式化边界，不读取本地材料内容。
 * @param root 待检查的 Git 仓库根目录。
 * @returns 忽略规则生效且索引中没有本地材料时完成。
 * @throws 整目录忽略规则缺失、失效或本地材料已跟踪／暂存时拒绝。
 */
export async function checkLocalMaterials(root) {
  for (const name of ['.gitignore', '.prettierignore']) {
    const rules = (await readFile(join(root, name), 'utf8')).split(/\r?\n/)
    assert(
      rules.some(line => /^\/?docs\/local\/$/.test(line.trim())),
      `${name} must ignore the whole docs/local/ directory.`,
    )
  }
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.error?.message ?? result.stderr)
    return result.stdout
  }
  git(['check-ignore', '--quiet', '--no-index', 'docs/local/'])
  const indexed = git(['ls-files', '--cached', '-z', '--', 'docs/local'])
  assert(!indexed, 'docs/local/ must not contain tracked or staged files.')
  // 使用不存在的路径检查边界，CI 无需携带本机目录或认证文件。
  for (const path of [
    'docs/local/__ignore_probe__.md',
    'docs/local/private/__ignore_probe__.json',
    'docs/local/probes/__ignore_probe__.mjs',
    'docs/local/runs/__ignore_probe__.json',
  ]) {
    git(['check-ignore', '--quiet', '--no-index', path])
    const info = await getFileInfo(join(root, path), { ignorePath: join(root, '.prettierignore') })
    assert(info.ignored, 'Prettier must ignore docs/local/ and its contents.')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkLocalMaterials(fileURLToPath(new URL('../../', import.meta.url)))
  console.log('Local materials are ignored by Git and Prettier and absent from the index.')
}
