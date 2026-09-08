// ISO 3166-1 alpha-2 country codes, plus the non-ISO values Cloudflare puts in
// `cf-ipcountry`: "XK" (Kosovo), "T1" (Tor exit node), "XX" (unknown). This
// is the single source of truth for the country allow-list: the admin UI
// fetches it (with display names) to drive its picker, and the settings
// endpoint refuses any code that isn't on it.
//
// Names come from the runtime's Intl.DisplayNames so they stay current with
// the ICU data Bun ships rather than being hand-maintained here.

const ISO_CODES = [
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ",
  "CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ",
  "DE","DJ","DK","DM","DO","DZ",
  "EC","EE","EG","EH","ER","ES","ET",
  "FI","FJ","FK","FM","FO","FR",
  "GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY",
  "HK","HM","HN","HR","HT","HU",
  "ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT",
  "JE","JM","JO","JP",
  "KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ",
  "LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY",
  "MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ",
  "NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ",
  "OM",
  "PA","PE","PF","PG","PH","PK","PL","PM","PN","PR","PS","PT","PW","PY",
  "QA",
  "RE","RO","RS","RU","RW",
  "SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SY","SZ",
  "TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT","TV","TW","TZ",
  "UA","UG","UM","US","UY","UZ",
  "VA","VC","VE","VG","VI","VN","VU",
  "WF","WS",
  "YE","YT",
  "ZA","ZM","ZW",
];

// Values Cloudflare emits that are not ISO regions (or that ICU may not know).
const SPECIAL: Record<string, string> = {
  XK: "Kosovo",
  T1: "Tor network (Cloudflare)",
  XX: "Unknown / unresolved",
};

export interface CountryEntry {
  code: string;
  name: string;
}

let cached: CountryEntry[] | null = null;
let validSet: Set<string> | null = null;

function displayNames(): ((code: string) => string | undefined) | null {
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    return (code: string) => { try { return dn.of(code); } catch { return undefined; } };
  } catch {
    return null;
  }
}

export function listCountries(): CountryEntry[] {
  if (cached) return cached;
  const nameOf = displayNames();
  const entries: CountryEntry[] = ISO_CODES.map(code => {
    const name = nameOf ? nameOf(code) : undefined;
    return { code, name: name && name !== code ? name : (SPECIAL[code] || code) };
  });
  for (const [code, name] of Object.entries(SPECIAL)) {
    if (!entries.some(e => e.code === code)) entries.push({ code, name });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  cached = entries;
  return entries;
}

export function isKnownCountryCode(code: string): boolean {
  if (!validSet) validSet = new Set(listCountries().map(e => e.code));
  return validSet.has(code);
}

// Normalize + validate a list of codes. Throws naming the first bad entry so
// the admin sees exactly what was rejected. Deduplicates and sorts.
export function normalizeCountryCodes(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error("countries must be an array of ISO 3166-1 alpha-2 codes");
  if (input.length > 300) throw new Error("Too many country codes");
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") throw new Error("Country codes must be strings");
    const code = raw.trim().toUpperCase();
    if (!code) continue;
    if (!/^[A-Z][A-Z0-9]$/.test(code) || !isKnownCountryCode(code)) {
      throw new Error(`Unknown country code '${raw.trim()}'`);
    }
    out.add(code);
  }
  return Array.from(out).sort();
}
