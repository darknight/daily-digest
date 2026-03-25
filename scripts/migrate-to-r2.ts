/**
 * One-time migration script: upload local data/ JSON files to Cloudflare R2.
 *
 * Usage: npx tsx --env-file=.env scripts/migrate-to-r2.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { readJSON, writeJSON } from "./lib/r2.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PREFIXES = ["articles", "summaries"] as const;

async function main() {
  let uploaded = 0;
  let skipped = 0;

  for (const prefix of PREFIXES) {
    const dir = join(ROOT, "data", prefix);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

    console.log(`\n── ${prefix}/ (${files.length} files) ──`);

    for (const file of files) {
      const key = `${prefix}/${file}`;
      const existing = await readJSON(key);
      if (existing) {
        console.log(`  SKIP ${key} (already exists in R2)`);
        skipped++;
        continue;
      }

      const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      await writeJSON(key, data);
      console.log(`  UPLOADED ${key}`);
      uploaded++;
    }
  }

  console.log(`\nDone: ${uploaded} uploaded, ${skipped} skipped`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
