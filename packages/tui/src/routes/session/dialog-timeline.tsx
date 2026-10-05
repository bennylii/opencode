import { createMemo, onMount } from "solid-js"
import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { DialogMessage } from "./dialog-message"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"

export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt?: (prompt: PromptInfo) => void
  messages: () => Message[]
  partsFor: (messageID: string) => Part[]
}) {
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const result = [] as DialogSelectOption<string>[]
    for (const message of props.messages()) {
      if (message.role !== "user") continue
      const part = props.partsFor(message.id).find((x) => x.type === "text" && !x.synthetic && !x.ignored) as
        | TextPart
        | undefined
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: (dialog) => {
          dialog.replace(() => (
            <DialogMessage
              messageID={message.id}
              sessionID={props.sessionID}
              setPrompt={props.setPrompt}
              messages={props.messages}
              partsFor={props.partsFor}
            />
          ))
        },
      })
    }
    result.reverse()
    return result
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} title="Timeline" options={options()} />
}
