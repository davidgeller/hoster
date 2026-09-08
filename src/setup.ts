// CLI bootstrap: create the first administrator without the web UI.
// Equivalent to the setup screen at /_admin; refuses to run once any
// administrator exists (add further accounts under Settings → Users).
import { createAdminUser, isSetup, migrateLegacyAdmin } from "./auth";

migrateLegacyAdmin();

if (isSetup()) {
  console.log("An administrator account is already configured.");
  console.log("Use the web UI at /_admin (Settings → Users) to add or change accounts.");
  process.exit(0);
}

const username = (prompt("Administrator username [admin]: ") || "admin").trim();
const password = prompt("Administrator password (min 8 chars): ");
if (!password || password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

try {
  await createAdminUser(username, password, { isAdmin: true });
} catch (e: any) {
  console.error(e?.message || "Could not create the administrator account.");
  process.exit(1);
}
console.log(`Administrator '${username.toLowerCase()}' created.`);
console.log("Start the server with: bun run start");
