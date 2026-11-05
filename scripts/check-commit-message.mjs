import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function validateCommitMessage(message) {
  const lines = message.replace(/\r\n/g, '\n').trimEnd().split('\n')
  const title = lines.shift() || ''
  const header = /^(feat|fix|refactor|perf|docs|test|style|build|ci|chore|revert)(\([a-z][a-z0-9-]*\))?(!)?: \S.*$/
  if (!header.test(title)) return '标题须使用 type(scope): 描述 格式，范围可省略'
  if (/[.。]$/.test(title)) return '标题末尾不加句号'
  if (title.includes('!:') && !lines.some(line => /^BREAKING[ -]CHANGE: \S/.test(line))) {
    return '破坏性变更须用 BREAKING CHANGE: 页脚说明影响和迁移方式'
  }
  if (!lines.length) return
  if (lines.shift() !== '') return '标题与正文之间须空一行'

  let footer = false
  let previousBlank = true
  let listItem = false
  for (const line of lines) {
    if (!line) {
      previousBlank = true
      listItem = false
      continue
    }
    const trailer = /^(BREAKING CHANGE|BREAKING-CHANGE|[A-Za-z][A-Za-z0-9-]*)(: | #)\S/.test(line)
    if (trailer && (footer || previousBlank)) footer = true
    else if (footer) {
      if (!/^  \S/.test(line)) return '页脚续行须缩进两个空格'
    } else if (/^- \S/.test(line)) listItem = true
    else if (!(listItem && /^  \S/.test(line))) return '正文须使用 - 无序列表，续行缩进两个空格'
    previousBlank = false
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const error = validateCommitMessage(readFileSync(process.argv[2], 'utf8'))
  if (error) {
    console.error('提交信息检查失败：' + error)
    process.exitCode = 1
  }
}
