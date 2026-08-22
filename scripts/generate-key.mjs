import { randomBytes } from "node:crypto";

// STAVKA_PROVIDER_CREDENTIALS_KEY must be a base64-encoded 32-byte AES-256
// key (see apps/stavka/src/durable-objects/credential-vault.ts). Generate a
// fresh key for every environment; never reuse keys across environments or
// from the compromised standalone Warbench deployment.
const key = randomBytes(32).toString("base64");
process.stdout.write(`${key}\n`);
