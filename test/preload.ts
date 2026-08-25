// Test preload — runs before any test file is imported, ensuring HOSTER_HOME
// is set before src/db.ts and src/sites.ts grab their BASE_DIR at module load.
//
// Without this, ES module hoisting causes those modules to evaluate before
// the test file's body runs, and they fall back to dirname(process.execPath)
// — which is wherever the Bun binary lives. That leaks site/data files into
// the user's Bun install directory.

import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

if (!process.env.HOSTER_HOME) {
  const home = mkdtempSync(join(tmpdir(), "hoster-test-"));
  mkdirSync(join(home, "admin"), { recursive: true });
  process.env.HOSTER_HOME = home;

  // Clean up at process exit, not in each test file's afterAll — the suite
  // shares one HOSTER_HOME across files, so per-file cleanup would delete
  // state the next file still needs.
  process.on("exit", () => {
    try { rmSync(home, { recursive: true, force: true }); } catch (_) {}
  });
}

// Force modules with side-effecting table creation (CREATE TABLE IF NOT EXISTS
// at module load) to evaluate now, so the schema is complete before any test
// runs. Backup/restore queries every table; without these imports, tests that
// don't directly touch mcp/oauth would still fail when backup.ts walks them.
import "../src/db";
import "../src/sites";
import "../src/mcp";
import "../src/oauth";
import "../src/analytics";
import "../src/auth";
import "../src/webauthn";
