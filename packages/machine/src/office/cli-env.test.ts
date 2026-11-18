import { expect, test } from "vitest";
import { officeOptionsOf } from "../cli.ts";

// The office engine is off unless the deployment names its pack. The variables are read together:
// a first draft returned after the first directory it found, so naming the cache silently dropped
// the runs' directory.

// Catches: an agent started with a pack but a cache that is not the one the operator named (the
// draft that returned early), and an empty variable taken as a directory name (the agent would
// try to make `""`).
test("NB5: the office variables are read together, and an empty one is not a directory", () => {
  expect(officeOptionsOf({})).toBeUndefined();
  expect(officeOptionsOf({ HNS_OFFICE_PACK: "" })).toBeUndefined();
  expect(officeOptionsOf({ HNS_OFFICE_PACK: "/packs/office" })).toStrictEqual({
    packRoot: "/packs/office",
  });
  // Both directories named: neither is dropped.
  expect(
    officeOptionsOf({
      HNS_OFFICE_PACK: "/packs/office",
      HNS_OFFICE_CACHE: "/var/cache/hns",
      HNS_OFFICE_WORK: "/var/tmp/hns",
    }),
  ).toStrictEqual({
    packRoot: "/packs/office",
    cacheRoot: "/var/cache/hns",
    workRoot: "/var/tmp/hns",
  });
  // One of them, and the other empty: the empty one is absent, not a directory named "".
  for (const pair of [
    { HNS_OFFICE_CACHE: "/var/cache/hns", HNS_OFFICE_WORK: "" },
    { HNS_OFFICE_CACHE: "", HNS_OFFICE_WORK: "/var/tmp/hns" },
  ]) {
    const options = officeOptionsOf({ HNS_OFFICE_PACK: "/packs/office", ...pair });
    expect(options?.packRoot).toBe("/packs/office");
    expect(options?.cacheRoot).toBe(pair.HNS_OFFICE_CACHE === "" ? undefined : "/var/cache/hns");
    expect(options?.workRoot).toBe(pair.HNS_OFFICE_WORK === "" ? undefined : "/var/tmp/hns");
  }
});
