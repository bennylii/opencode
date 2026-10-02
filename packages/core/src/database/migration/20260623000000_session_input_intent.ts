import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260623000000_session_input_intent",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD COLUMN \`intent\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
