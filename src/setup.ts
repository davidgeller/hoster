import { setAdminPassword, isSetup } from "./auth";

if (isSetup()) {
  console.log("Admin password is already configured.");
  console.log("Use the web UI at /_admin to change it.");
  process.exit(0);
}

const password = prompt("Set admin password (min 8 chars): ");
if (!password || password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

await setAdminPassword(password);
console.log("Admin password set successfully!");
console.log("Start the server with: bun run start");
