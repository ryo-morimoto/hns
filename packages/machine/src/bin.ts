#!/usr/bin/env node
/**
 * The hns-machine executable (0270n).
 *
 * @remarks
 * The command lives in src/cli.ts so the tests call it without a process; this file is the thin
 * process wrapper: it runs one command line, prints the outcome, keeps the process alive while the
 * agent runs, and stops the agent on a signal so a restart does not race the listener.
 */
import { runCli } from "./cli.ts";

const outcome = await runCli(process.argv.slice(2), {
  onStarted: (agent) => {
    const stop = (): void => {
      void agent.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  },
});
process.stdout.write(outcome.stdout);
process.stderr.write(outcome.stderr);
if (outcome.code !== 0) process.exit(outcome.code);
