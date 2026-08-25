// Passkey (WebAuthn) tests.
//
// These drive src/webauthn.ts through a synthetic authenticator: a real P-256
// keypair plus hand-built CBOR/attestation structures, so the assertions below
// exercise genuine signature verification rather than a mock. The pieces are
// small because attestation is "none" — the only CBOR shapes needed are a
// 3-entry map, a 5-entry COSE key, and byte strings.

import { describe, expect, test, beforeEach } from "bun:test";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "crypto";

import db from "../src/db";
import {
  getRpContext,
  beginRegistration,
  finishRegistration,
  beginLogin,
  finishLogin,
  listCredentials,
  deleteCredential,
  hasCredentialsForRp,
  cleanExpiredChallenges,
} from "../src/webauthn";

const RP_ID = "admin.example.com";
const ORIGIN = `https://${RP_ID}`;
const IP = "203.0.113.9";

function rp(rpId = RP_ID, origin = ORIGIN) {
  return { rpId, origin };
}

// --- Minimal CBOR encoders (only the shapes an attestation needs) ---

function cborBytes(data: Buffer): Buffer {
  if (data.length < 24) return Buffer.concat([Buffer.from([0x40 | data.length]), data]);
  if (data.length < 256) return Buffer.concat([Buffer.from([0x58, data.length]), data]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length);
  return Buffer.concat([Buffer.from([0x59]), len, data]);
}

function cborText(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([Buffer.from([0x60 | b.length]), b]);
}

// COSE_Key for ES256: {1: 2, 3: -7, -1: 1, -2: x, -3: y}
function coseKey(x: Buffer, y: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xa5]),
    Buffer.from([0x01, 0x02]),
    Buffer.from([0x03, 0x26]),
    Buffer.from([0x20, 0x01]),
    Buffer.from([0x21]), cborBytes(x),
    Buffer.from([0x22]), cborBytes(y),
  ]);
}

// --- Synthetic authenticator ---

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

class Authenticator {
  credentialId = randomBytes(32);
  counter = 0;
  private keys = generateKeyPairSync("ec", { namedCurve: "P-256" });

  private coordinates(): { x: Buffer; y: Buffer } {
    const jwk = this.keys.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    return { x: Buffer.from(jwk.x, "base64url"), y: Buffer.from(jwk.y, "base64url") };
  }

  private authData(rpId: string, flags: number, includeCredential: boolean): Buffer {
    const rpIdHash = createHash("sha256").update(rpId).digest();
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const head = Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);
    if (!includeCredential) return head;

    const { x, y } = this.coordinates();
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([
      head,
      Buffer.alloc(16, 0), // aaguid
      credIdLen,
      this.credentialId,
      coseKey(x, y),
    ]);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
  }

  attest(challenge: string, rpId = RP_ID, origin = ORIGIN, flags = FLAG_UP | FLAG_UV | FLAG_AT) {
    const clientDataJSON = this.clientData("webauthn.create", challenge, origin);
    const authData = this.authData(rpId, flags, true);
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      cborText("fmt"), cborText("none"),
      cborText("attStmt"), Buffer.from([0xa0]),
      cborText("authData"), cborBytes(authData),
    ]);
    return {
      id: this.credentialId.toString("base64url"),
      rawId: this.credentialId.toString("base64url"),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal"],
      },
    };
  }

  assert(challenge: string, rpId = RP_ID, origin = ORIGIN, flags = FLAG_UP | FLAG_UV) {
    const clientDataJSON = this.clientData("webauthn.get", challenge, origin);
    const authData = this.authData(rpId, flags, false);
    const signature = createSign("sha256")
      .update(Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]))
      .sign(this.keys.privateKey);
    return {
      id: this.credentialId.toString("base64url"),
      rawId: this.credentialId.toString("base64url"),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: undefined,
      },
    };
  }
}

// Register a passkey and return the authenticator that owns it.
async function enroll(ip = IP, context = rp()): Promise<Authenticator> {
  const authenticator = new Authenticator();
  const options = await beginRegistration(context, ip, null);
  await finishRegistration(context, ip, authenticator.attest(options.challenge, context.rpId, context.origin), "Test key", null);
  return authenticator;
}

function reset() {
  db.exec("DELETE FROM webauthn_credentials");
  db.exec("DELETE FROM webauthn_challenges");
}

beforeEach(reset);

describe("getRpContext", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://example.com/_admin/api/login/passkey/options", { method: "POST", headers });

  test("derives the RP ID from an HTTPS Origin", () => {
    expect(getRpContext(req({ origin: ORIGIN }))).toEqual({ rpId: RP_ID, origin: ORIGIN });
  });

  test("rejects plain HTTP on a non-loopback host", () => {
    // The LAN case: http://192.168.1.50:3500 is not a secure context, so the
    // browser would refuse WebAuthn and we must not pretend otherwise.
    expect(getRpContext(req({ origin: "http://192.168.1.50:3500" }))).toBeNull();
  });

  test("allows plain HTTP on localhost", () => {
    expect(getRpContext(req({ origin: "http://localhost:3500" }))).toEqual({
      rpId: "localhost",
      origin: "http://localhost:3500",
    });
  });

  test("ignores the port when deriving the RP ID", () => {
    expect(getRpContext(req({ origin: "https://admin.example.com:8443" })?.clone() as Request)?.rpId)
      .toBe(RP_ID);
  });

  test("falls back to Host when no Origin is present", () => {
    expect(getRpContext(req({ host: RP_ID }))).toEqual({ rpId: RP_ID, origin: ORIGIN });
  });

  test("returns null with neither Origin nor Host", () => {
    // Request always synthesizes a Host from the URL, so exercise the guard
    // through a header-less object shaped like a Request.
    const bare = { headers: new Headers() } as unknown as Request;
    expect(getRpContext(bare)).toBeNull();
  });
});

describe("registration", () => {
  test("stores a credential that can then be listed", async () => {
    const authenticator = await enroll();
    const credentials = listCredentials(null);
    expect(credentials).toHaveLength(1);
    expect(credentials[0].label).toBe("Test key");
    expect(credentials[0].rp_id).toBe(RP_ID);
    expect(credentials[0].credential_id).toBe(authenticator.credentialId.toString("base64url"));
    expect(hasCredentialsForRp(RP_ID, null)).toBe(true);
  });

  test("excludes already-registered authenticators from a new registration", async () => {
    const authenticator = await enroll();
    const options = await beginRegistration(rp(), IP, null);
    expect(options.excludeCredentials.map((c: any) => c.id))
      .toContain(authenticator.credentialId.toString("base64url"));
  });

  test("requires user verification", async () => {
    const authenticator = new Authenticator();
    const options = await beginRegistration(rp(), IP, null);
    // UP and AT set, UV clear — a key with no PIN or biometric.
    const response = authenticator.attest(options.challenge, RP_ID, ORIGIN, FLAG_UP | FLAG_AT);
    await expect(finishRegistration(rp(), IP, response, "No UV", null)).rejects.toThrow();
  });

  test("rejects a challenge replayed from a different IP", async () => {
    const authenticator = new Authenticator();
    const options = await beginRegistration(rp(), IP, null);
    const response = authenticator.attest(options.challenge);
    await expect(finishRegistration(rp(), "198.51.100.7", response, "Elsewhere", null))
      .rejects.toThrow(/IP changed/);
  });

  test("falls back to a host-derived label when none is given", async () => {
    const authenticator = new Authenticator();
    const options = await beginRegistration(rp(), IP, null);
    await finishRegistration(rp(), IP, authenticator.attest(options.challenge), "   ", null);
    expect(listCredentials(null)[0].label).toBe(`Passkey on ${RP_ID}`);
  });
});

describe("authentication", () => {
  test("verifies a genuine assertion", async () => {
    const authenticator = await enroll();
    const options = await beginLogin(rp(), IP);
    const credential = await finishLogin(rp(), IP, authenticator.assert(options.challenge));
    expect(credential.label).toBe("Test key");
    expect(credential.user_id).toBeNull();
  });

  test("refuses to start when no passkey exists for the host", async () => {
    await expect(beginLogin(rp(), IP)).rejects.toThrow(/No passkeys registered/);
  });

  test("rejects a replayed assertion", async () => {
    const authenticator = await enroll();
    const options = await beginLogin(rp(), IP);
    const assertion = authenticator.assert(options.challenge);
    await finishLogin(rp(), IP, assertion);
    // The challenge was consumed on first use, so the identical response fails.
    await expect(finishLogin(rp(), IP, assertion)).rejects.toThrow(/expired or IP changed/);
  });

  test("works when the client IP is unverifiable on both sides", async () => {
    // The bare self-hosted case: no Cloudflare, no x-real-ip, so getClientIp()
    // returns "unknown". Passkeys must still work there.
    const authenticator = await enroll("unknown");
    const options = await beginLogin(rp(), "unknown");
    const credential = await finishLogin(rp(), "unknown", authenticator.assert(options.challenge));
    expect(credential.label).toBe("Test key");
  });

  test("rejects a known IP completing a challenge begun by an unknown one", async () => {
    const authenticator = await enroll();
    const options = await beginLogin(rp(), "unknown");
    await expect(finishLogin(rp(), IP, authenticator.assert(options.challenge)))
      .rejects.toThrow(/IP changed/);
  });

  test("rejects an assertion completed from a different IP", async () => {
    const authenticator = await enroll();
    const options = await beginLogin(rp(), IP);
    await expect(finishLogin(rp(), "198.51.100.7", authenticator.assert(options.challenge)))
      .rejects.toThrow(/IP changed/);
  });

  test("rejects a forged signature", async () => {
    const enrolled = await enroll();
    const impostor = new Authenticator();
    // Same credential ID, different private key — the stored public key must
    // be what decides, not the ID the client claims.
    impostor.credentialId = enrolled.credentialId;
    const options = await beginLogin(rp(), IP);
    await expect(finishLogin(rp(), IP, impostor.assert(options.challenge)))
      .rejects.toThrow();
  });

  test("rejects an unknown credential", async () => {
    await enroll();
    const stranger = new Authenticator();
    const options = await beginLogin(rp(), IP);
    await expect(finishLogin(rp(), IP, stranger.assert(options.challenge)))
      .rejects.toThrow(/Unrecognized passkey/);
  });

  test("rejects a passkey registered for another hostname", async () => {
    await enroll();
    const other = rp("other.example.com", "https://other.example.com");
    // A credential exists, but not for this host — login can't even begin.
    await expect(beginLogin(other, IP)).rejects.toThrow(/No passkeys registered/);
  });

  test("rejects an assertion signed for a different origin", async () => {
    const authenticator = await enroll();
    const options = await beginLogin(rp(), IP);
    const response = authenticator.assert(options.challenge, RP_ID, "https://evil.example.com");
    await expect(finishLogin(rp(), IP, response)).rejects.toThrow();
  });

  test("advances the signature counter and detects a clone", async () => {
    const authenticator = await enroll();

    authenticator.counter = 5;
    const first = await beginLogin(rp(), IP);
    const afterFirst = await finishLogin(rp(), IP, authenticator.assert(first.challenge));
    expect(afterFirst.counter).toBe(5);

    // A cloned authenticator replays an older counter value.
    authenticator.counter = 3;
    const second = await beginLogin(rp(), IP);
    await expect(finishLogin(rp(), IP, authenticator.assert(second.challenge))).rejects.toThrow();
  });

  test("records last_used on success", async () => {
    const authenticator = await enroll();
    expect(listCredentials(null)[0].last_used).toBeNull();
    const options = await beginLogin(rp(), IP);
    await finishLogin(rp(), IP, authenticator.assert(options.challenge));
    expect(listCredentials(null)[0].last_used).not.toBeNull();
  });
});

describe("credential management", () => {
  test("removing a credential disables passkey login for that host", async () => {
    await enroll();
    const id = listCredentials(null)[0].id;
    expect(deleteCredential(id, null)).toBe(true);
    expect(listCredentials(null)).toHaveLength(0);
    expect(hasCredentialsForRp(RP_ID, null)).toBe(false);
  });

  test("removing a non-existent credential reports failure", () => {
    expect(deleteCredential(9999, null)).toBe(false);
  });

  test("expired challenges are cleaned up", async () => {
    await beginRegistration(rp(), IP, null);
    db.run("UPDATE webauthn_challenges SET expires_at = datetime('now', '-1 minute')");
    cleanExpiredChallenges();
    const row = db.query("SELECT COUNT(*) as cnt FROM webauthn_challenges").get() as { cnt: number };
    expect(row.cnt).toBe(0);
  });

  test("an expired challenge cannot be used", async () => {
    const authenticator = new Authenticator();
    const options = await beginRegistration(rp(), IP, null);
    db.run("UPDATE webauthn_challenges SET expires_at = datetime('now', '-1 minute')");
    await expect(finishRegistration(rp(), IP, authenticator.attest(options.challenge), "Stale", null))
      .rejects.toThrow(/expired/);
  });
});
