import { dirname } from "path";
import { createServer } from "./server";

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
