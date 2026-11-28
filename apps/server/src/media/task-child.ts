import { join } from 'node:path';
import { decodeSource } from './process.ts';
import { TASK, variantName, writeAtomic, writeResult } from './task.ts';
import type { SourceFormat } from './types.ts';

// The single-use decoder of the `media` role (P3b security review M2 b): forked for one task, it decodes that
// task's `in`, writes the variants and `result.json`, reports one fixed code to the role and exits. A decoder that a
// photo compromised therefore ends with that photo: the next member's task gets a fresh process (and the role kills
// this one's process group and wipes /tmp after it). It logs nothing: the role logs the fixed code.

type Task = { dir: string; expect: SourceFormat; deadlineMs: number };

async function run(task: Task): Promise<string> {
  const outcome = await decodeSource(join(task.dir, TASK.input), task.expect, task.deadlineMs);
  if (!outcome.ok) {
    await writeResult(task.dir, outcome);
    return outcome.code;
  }
  for (const v of outcome.variants) await writeAtomic(task.dir, variantName(v.format, v.width), v.bytes);
  const files = outcome.variants.map((v) => ({ format: v.format, width: v.width }));
  await writeResult(task.dir, { ok: true, width: outcome.width, height: outcome.height, files });
  return 'done';
}

process.once('message', (task: Task) => {
  run(task).then(
    (code) => process.send?.({ code, maxRssKiB: process.resourceUsage().maxRSS }, () => process.exit(0)),
    () => process.exit(70),
  );
});
