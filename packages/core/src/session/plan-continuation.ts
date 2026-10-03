export * as PlanContinuation from "./plan-continuation"

import { PlanItems } from "./plan-items"

/**
 * 计划自动续跑的停滞保护：同一批待办在连续多轮没有变化时停止自动续跑，
 * 把控制权交还给用户。
 */
export const MAX_PLAN_STALLS = 2

interface Entry {
  hash: string
  stalls: number
}

const entries = new Map<string, Entry>()

export function resetPlanContinuation(sessionID: string): void {
  entries.delete(sessionID)
}

export function nextPlanContinuation(
  sessionID: string,
  content: string,
): { readonly item: PlanItems.PlanItem } | undefined {
  const progress = PlanItems.planProgress(content)
  if (progress.total === 0 || progress.pending.length === 0 || !progress.next) return undefined
  const hash = progress.pending.map((item) => item.text).join("\n")
  const existing = entries.get(sessionID)
  if (existing?.hash === hash) {
    existing.stalls += 1
    if (existing.stalls > MAX_PLAN_STALLS) return undefined
  } else {
    entries.set(sessionID, { hash, stalls: 0 })
  }
  return { item: progress.next }
}
