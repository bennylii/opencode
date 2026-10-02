import type { Part } from "@opencode-ai/sdk/v2"
import { createMemo } from "solid-js"
import { useSync } from "../context/sync"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"

type ToolPart = Extract<Part, { type: "tool" }>

type Progress = {
  total: number
  done: number
  pending: string[]
  blocked: string[]
  next?: string
}

const PLAN_TOOLS = ["plan_status", "plan_update"]

export function DialogPlan(props: { sessionID: string }) {
  const sync = useSync()

  const latest = createMemo(() => {
    const parts = (sync.data.message[props.sessionID] ?? []).flatMap((message) => sync.data.part[message.id] ?? [])
    return parts.findLast(
      (part): part is ToolPart =>
        part.type === "tool" &&
        PLAN_TOOLS.includes(part.tool) &&
        part.state.status === "completed",
    )
  })

  const progress = createMemo<Progress | undefined>(() => {
    const part = latest()
    if (!part || part.state.status !== "completed") return
    const metadata = part.state.metadata
    const readNumber = (key: string) => (typeof metadata[key] === "number" ? metadata[key] : 0)
    const sections = parseSections(part.state.output)
    const next = typeof metadata["next"] === "string" ? metadata["next"] : sections.pending[0]
    return {
      total: readNumber("total"),
      done: readNumber("done"),
      pending: sections.pending,
      blocked: sections.blocked,
      next,
    }
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const current = progress()
    if (!current) return []
    const rows: DialogSelectOption<string>[] = []
    if (current.total > 0) {
      rows.push({
        value: "summary",
        title: `${current.done}/${current.total} items done`,
        description: current.next ? `Next: ${current.next}` : undefined,
        footer: progressBar(current.done, current.total),
        category: "Progress",
      })
    }
    for (const item of current.pending) {
      rows.push({ value: `pending:${item}`, title: item, footer: "pending", category: "Pending" })
    }
    for (const item of current.blocked) {
      rows.push({ value: `blocked:${item}`, title: item, footer: "blocked", category: "Blocked" })
    }
    return rows
  })

  return (
    <DialogSelect<string>
      title="Plan progress"
      options={options()}
      flat
      emptyView={
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <text>No plan yet</text>
        </box>
      }
    />
  )
}

function parseSections(output: string) {
  const pending: string[] = []
  const blocked: string[] = []
  let section: "pending" | "blocked" | undefined
  for (const line of output.split("\n")) {
    if (/^Pending items:$/.test(line)) {
      section = "pending"
      continue
    }
    if (/^Blocked items:$/.test(line)) {
      section = "blocked"
      continue
    }
    const item = /^-\s+(.*\S)\s*$/.exec(line)
    if (!item || !section) continue
    if (section === "pending") pending.push(item[1])
    else blocked.push(item[1])
  }
  return { pending, blocked }
}

function progressBar(done: number, total: number) {
  const width = 10
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}
