// Country allow-list: known-code validation and the picker's source list.

import { describe, expect, test } from "bun:test";
import { listCountries, normalizeCountryCodes, isKnownCountryCode } from "../src/countries";
import { getAllowedCountries, setAllowedCountries, isCountryAllowed } from "../src/analytics";

describe("countries", () => {
  test("the list covers ISO regions plus Cloudflare specials, with names", () => {
    const list = listCountries();
    expect(list.length).toBeGreaterThan(240);
    const us = list.find(c => c.code === "US")!;
    expect(us.name).toBe("United States");
    expect(list.find(c => c.code === "T1")!.name).toMatch(/Tor/);
    expect(list.find(c => c.code === "XK")!.name).toBe("Kosovo");
    expect(isKnownCountryCode("GB")).toBe(true);
    expect(isKnownCountryCode("ZZ")).toBe(false);
    // Sorted by name so the picker reads naturally.
    const names = list.map(c => c.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  test("normalizeCountryCodes uppercases, dedupes, sorts, and rejects unknowns", () => {
    expect(normalizeCountryCodes([" us", "GB", "us", "ca "])).toEqual(["CA", "GB", "US"]);
    expect(normalizeCountryCodes([])).toEqual([]);
    expect(() => normalizeCountryCodes(["USA"])).toThrow(/Unknown country code 'USA'/);
    expect(() => normalizeCountryCodes(["ZZ"])).toThrow(/Unknown/);
    expect(() => normalizeCountryCodes("US" as any)).toThrow(/array/);
    expect(() => normalizeCountryCodes([42] as any)).toThrow(/strings/);
  });

  test("setAllowedCountries refuses invalid input and leaves the prior list intact", () => {
    setAllowedCountries(["US", "gb"]);
    expect(getAllowedCountries()).toEqual(["GB", "US"]);
    expect(() => setAllowedCountries(["US", "Narnia"])).toThrow(/Unknown/);
    expect(getAllowedCountries()).toEqual(["GB", "US"]);
    expect(isCountryAllowed("us")).toBe(true);
    expect(isCountryAllowed("FR")).toBe(false);
    expect(isCountryAllowed(null)).toBe(false);
    setAllowedCountries([]);
    expect(isCountryAllowed(null)).toBe(true);
  });
});
