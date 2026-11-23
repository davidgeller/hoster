// Seed a local Hoster install with a demo repository and an /api/v1 key, for
// pointing an external client (e.g. the CRM) at a dev server.
//
//   HOSTER_HOME=/path/to/devhome bun run scripts/seed-api-demo.ts
//
// Safe to re-run: the repository and admin account are reused, and each run
// mints one fresh key for the repository (older demo keys keep working
// until revoked in the repository's Settings → API Keys). Refuses to run
// without HOSTER_HOME so it can never touch a real installation by accident.

if (!process.env.HOSTER_HOME) {
  console.error("Set HOSTER_HOME to a development data directory first.");
  process.exit(1);
}

const { getUserByUsername, createAdminUser, generatePassword } = await import("../src/auth");
const { getSite } = await import("../src/sites");
const { createRepositorySite, createRepoFolder, putRepoFile, getRepoFile, createRepoTag, listRepoTags, tagRepoPaths, setRepoDescription } = await import("../src/repo");
const { createApiKey } = await import("../src/api-v1");

const SLUG = "crm-demo";
const USER = "admin";

let password: string | null = null;
let admin = getUserByUsername(USER);
if (!admin) {
  password = generatePassword(16);
  await createAdminUser(USER, password, { isAdmin: true });
  admin = getUserByUsername(USER)!;
}

if (!getSite(SLUG)) createRepositorySite(SLUG, "CRM Demo Library", { description: "Sample documents for API testing" });

const files: [string, string][] = [
  ["Sales/Proposals/2026/Acme Corp proposal.md", "# Acme Corp proposal\n\nScope, timeline and pricing for the Acme rollout.\n"],
  ["Sales/Proposals/2026/Globex renewal.txt", "Globex renewal terms, draft 2.\n"],
  ["Sales/Price list.csv", "plan,monthly\nStarter,49\nTeam,199\nEnterprise,custom\n"],
  ["Legal/Mutual NDA.md", "# Mutual NDA\n\nStandard two-way non-disclosure agreement.\n"],
  ["Welcome.md", "# CRM Demo Library\n\nThis repository exists to exercise the Hoster /api/v1 integration.\n"],
];
createRepoFolder(SLUG, "Sales/Proposals/2026", USER);
createRepoFolder(SLUG, "Legal", USER);
for (const [path, body] of files) {
  if (!getRepoFile(SLUG, path)) await putRepoFile(SLUG, path, body, { actor: USER } as any);
}
let tag = listRepoTags(SLUG).find(t => t.name === "Contract");
if (!tag) tag = createRepoTag(SLUG, { name: "Contract", color: "#2f6fde" });
tagRepoPaths(SLUG, ["Legal/Mutual NDA.md", "Sales/Proposals/2026/Globex renewal.txt"], { add: [tag.id] });
setRepoDescription(SLUG, "Sales/Price list.csv", "Current list prices for all plans");

const { key, info } = createApiKey(SLUG, {
  label: `CRM local test ${new Date().toISOString().slice(0, 10)}`,
  expires_in_days: 90,
}, "seed-script");

console.log(JSON.stringify({
  repository: { id: String(getSite(SLUG)!.id), slug: SLUG },
  api_key: key,
  key_id: info.key_id,
  expires_at: info.expires_at,
  admin_user: USER,
  admin_password: password ?? "(unchanged — account already existed)",
}, null, 2));
