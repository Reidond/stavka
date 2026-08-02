import { randomBytes } from "node:crypto";

process.stdout.write(`sk-stavka-${randomBytes(32).toString("hex")}\n`);
