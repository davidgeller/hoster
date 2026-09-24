// Request-smuggling regression for /_hoster/unlock: an oversized body must be
// consumed (or the connection closed), never abandoned mid-stream where its
// remaining bytes would be parsed as a new request. Behind a proxy that reuses
// origin connections across visitors, that would let one visitor inject a
// request whose response goes to someone else.

import { expect, test } from "bun:test";
import db from "../src/db";
import { createServer } from "../src/server";

async function raw(port: number, payload: string, waitMs = 700): Promise<string> {
  let out = "";
  const sock = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data(_s, d) { out += new TextDecoder().decode(d); }, error() {}, close() {} } });
  sock.write(payload);
  await Bun.sleep(waitMs);
  sock.end();
  return out;
}

const hidden = (marker: string) => `GET /${marker} HTTP/1.1\r\nHost: x\r\n\r\n`;
const statuses = (s: string) => (s.match(/HTTP\/1\.1 \d+/g) || []).map(x => Number(x.slice(9)));
const logged = (marker: string) => (db.query("SELECT COUNT(*) AS n FROM requests WHERE path = ?").get(`/${marker}`) as { n: number }).n;

test("oversized unlock bodies never smuggle a request", async () => {
  const s = createServer(0);
  try {
    // Chunked, over the 8 KB cap, a request hidden in the body, then a real one.
    const inner = "code=" + "A".repeat(9000) + hidden("smug-chunked");
    const r1 = await raw(s.port, `POST /_hoster/unlock HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nTransfer-Encoding: chunked\r\n\r\n${inner.length.toString(16)}\r\n${inner}\r\n0\r\n\r\n` + hidden("after-chunked"));
    expect(statuses(r1)).toEqual([413, 404]);

    // Declared length over the cap (but under 1 MB), fully sent.
    const body = "code=" + "B".repeat(20000) + hidden("smug-mid");
    const r2 = await raw(s.port, `POST /_hoster/unlock HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\n\r\n${body}` + hidden("after-mid"));
    expect(statuses(r2)).toEqual([413, 404]);

    // Declared length over 1 MB: refused and the connection closed.
    const r3 = await raw(s.port, `POST /_hoster/unlock HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 2000000\r\n\r\ncode=AAAA` + hidden("smug-declared"));
    expect(statuses(r3)).toEqual([413]);

    for (const m of ["smug-chunked", "smug-mid", "smug-declared"]) expect(logged(m)).toBe(0);
    for (const m of ["after-chunked", "after-mid"]) expect(logged(m)).toBe(1);
  } finally {
    s.stop(true);
  }
});
