/**
 * 判断值能否按字符串键读取对象属性，不验证具体领域字段。
 * @param value 尚未校验的外部值。
 * @returns 非 null、非数组的对象返回 true，并收窄为未知字段记录。
 */
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 判断值是否为有限数值，不进行字符串转换或范围校验。
 * @param value 尚未校验的数值候选。
 * @returns number 且不为 NaN 或正负无穷时返回 true。
 */
export function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
