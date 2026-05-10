// Test preload — runs before any test file is imported, ensuring HOSTER_HOME
// is set before src/db.ts and src/sites.ts grab their BASE_DIR at module load.
//
// Without this, ES module hoisting causes those modules to evaluate before
// the test file's body runs, and they fall back to dirname(process.execPath)
// — which is wherever the Bun binary lives. That leaks site/data files into
// the user's Bun install directory.

import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

if (!process.env.HOSTER_HOME) {
  const home = mkdtempSync(join(tmpdir(), "hoster-test-"));
  mkdirSync(join(home, "admin"), { recursive: true });
  process.env.HOSTER_HOME = home;
}
