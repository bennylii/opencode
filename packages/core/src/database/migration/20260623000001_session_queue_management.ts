import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260623000001_session_queue_management",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD COLUMN \`queue_position\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD COLUMN \`queue_auto_drain\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD COLUMN \`queue_followup_mode\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
