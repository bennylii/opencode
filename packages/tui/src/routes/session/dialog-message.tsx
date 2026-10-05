import { createMemo } from "solid-js"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { useSync } from "../../context/sync"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useClipboard } from "../../context/clipboard"
import { useData } from "../../context/data"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import type { PromptInfo } from "../../component/prompt/history"
import { stripPromptPartIDs as strip } from "../../prompt/part"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
  messages?: () => Message[]
  partsFor?: (messageID: string) => Part[]
}) {
  const sync = useSync()
  const sdk = useSDK()
  const data = useData()
  const route = useRoute()
  const clipboard = useClipboard()
  const toast = useToast()
  const messages = () => props.messages?.() ?? sync.data.message[props.sessionID] ?? []
  const partsFor = (messageID: string) => props.partsFor?.(messageID) ?? sync.data.part[messageID] ?? []
  const message = createMemo(() => messages().find((x) => x.id === props.messageID))

  const restorePrompt = () => {
    if (!props.setPrompt) return
    props.setPrompt(
      partsFor(props.messageID).reduce(
        (agg, part) => {
          if (part.type === "text") {
            if (!part.synthetic) agg.input += part.text
          }
          if (part.type === "file") agg.parts.push(strip(part))
          return agg
        },
        { input: "", parts: [] as PromptInfo["parts"] },
      ),
    )
  }

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
            const msg = message()
            if (!msg) return
            if (data.session.get(props.sessionID)?.runtime === "v2") {
              void (async () => {
                await sdk.client.v2.session.interrupt({ sessionID: props.sessionID }).catch(() => {})
                await sdk.client.v2.session
                  .revert.stage({ sessionID: props.sessionID, messageID: msg.id }, { throwOnError: true })
                  .catch((error) => {
                    toast.show({ message: errorMessage(error), variant: "error" })
                  })
                await sync.session.sync(props.sessionID)
                await data.session.refresh(props.sessionID)
                await data.session.message.refresh(props.sessionID)
                restorePrompt()
                dialog.clear()
              })()
              return
            }

            void sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })

            restorePrompt()
            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const text = partsFor(msg.id).reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await clipboard.write?.(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const msg = message()
            const prompt = msg
              ? partsFor(msg.id).reduce(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                )
              : undefined
            if (data.session.get(props.sessionID)?.runtime === "v2") {
              const result = await sdk.client.v2.session.fork({
                sessionID: props.sessionID,
                messageID: props.messageID,
              })
              if (result.data)
                route.navigate({
                  sessionID: result.data.data.id,
                  type: "session",
                  prompt,
                })
            } else {
              const result = await sdk.client.session.fork({
                sessionID: props.sessionID,
                messageID: props.messageID,
              })
              route.navigate({
                sessionID: result.data!.id,
                type: "session",
                prompt,
              })
            }
            dialog.clear()
          },
        },
      ]}
    />
  )
}
