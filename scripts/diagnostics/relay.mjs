import { pathToFileURL } from 'node:url'
import { probeRelay } from './relay-probe.mjs'
import { ProbeError } from './response-reader.mjs'

const HELP = `Usage: bun run test:relay -- [options]

Read-only by default: verify the TET plugin model catalog and usage hooks.
TET_API_KEY supplies the credential; TET_BASE_URL supplies the API base URL.

  --base-url URL   Override TET_BASE_URL, including the API path prefix
  --allow-http     Permit sending credentials over unencrypted HTTP
  --generate      Send up to two billable Responses requests
  --tools         Add two billable function-call/result checks (requires --generate)
  --structured    Add one billable JSON schema check (requires --generate)
  --model ID      Explicit plugin model ID required with --generate
  --help          Show this help without reading credentials or making requests

Only plugin-supported model IDs and probe status are printed.
`

function argumentsFor(args) {
  const options = {}
  const flags = {
    '--base-url': 'baseURL',
    '--model': 'model',
    '--generate': 'generate',
    '--tools': 'tools',
    '--structured': 'structured',
    '--allow-http': 'allowHTTP',
    '--help': 'help',
  }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    const key = Object.hasOwn(flags, flag) ? flags[flag] : undefined
    if (!key || Object.hasOwn(options, key)) throw new ProbeError('Invalid command-line arguments. Use --help.')
    const value = key === 'baseURL' || key === 'model' ? args[++index] : true
    if ((typeof value === 'string' && value.startsWith('--')) || value === undefined)
      throw new ProbeError('A command-line option value is missing. Use --help.')
    options[key] = value
  }
  if (
    !options.help &&
    ((options.generate && !options.model) ||
      (options.model && !options.generate) ||
      ((options.tools || options.structured) && !options.generate))
  ) {
    throw new ProbeError('Use --generate together with an explicit --model ID.')
  }
  return options
}

/**
 * 解析命令行参数并执行显式授权的网关探测，帮助模式不读取凭据。
 * @param {string[]} args 不含运行时与脚本路径的参数列表。
 * @param {Record<string, string | undefined>} env 网关地址与 Key 的环境变量来源。
 * @param {{log: (text: string) => unknown, error: (text: string) => unknown}} io 输出安全摘要与固定错误文本的终端接口。
 * @returns 成功或帮助返回 0，参数或诊断失败返回 1。
 */
export async function runCLI(args, env = process.env, io = console) {
  try {
    const { help, ...options } = argumentsFor(args)
    if (help) {
      io.log(HELP)
      return 0
    }
    if (options.generate)
      io.error(
        'Generation probes send up to ' +
          (2 + (options.tools ? 2 : 0) + (options.structured ? 1 : 0)) +
          ' billable requests.',
      )
    const result = await probeRelay({ ...options, baseURL: options.baseURL ?? env.TET_BASE_URL, key: env.TET_API_KEY })
    io.log(JSON.stringify(result, null, 2))
    return 0
  } catch (error) {
    io.error(error instanceof ProbeError ? error.message : 'TET relay probe failed.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCLI(process.argv.slice(2))
}
