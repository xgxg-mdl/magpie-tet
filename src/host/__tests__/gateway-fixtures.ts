import { parseUsage } from '../../gateway/usage.ts'
import { presentGatewayUsage } from '../gateway-presentation.ts'

export const mapUsage = (raw: unknown, options: { showTraffic?: boolean } = {}) =>
  presentGatewayUsage(parseUsage(raw), options)
