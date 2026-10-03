import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260623000002_session_runtime",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD COLUMN \`runtime\` text NOT NULL DEFAULT 'v1';`)
    })
  },
} satisfies DatabaseMigration.Migration
