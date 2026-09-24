// Command-line operations that run against the local installation without the
// web server: `hoster deploy <slug> <zip>`.
//
// There is no login here. Anyone who can run this as the service account can
// already write data/hoster.db and sites/ directly, so the CLI grants nothing
// new; the checks below exist to stop mistakes (wrong slug, wrong file, wrong
// user) and to leave an audit trail, not to authenticate.
//
// Nothing that opens the database is imported until the preflight checks
// pass: db.ts creates data/hoster.db on import, and a CLI run from the wrong
// directory must not quietly create a fresh, empty installation there.

import { closeSync, existsSync, lstatSync, openSync, readSync, statfsSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join } from "path";
import { userInfo } from "os";

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
  confirm(question: string): boolean;
  isTTY: boolean;
  getuid?: () => number;   // overridable for tests; undefined on Windows
}

const defaultIO: CliIO = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  confirm: (q) => /^y(es)?$/i.test((prompt(q) || "").trim()),
  isTTY: !!process.stdin.isTTY,
  getuid: process.getuid?.bind(process),
};

const USAGE = `Usage:
  hoster deploy <slug> <absolute-path-to.zip> [options]
  hoster admin-host [--clear]

Deploys a ZIP as a new version of an existing web site. The previous version
is kept and can be re-activated from the admin UI.

Options:
  --label <text>   Version label (default: "CLI: <zip filename>")
  --notes <text>   Release notes for the version
  --yes            Skip the confirmation prompt (required when not on a terminal)
  --dry-run        Run every check, print the summary, change nothing

admin-host shows the dedicated admin hostname (Settings → Security → Admin
Hostname); --clear turns it off so the admin panel is served on every
hostname again — the way back in if the admin hostname stops resolving.
Restart the service afterwards (sudo systemctl restart hoster).

Run as the account that owns the Hoster data directory (not root).
Set HOSTER_HOME when running from source.`;

export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "deploy") return runDeploy(rest, io);
  if (command === "admin-host") return runAdminHost(rest, io);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command ? 0 : 1;
  }
  io.err(`Unknown command '${command}'.\n\n${USAGE}`);
  return 1;
}

interface DeployArgs {
  slug: string;
  zipPath: string;
  label?: string;
  notes?: string;
  yes: boolean;
  dryRun: boolean;
}

function parseDeployArgs(args: string[]): DeployArgs | string {
  const positional: string[] = [];
  const parsed: Partial<DeployArgs> = { yes: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= args.length) throw new Error(`${flag} needs a value`);
      return args[++i];
    };
    try {
      if (flag === "--label") parsed.label = value();
      else if (flag === "--notes") parsed.notes = value();
      else if (flag === "--yes" || flag === "-y") parsed.yes = true;
      else if (flag === "--dry-run") parsed.dryRun = true;
      else if (a.startsWith("-")) return `Unknown option '${a}'.`;
      else positional.push(a);
    } catch (e: any) {
      return e.message;
    }
  }
  if (positional.length !== 2) return "Expected exactly two arguments: <slug> <zip path>.";
  return { ...(parsed as DeployArgs), slug: positional[0].toLowerCase().trim(), zipPath: positional[1] };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// List the archive without extracting it: entry names and total uncompressed size.
function inspectZip(zipPath: string): { files: string[]; uncompressed: number } | string {
  const proc = Bun.spawnSync(["unzip", "-l", zipPath], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return "unzip could not read the archive (corrupt or not a ZIP).";
  const lines = proc.stdout.toString().split("\n");
  // Entries sit between the two dashed separator lines.
  const seps = lines.map((l, i) => (/^-{4,}/.test(l.trim()) ? i : -1)).filter(i => i >= 0);
  if (seps.length < 2) return "Could not read the archive listing.";
  const files: string[] = [];
  let uncompressed = 0;
  for (const line of lines.slice(seps[0] + 1, seps[1])) {
    const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.*)$/);
    if (!m) continue;
    uncompressed += Number(m[1]);
    if (!m[2].endsWith("/")) files.push(m[2]);
  }
  return { files, uncompressed };
}

function versionStamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+/, "");
}

async function runDeploy(args: string[], io: CliIO): Promise<number> {
  const parsed = parseDeployArgs(args);
  if (typeof parsed === "string") {
    io.err(`${parsed}\n\n${USAGE}`);
    return 1;
  }
  const { slug, zipPath } = parsed;
  const fail = (msg: string) => { io.err(`Error: ${msg}`); return 1; };

  // --- Installation and account checks (before anything opens the DB) ---
  const base = process.env.HOSTER_HOME || dirname(process.execPath);
  const dbPath = join(base, "data", "hoster.db");
  if (!existsSync(dbPath)) {
    return fail(`No Hoster database at ${dbPath}. Run the installed hoster binary, or set HOSTER_HOME to the installation directory.`);
  }
  const uid = io.getuid?.();
  if (uid !== undefined) {
    if (uid === 0) {
      return fail("Refusing to run as root: the new version would be owned by root and the server could not edit it. Run as the service account, e.g. sudo -u <service-user> hoster deploy ...");
    }
    const owner = statSync(dbPath).uid;
    if (owner !== uid) {
      return fail(`This account (uid ${uid}) does not own ${dbPath} (uid ${owner}). Run as the account the Hoster service runs as.`);
    }
  }

  // --- ZIP checks ---
  if (!isAbsolute(zipPath)) return fail(`The ZIP path must be absolute: ${zipPath}`);
  let st;
  try { st = lstatSync(zipPath); } catch { return fail(`File not found: ${zipPath}`); }
  if (st.isSymbolicLink()) return fail(`Refusing a symbolic link; pass the real file path: ${zipPath}`);
  if (!st.isFile()) return fail(`Not a regular file: ${zipPath}`);

  const { MAX_UPLOAD_SIZE } = await import("./sites");
  if (st.size === 0) return fail("The ZIP file is empty.");
  if (st.size > MAX_UPLOAD_SIZE) return fail(`The ZIP is ${formatBytes(st.size)}; the limit is ${formatBytes(MAX_UPLOAD_SIZE)}.`);

  const magic = Buffer.alloc(4);
  const fd = openSync(zipPath, "r");
  try { readSync(fd, magic, 0, 4, 0); } finally { closeSync(fd); }
  if (!magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return fail("Not a ZIP archive (bad file signature).");

  const listing = inspectZip(zipPath);
  if (typeof listing === "string") return fail(listing);
  if (listing.files.length === 0) return fail("The ZIP contains no files.");
  if (!listing.files.some(f => basename(f).toLowerCase() === "index.html")) {
    return fail("The ZIP has no index.html anywhere, so the site would have nothing to serve.");
  }

  // Staging holds a copy of the ZIP plus the extracted tree.
  const needed = Math.ceil((st.size + listing.uncompressed) * 1.1);
  try {
    const fs = statfsSync(join(base, "sites"));
    const free = fs.bavail * fs.bsize;
    if (free < needed) return fail(`Not enough disk space: need about ${formatBytes(needed)}, ${formatBytes(free)} free.`);
  } catch (_) { /* statfs unavailable: the extraction itself will fail loudly */ }

  // --- Site checks ---
  const { getSite, deploySite, listVersions, sanitizeVersionLabel, sanitizeVersionNotes } = await import("./sites");
  const { auditLog } = await import("./auth");
  const site = getSite(slug);
  if (!site) return fail(`No site '${slug}'. hoster deploy only updates existing sites; create new ones in the admin UI.`);
  if (site.site_type !== "web") return fail(`Site '${slug}' is a ${site.site_type} site; only web sites can be deployed from a ZIP.`);

  const zipName = basename(zipPath);
  let label: string | null;
  let notes: string | null;
  try {
    label = sanitizeVersionLabel(parsed.label ?? `CLI: ${zipName}`.slice(0, 120));
    notes = sanitizeVersionNotes(parsed.notes);
  } catch (e: any) {
    return fail(e.message);
  }

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(zipPath).arrayBuffer());
  const sha256 = hasher.digest("hex");

  io.out(`Site:            ${site.name} (${slug})`);
  io.out(`Current version: ${site.current_version ?? "none"}`);
  io.out(`ZIP:             ${zipPath}`);
  io.out(`                 ${formatBytes(st.size)}, ${listing.files.length} file(s), ${formatBytes(listing.uncompressed)} unpacked`);
  io.out(`SHA-256:         ${sha256}`);
  io.out(`Label:           ${label ?? "(none)"}`);

  if (parsed.dryRun) {
    io.out("\nDry run: all checks passed, nothing was changed.");
    return 0;
  }
  if (!parsed.yes) {
    if (!io.isTTY) return fail("Not running on a terminal; pass --yes to confirm the deploy.");
    if (!io.confirm(`\nDeploy this as a new version of '${slug}'? [y/N] `)) {
      io.out("Aborted; nothing was changed.");
      return 1;
    }
  }

  const sudoUser = process.env.SUDO_USER;
  let osUser = "unknown";
  try { osUser = userInfo().username; } catch (_) {}
  const actor = sudoUser && sudoUser !== osUser ? `${osUser} (sudo from ${sudoUser})` : osUser;
  const previous = site.current_version;

  // Version ids have one-second resolution; never reuse an existing one.
  while (listVersions(slug).some(v => v.version === versionStamp())) await Bun.sleep(200);

  let result;
  try {
    result = await deploySite(slug, site.name, await Bun.file(zipPath).arrayBuffer(), label, notes);
  } catch (e: any) {
    auditLog("site_update_cli_failed", `${slug} from ${zipName}: ${e?.message || e}`, "local-cli", actor);
    return fail(`Deploy failed: ${e?.message || e}`);
  }
  auditLog("site_updated_cli", `${slug} -> ${result.version.version} from ${zipName} sha256:${sha256.slice(0, 16)}`, "local-cli", actor);

  io.out(`\nDeployed ${slug} version ${result.version.version}.`);
  if (previous) {
    io.out(`Previous version ${previous} is kept. To roll back: admin UI → ${slug} → Versions → Activate on ${previous}.`);
  }
  return 0;
}

// `hoster admin-host [--clear]` — show or clear the dedicated admin hostname.
async function runAdminHost(args: string[], io: CliIO): Promise<number> {
  const unknown = args.filter(a => a !== "--clear");
  if (unknown.length) { io.err(`Unknown option '${unknown[0]}'.\n\n${USAGE}`); return 1; }
  const base = process.env.HOSTER_HOME || dirname(process.execPath);
  const dbPath = join(base, "data", "hoster.db");
  if (!existsSync(dbPath)) {
    io.err(`No Hoster database at ${dbPath}. Run the installed hoster binary, or set HOSTER_HOME to the installation directory.`);
    return 1;
  }
  const { getOriginConfig, setOriginConfig } = await import("./origin");
  const cfg = getOriginConfig();
  if (!args.includes("--clear")) {
    io.out(cfg.admin_host
      ? `Admin panel: ${cfg.admin_host} only. Sites: ${cfg.sites_host}.`
      : "No dedicated admin hostname: the admin panel is served on every hostname.");
    return 0;
  }
  if (!cfg.admin_host) { io.out("Already off; nothing to change."); return 0; }
  setOriginConfig({ admin_host: null }, { hostAliases: [] });
  const { auditLog } = await import("./auth");
  let osUser = "unknown";
  try { osUser = userInfo().username; } catch (_) {}
  auditLog("origin_isolation_updated", `off via CLI (was ${cfg.admin_host})`, "cli", `cli:${osUser}`);
  io.out(`Cleared. The admin panel is served on every hostname again (it was ${cfg.admin_host} only).`);
  io.out("Restart the service so the running server picks this up: sudo systemctl restart hoster");
  return 0;
}
