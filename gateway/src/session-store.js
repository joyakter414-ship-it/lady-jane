// Keeps the WhatsApp linked-device session in Cloudflare R2 (via the brain),
// encrypted with SESSION_SECRET, so the gateway can restart or move to another
// machine/container without scanning the QR code again.
//
// Locally the session lives in AUTH_DIR (Baileys' standard multi-file format);
// this module mirrors that folder to R2 as one encrypted, gzipped blob.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { brain } from "./brain.js";

export const AUTH_DIR = process.env.AUTH_DIR || "./auth";
const SECRET = process.env.SESSION_SECRET || "";
if (SECRET.length < 32) {
  console.error("SESSION_SECRET must be at least 32 characters (it encrypts your WhatsApp session in R2).");
  process.exit(1);
}
const KEY = createHash("sha256").update(SECRET).digest();

function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function decrypt(blob) {
  const decipher = createDecipheriv("aes-256-gcm", KEY, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

/** If there's no local session, pull it from R2. Returns true if a session exists afterwards. */
export async function restoreSession(log) {
  if (existsSync(join(AUTH_DIR, "creds.json"))) return true;
  const blob = await brain("GET", "/gw/session", { raw: true });
  if (!blob) return false;
  let files;
  try {
    files = JSON.parse(gunzipSync(decrypt(blob)).toString("utf8"));
  } catch {
    log.warn("Stored session could not be decrypted (SESSION_SECRET changed?). Starting fresh — you'll need to scan the QR again.");
    return false;
  }
  await mkdir(AUTH_DIR, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(AUTH_DIR, name), content)));
  log.info(`Restored WhatsApp session from R2 (${Object.keys(files).length} files).`);
  return true;
}

let timer = null;
let firstDirtyAt = 0;
let running = Promise.resolve();

/** Upload now (serialised so uploads never overlap). */
export function backupNow(log) {
  clearTimeout(timer);
  timer = null;
  firstDirtyAt = 0;
  running = running.then(async () => {
    if (!existsSync(join(AUTH_DIR, "creds.json"))) return;
    const names = (await readdir(AUTH_DIR)).filter((n) => n.endsWith(".json"));
    const files = {};
    await Promise.all(names.map(async (n) => (files[n] = await readFile(join(AUTH_DIR, n), "utf8"))));
    await brain("PUT", "/gw/session", { body: encrypt(gzipSync(JSON.stringify(files))) });
    log.debug(`Session backed up to R2 (${names.length} files).`);
  }).catch((err) => log.error({ err: String(err) }, "Session backup failed"));
  return running;
}

/** Debounced backup: waits for 5s of quiet, but never longer than 30s. */
export function scheduleBackup(log) {
  const now = Date.now();
  if (!firstDirtyAt) firstDirtyAt = now;
  clearTimeout(timer);
  const wait = Math.max(0, Math.min(5_000, firstDirtyAt + 30_000 - now));
  timer = setTimeout(() => backupNow(log), wait);
}

/** Forget the session everywhere (after logout). */
export async function wipeSession(log) {
  clearTimeout(timer);
  timer = null;
  firstDirtyAt = 0;
  await rm(AUTH_DIR, { recursive: true, force: true });
  await brain("DELETE", "/gw/session").catch((err) => log.error({ err: String(err) }, "Could not delete remote session"));
}
