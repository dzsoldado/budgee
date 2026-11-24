// Runs the Bun API (:PORT, default 8787) and Vite (:5173, proxying /api to the same PORT) together.
// Env comes from .env.local via `bun --env-file` in the root `dev` script.
// Extra arguments go to Vite, e.g. `bun run dev --port 5174`.
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const stdio = { stdin: "inherit", stdout: "inherit", stderr: "inherit" } as const;

const children = [
  Bun.spawn(["bun", "--watch", "apps/server/entry/bun.ts"], { cwd: root, ...stdio }),
  Bun.spawn(["bun", "run", "dev", ...Bun.argv.slice(2)], { cwd: join(root, "apps/web"), ...stdio }),
];

const stopAll = () => {
  for (const child of children) child.kill();
};

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

const code = await Promise.race(children.map((child) => child.exited));
stopAll();
process.exit(code);
