import { dirname } from "path";
import { createServer } from "./server";
import { cleanExpiredSessions, cleanExpiredPending2fa } from "./auth";
import { pruneExpired as pruneExpiredOauth } from "./oauth";

export const VERSION = "__BUILD_VERSION__";
const PORT = parseInt(process.env.PORT || "3500");
const BASE = dirname(process.execPath);

console.log(`
  ╦ ╦╔═╗╔═╗╔╦╗╔═╗╦═╗
  ╠═╣║ ║╚═╗ ║ ║╣ ╠╦╝
  ╩ ╩╚═╝╚═╝ ╩ ╚═╝╩╚═

  Lightweight Web Hosting Platform
  Port: ${PORT}
  Version: ${VERSION}
  Admin:   http://localhost:${PORT}/_admin
  Base:    ${BASE}
`);

const server = createServer(PORT);
console.log(`  Server running at http://localhost:${server.port}`);

// --- Periodic cleanup ---
// Runs hourly: expires sessions, pending 2FA tokens, OAuth codes, dead OAuth
// tokens, and unused DCR registrations. Keeps the DB from accumulating dead
// state and lets time-based revocations actually take effect.
function runPeriodicCleanup() {
  try {
    cleanExpiredSessions();
    cleanExpiredPending2fa();
    pruneExpiredOauth();
  } catch (e: any) {
    console.error("Periodic cleanup error:", e?.message || e);
  }
}
// Run once at startup (catches sessions etc. that expired while the process was down),
// then every hour.
runPeriodicCleanup();
setInterval(runPeriodicCleanup, 60 * 60 * 1000);
