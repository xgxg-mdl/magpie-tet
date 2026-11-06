import { expect, test } from 'bun:test'
import { validateCommitMessage } from '../../scripts/check-commit-message.mjs'

test('accepts conventional titles, bullet continuations and separate trailers', () => {
  for (const message of [
    'fix(usage): 调整余额格式\n',
    'docs: 补充说明\n\n- 说明修改原因\n  保留必要边界\n- 更新示例\n\nRefs: #1\n',
    'feat(api)!: 调整接口\n\n- 删除旧入口\n\nBREAKING CHANGE: 改用新入口\n',
  ])
    expect(validateCommitMessage(message)).toBeUndefined()
})

test('rejects malformed titles, paragraphs and misplaced trailers', () => {
  for (const message of [
    '调整余额格式',
    'fix(Usage): 调整余额格式',
    'fix: 调整余额格式。',
    'fix: 调整余额格式\n- 说明修改',
    'fix: 调整余额格式\n\n正文段落',
    'fix: 调整余额格式\n\n- 修改\nRefs: #1',
    'fix: 调整余额格式\n\n- 修改\n\n  无所属条目',
    'feat!: 调整接口\n\n- 删除入口',
    'feat!: 调整接口',
  ])
    expect(validateCommitMessage(message)).toBeString()
})
