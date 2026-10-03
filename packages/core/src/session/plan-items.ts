export * as PlanItems from "./plan-items"

/**
 * 计划条目（Markdown checkbox）解析与更新。
 *
 * 计划文件是唯一事实源：`- [ ]` 待办、`- [x]` 完成、`- [!]` 阻塞。
 * 完成条目必须携带验证证据（evidence），写入条目下方的缩进 Evidence 行。
 */
export type PlanItemStatus = "pending" | "done" | "blocked"

export interface PlanItem {
  /** 0-based 行号。 */
  readonly line: number
  readonly status: PlanItemStatus
  readonly text: string
}

export interface PlanProgress {
  readonly total: number
  readonly pending: PlanItem[]
  readonly done: PlanItem[]
  readonly blocked: PlanItem[]
  readonly next?: PlanItem
}

const ITEM_PATTERN = /^(\s*)([-*])\s+\[( |x|X|!)\]\s+(.*\S)\s*$/
const EVIDENCE_PATTERN = /^(\s+)[-*]\s+Evidence:\s*(.*\S)\s*$/i

function statusOf(marker: string): PlanItemStatus {
  if (marker === "!") return "blocked"
  if (marker === " ") return "pending"
  return "done"
}

export function parsePlanItems(content: string): PlanItem[] {
  return content.split(/\r?\n/).flatMap((line, index) => {
    const match = ITEM_PATTERN.exec(line)
    if (!match) return []
    return [{ line: index, status: statusOf(match[3]!), text: match[4]! }]
  })
}

export function planProgress(content: string): PlanProgress {
  const items = parsePlanItems(content)
  const pending = items.filter((item) => item.status === "pending")
  const done = items.filter((item) => item.status === "done")
  const blocked = items.filter((item) => item.status === "blocked")
  return {
    total: items.length,
    pending,
    done,
    blocked,
    ...(pending[0] ? { next: pending[0] } : {}),
  }
}

export class PlanItemError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanItemError"
  }
}

export function updatePlanItem(input: {
  content: string
  item: string
  status: PlanItemStatus
  evidence?: string
  note?: string
}): { content: string; item: PlanItem } {
  const requested = input.item.trim()
  if (!requested) throw new PlanItemError("plan_update requires a non-empty item text")
  const evidence = input.evidence?.trim()
  const note = input.note?.trim()
  if (input.status === "done" && !evidence)
    throw new PlanItemError("Marking a plan item done requires verification evidence")

  const items = parsePlanItems(input.content)
  const matches = items.filter((item) => item.text === requested)
  const candidates = matches.length > 0 ? matches : items.filter((item) => item.text.includes(requested))
  if (candidates.length === 0) throw new PlanItemError(`Plan item not found: ${requested}`)
  if (candidates.length > 1)
    throw new PlanItemError(
      `Plan item is ambiguous (${candidates.length} matches): ${requested}; use the exact item text`,
    )
  const target = candidates[0]!
  const lines = input.content.split(/\r?\n/)
  const source = lines[target.line]!
  const match = ITEM_PATTERN.exec(source)!
  const marker = input.status === "done" ? "x" : input.status === "blocked" ? "!" : " "
  lines[target.line] = `${match[1]}${match[2]} [${marker}] ${target.text}`
  const detail = evidence ?? note
  if (detail) {
    const next = lines[target.line + 1]
    const evidenceMatch = next === undefined ? null : EVIDENCE_PATTERN.exec(next)
    if (evidenceMatch) lines[target.line + 1] = `${match[1]}  - Evidence: ${detail}`
    else lines.splice(target.line + 1, 0, `${match[1]}  - Evidence: ${detail}`)
  }
  const updated: PlanItem = { line: target.line, status: input.status, text: target.text }
  return { content: lines.join("\n"), item: updated }
}

export function renderPlanProgress(progress: PlanProgress): string {
  return [
    `Plan progress: ${progress.done.length}/${progress.total} done, ${progress.pending.length} pending, ${progress.blocked.length} blocked`,
    ...(progress.next ? [`Next item: ${progress.next.text}`] : []),
    ...(progress.pending.length > 0
      ? ["", "Pending items:", ...progress.pending.map((item) => `- ${item.text}`)]
      : []),
    ...(progress.blocked.length > 0
      ? ["", "Blocked items:", ...progress.blocked.map((item) => `- ${item.text}`)]
      : []),
  ].join("\n")
}
