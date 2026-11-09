import assert from 'node:assert/strict'
import { record as isRecord } from '../../src/validation.ts'

export function present<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, 'Expected a value to be present')
  return value
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), 'Expected an object')
  return value
}

export async function rejected(task: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await task
  } catch (error) {
    assert.ok(error instanceof Error, 'Expected an Error rejection')
    assert.ok(isRecord(error), 'Expected error details')
    return error
  }
  assert.fail('Expected the operation to reject')
}
