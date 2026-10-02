import type { SessionInputAdmitted, SessionInputIntent } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useEvent } from "../context/event"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"

type Policy = { autoDrain: boolean; followupMode: "queue" | "guide" }
type QueueValue = { kind: "item"; id: string } | { kind: "policy"; key: keyof Policy }

const watchedEvents = [
  "session.next.prompted",
  "session.next.prompt.admitted",
  "session.next.prompt.edited",
  "session.next.prompt.removed",
  "session.next.prompt.queue.reordered",
  "session.next.queue.policy",
] as const

export function DialogQueue(props: { sessionID: string }) {
  const sdk = useSDK()
  const event = useEvent()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [items, setItems] = createSignal<SessionInputAdmitted[]>([])
  const [policy, setPolicy] = createSignal<Policy>({ autoDrain: true, followupMode: "queue" })

  async function refresh() {
    const [listed, current] = await Promise.all([
      sdk.client.v2.session.queue.list({ sessionID: props.sessionID }),
      sdk.client.v2.session.queue.policy({ sessionID: props.sessionID }),
    ])
    if (listed.error) {
      toast.show({ variant: "error", message: describeError(listed.error) })
      return
    }
    setItems(listed.data?.data ?? [])
    if (current.data) setPolicy(current.data.data)
  }

  onMount(() => {
    void refresh()
    const unsubscribes = watchedEvents.map((type) =>
      event.on(type, (payload) => {
        if (payload.properties.sessionID !== props.sessionID) return
        void refresh()
      }),
    )
    onCleanup(() => unsubscribes.forEach((unsubscribe) => unsubscribe()))
  })

  const options = createMemo<DialogSelectOption<QueueValue>[]>(() => {
    const pending = items()
    const rows: DialogSelectOption<QueueValue>[] = pending.map((item, index) => ({
      value: { kind: "item" as const, id: item.id },
      title: firstLine(item.prompt.text),
      description: describeIntent(item.intent),
      details: previewLines(item.prompt.text),
      footer: `${item.delivery} · ${index + 1}/${pending.length}`,
    }))
    rows.push(
      {
        value: { kind: "policy" as const, key: "autoDrain" as const },
        title: "Auto-drain",
        description: "Promote queued messages as soon as the session goes idle",
        footer: policy().autoDrain ? "on" : "off",
        category: "Policy",
      },
      {
        value: { kind: "policy" as const, key: "followupMode" as const },
        title: "Follow-up mode",
        description: "guide continues in the current turn; queue waits for idle",
        footer: policy().followupMode,
        category: "Policy",
      },
    )
    return rows
  })

  const actions = createMemo(() => [
    {
      command: "dialog.queue.send",
      title: "send now",
      onTrigger: (option: DialogSelectOption<QueueValue>) => {
        if (option.value.kind === "item") void sendNow(option.value.id)
      },
      disabled: (option: DialogSelectOption<QueueValue> | undefined) => option?.value.kind !== "item",
    },
    {
      command: "dialog.queue.edit",
      title: "edit",
      onTrigger: (option: DialogSelectOption<QueueValue>) => {
        if (option.value.kind === "item") void edit(option.value.id)
      },
      disabled: (option: DialogSelectOption<QueueValue> | undefined) => option?.value.kind !== "item",
    },
    {
      command: "dialog.queue.remove",
      title: "remove",
      onTrigger: (option: DialogSelectOption<QueueValue>) => {
        if (option.value.kind === "item") void remove(option.value.id)
      },
      disabled: (option: DialogSelectOption<QueueValue> | undefined) => option?.value.kind !== "item",
    },
    {
      command: "dialog.queue.move_up",
      title: "move up",
      onTrigger: (option: DialogSelectOption<QueueValue>) => {
        if (option.value.kind === "item") void move(option.value.id, -1)
      },
      disabled: (option: DialogSelectOption<QueueValue> | undefined) => option?.value.kind !== "item",
    },
    {
      command: "dialog.queue.move_down",
      title: "move down",
      onTrigger: (option: DialogSelectOption<QueueValue>) => {
        if (option.value.kind === "item") void move(option.value.id, 1)
      },
      disabled: (option: DialogSelectOption<QueueValue> | undefined) => option?.value.kind !== "item",
    },
  ])

  async function sendNow(id: string) {
    const result = await sdk.client.v2.session.queue.sendNow({ sessionID: props.sessionID, messageID: id })
    if (result.error) return toast.show({ variant: "error", message: describeError(result.error) })
    await refresh()
  }

  async function edit(id: string) {
    const item = items().find((entry) => entry.id === id)
    if (!item) return
    const text = await DialogPrompt.show(dialog, "Edit queued message", {
      value: item.prompt.text,
      placeholder: "Message text",
    })
    if (text !== null) {
      const result = await sdk.client.v2.session.queue.edit({ sessionID: props.sessionID, messageID: id, text })
      if (result.error) toast.show({ variant: "error", message: describeError(result.error) })
    }
    dialog.replace(() => <DialogQueue sessionID={props.sessionID} />)
  }

  async function remove(id: string) {
    const result = await sdk.client.v2.session.queue.remove({ sessionID: props.sessionID, messageID: id })
    if (result.error) return toast.show({ variant: "error", message: describeError(result.error) })
    await refresh()
  }

  async function move(id: string, direction: -1 | 1) {
    const pending = items()
    const index = pending.findIndex((entry) => entry.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= pending.length) return
    const next = [...pending]
    next[index] = pending[target]
    next[target] = pending[index]
    const result = await sdk.client.v2.session.queue.reorder({
      sessionID: props.sessionID,
      messageIDs: next.map((entry) => entry.id),
    })
    if (result.error) return toast.show({ variant: "error", message: describeError(result.error) })
    await refresh()
  }

  async function togglePolicy(key: keyof Policy) {
    const current = policy()
    const next: Policy =
      key === "autoDrain"
        ? { ...current, autoDrain: !current.autoDrain }
        : { ...current, followupMode: current.followupMode === "queue" ? "guide" : "queue" }
    setPolicy(next)
    const result = await sdk.client.v2.session.queue.setPolicy({ sessionID: props.sessionID, sessionQueuePolicy: next })
    if (result.error) {
      toast.show({ variant: "error", message: describeError(result.error) })
      await refresh()
    }
  }

  return (
    <DialogSelect<QueueValue>
      title={`Queued messages (${items().length})`}
      options={options()}
      actions={actions()}
      preserveSelection
      onSelect={(option) => {
        if (option.value.kind === "policy") void togglePolicy(option.value.key)
        else void sendNow(option.value.id)
      }}
      emptyView={
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <text fg={theme.textMuted}>Queue is empty</text>
        </box>
      }
    />
  )
}

function firstLine(text: string) {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "(empty message)"
}

function previewLines(text: string) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.slice(1, 3)
}

function describeIntent(intent?: SessionInputIntent) {
  if (!intent) return
  const parts: string[] = []
  if (intent.mode) parts.push(intent.mode)
  if (intent.model) {
    parts.push(intent.model.variant ? `${intent.model.modelID} · ${intent.model.variant}` : intent.model.modelID)
  }
  if (intent.context) parts.push(`≤${formatTokens(intent.context.maxInputTokens)}`)
  if (parts.length === 0) return
  return parts.join(" · ")
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return `${value}`
}

function describeError(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}
