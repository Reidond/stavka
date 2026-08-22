import { randomBytes } from "node:crypto";

// Opaque machine credential shared only by the paired Stavka services.
const key = `sk-stavka-${randomBytes(32).toString("hex")}`;
process.stdout.write(`${key}\n`);
