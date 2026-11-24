// Backups in Settings: the status and "back up now".
import type { BackupErrorCode, BackupRunResponse, BackupStatusResponse } from "@budgee/core";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppDeps } from "./app";
import type { AuthEnv } from "./auth";
import { backupErrorCode, readLastBackup, runBackup } from "./backup";
import { readLastCleanup } from "./cleanup";
import { nextDailyRun } from "./daily";
import { safeErrorMessage } from "./redact";

export function backupRoutes(
  api: Hono<AuthEnv>,
  { db, clock, backup }: AppDeps,
  auth: MiddlewareHandler<AuthEnv>,
) {
  api.get("/backups/status", auth, async (c) => {
    let files: string[] = [];
    let filesError: string | null = null;
    let filesErrorCode: BackupErrorCode | null = null;
    try {
      const destination = await backup.open();
      // budgee-YYYY-MM-DD names sort by date.
      if (destination) files = (await destination.list()).sort().reverse();
    } catch (error) {
      filesError = safeErrorMessage(error);
      filesErrorCode = backupErrorCode(error);
    }
    return c.json<BackupStatusResponse>({
      // Read after the listing, which may have found the connection broken.
      destination: await backup.status(),
      lastRun: await readLastBackup(db),
      lastCleanup: await readLastCleanup(db),
      files,
      filesError,
      filesErrorCode,
      nextRunAt: nextDailyRun(clock.now()),
    });
  });

  // The backup only; the cleanup stays with the daily run.
  api.post("/backups/run", auth, async (c) =>
    c.json<BackupRunResponse>(await runBackup({ db, clock, backup })),
  );
}
