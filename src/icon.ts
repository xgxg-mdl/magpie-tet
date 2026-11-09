import { readFileSync } from 'node:fs'

/** 供应商图标的 SVG data URI；源码加载时读取资产，发布构建将其内嵌。 */
export const icon =
  'data:image/svg+xml;base64,' + readFileSync(new URL('../assets/logo.svg', import.meta.url)).toString('base64')
