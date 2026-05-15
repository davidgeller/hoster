// Server-side remote media fetcher with SSRF defenses.
//
// MCP agents call this via the `fetch_remote_media` tool to import images
// or other media from public URLs into a site. We do the fetching here
// (rather than having the agent base64 the bytes) for two reasons:
//   1. The agent never needs to handle binary content over chat.
//   2. We can apply server-side egress policy: no private IPs, no weird
//      ports, bounded size + time, validated against expected media format.
//
// Defenses, layered:
//   • URL scheme: http or https only (no file://, data:, ftp:, etc).
//   • Port allowlist: 80 and 443 only.
//   • Hostname denylist: localhost-ish names.
//   • DNS resolution: every resolved A/AAAA record must be a public unicast
//     IP — rejects RFC1918, loopback, link-local (including the cloud
//     metadata IPs at 169.254.169.254), multicast, ULA, etc.
//   • Redirects: followed manually, every hop re-validated against the
//     same checks. Max 5 hops.
//   • Time: 15s per-request, 30s total.
//   • Size: streamed with a 50 MB cap; aborts mid-stream if exceeded.
//
// Caller is responsible for validating magic bytes against the expected
// media type. We return the raw bytes + content-type and let them decide.

import dnsPromises from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PER_REQUEST_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 30_000;
const ALLOWED_PORTS = new Set([80, 443]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
]);

// Returns true if `ip` is a publicly-routable unicast address. Rejects all
// the standard non-public ranges (loopback, link-local, ULA, multicast,
// documentation, etc.) for both IPv4 and IPv6.
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 0) return false;

  if (kind === 4) {
    const parts = ip.split(".").map(n => parseInt(n, 10));
    if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return false;
    const [a, b, c] = parts;
    if (a === 0) return false;                              // 0.0.0.0/8
    if (a === 10) return false;                             // 10.0.0.0/8
    if (a === 127) return false;                            // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return false;               // 169.254.0.0/16 link-local (AWS/GCP metadata)
    if (a === 172 && b >= 16 && b <= 31) return false;      // 172.16.0.0/12
    if (a === 192 && b === 168) return false;               // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return false;     // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && c === 0) return false;      // 192.0.0.0/24 IETF
    if (a === 192 && b === 0 && c === 2) return false;      // TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return false;  // benchmark
    if (a === 198 && b === 51 && c === 100) return false;   // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return false;    // TEST-NET-3
    if (a >= 224) return false;                             // multicast/reserved
    return true;
  }

  // IPv6: normalize to lowercase, then reject standard non-public ranges.
  const norm = ip.toLowerCase();
  if (norm === "::" || norm === "::1") return false;        // unspecified / loopback
  if (norm.startsWith("::ffff:")) {                         // IPv4-mapped
    return isPublicIp(norm.substring(7));
  }
  if (norm.startsWith("fe8") || norm.startsWith("fe9") ||
      norm.startsWith("fea") || norm.startsWith("feb")) {   // fe80::/10 link-local
    return false;
  }
  if (norm.startsWith("fc") || norm.startsWith("fd")) return false;  // fc00::/7 ULA
  if (norm.startsWith("ff")) return false;                  // ff00::/8 multicast
  if (norm.startsWith("64:ff9b:")) return false;            // NAT64
  if (norm.startsWith("2001:db8:")) return false;           // 2001:db8::/32 documentation
  if (norm.startsWith("2001:0:") || norm.startsWith("2001::")) return false; // Teredo / various
  return true;
}

interface ParsedTarget {
  parsed: URL;
  hostname: string;
}

async function validateUrl(rawUrl: string): Promise<ParsedTarget> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { throw new Error("Invalid URL"); }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL scheme '${parsed.protocol}' not allowed (use http or https)`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) throw new Error("URL has no hostname");
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Hostname '${hostname}' is not allowed`);
  }

  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : (parsed.protocol === "https:" ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) {
    throw new Error(`Port ${port} is not allowed (only 80 and 443)`);
  }

  // Resolve to all A/AAAA records. If any resolves to a non-public IP we
  // refuse — defense against split-horizon / DNS-rebinding (well, partial,
  // since the actual fetch resolves again later; the standard mitigation is
  // to pin the IP, which is heavy. This check still catches the common
  // misconfiguration cases.)
  let ips: string[];
  if (isIP(hostname) !== 0) {
    ips = [hostname];
  } else {
    const r4 = await dnsPromises.resolve4(hostname).catch(() => [] as string[]);
    const r6 = await dnsPromises.resolve6(hostname).catch(() => [] as string[]);
    ips = [...r4, ...r6];
  }
  if (!ips.length) throw new Error(`No DNS records for '${hostname}'`);

  for (const ip of ips) {
    if (!isPublicIp(ip)) {
      throw new Error(`Hostname '${hostname}' resolves to non-public IP ${ip}`);
    }
  }

  return { parsed, hostname };
}

export interface RemoteFetchResult {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
  redirects: number;
}

export async function fetchRemoteMedia(rawUrl: string): Promise<RemoteFetchResult> {
  const startedAt = Date.now();
  let currentUrl = rawUrl;
  let redirects = 0;

  while (true) {
    if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
      throw new Error(`Fetch exceeded ${TOTAL_TIMEOUT_MS / 1000}s total timeout`);
    }

    await validateUrl(currentUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "Hoster-MCP/1.0 (+remote-media-fetch)",
          "Accept": "image/*, audio/*, video/*, */*;q=0.5",
        },
      });
    } catch (e: any) {
      clearTimeout(timer);
      if (e.name === "AbortError") {
        throw new Error(`Request timed out after ${PER_REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw new Error(`Fetch failed: ${e.message || e}`);
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect ${res.status} without Location header`);
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects (limit ${MAX_REDIRECTS})`);
      }
      try { currentUrl = new URL(location, currentUrl).toString(); }
      catch { throw new Error(`Invalid redirect target: ${location}`); }
      redirects++;
      // Drain and discard the body before the next hop so the connection
      // can be reused / closed cleanly.
      try { await res.body?.cancel(); } catch (_) {}
      continue;
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    // Pre-flight size check via Content-Length when present.
    const declared = parseInt(res.headers.get("content-length") || "0", 10);
    if (declared && declared > MAX_BYTES) {
      try { await res.body?.cancel(); } catch (_) {}
      throw new Error(`Content-Length ${declared} exceeds ${MAX_BYTES / (1024 * 1024)} MB limit`);
    }

    // Stream the body with a hard cap so a server lying about Content-Length
    // (or omitting it) can't blow past our limit.
    if (!res.body) throw new Error("Response has no body");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        try { await reader.cancel(); } catch (_) {}
        throw new Error(`Response exceeds ${MAX_BYTES / (1024 * 1024)} MB limit`);
      }
      chunks.push(value);
    }

    return {
      bytes: Buffer.concat(chunks),
      contentType: res.headers.get("content-type") || "",
      finalUrl: currentUrl,
      redirects,
    };
  }
}
