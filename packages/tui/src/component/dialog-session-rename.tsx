import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { useData } from "../context/data"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

interface DialogSessionRenameProps {
  session: string
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const data = useData()
  const toast = useToast()
  const session = createMemo(() => sync.session.get(props.session))

  return (
    <DialogPrompt
      title="Rename Session"
      value={session()?.title}
      onConfirm={(value) => {
        if (data.session.get(props.session)?.runtime === "v2") {
          void sdk.client.v2.session
            .update({ sessionID: props.session, title: value }, { throwOnError: true })
            .then(() => sync.session.sync(props.session))
            .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
        } else {
          void sdk.client.session.update({
            sessionID: props.session,
            title: value,
          })
        }
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
