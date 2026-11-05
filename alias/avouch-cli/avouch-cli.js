#!/usr/bin/env node
// Forwards to the `avouch` CLI. See README.md.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("avouch/package.json");
const binPath = resolve(dirname(pkgPath), require(pkgPath).bin.avouch);

const r = spawnSync(process.execPath, [binPath, ...process.argv.slice(2)], { stdio: "inherit" });
if (r.signal) process.kill(process.pid, r.signal);
else process.exit(r.status ?? 1);
