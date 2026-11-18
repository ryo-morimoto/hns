import { expect, test } from "vitest";
import {
  mirrorDefaultFrom,
  mirrorEnabled,
  mirrorOverrideFrom,
  mirrorSettingsOf,
} from "./kill-switch.ts";

// C1 / T1: Catches a switch read with a loose spelling (`yes`, `1`, `ON`) turning the mirror on, or
// an absent binding turning it on. The deploy writes `on` or `off`; anything else is off.
test("the deployment's switch is on only for the exact word on", () => {
  expect(mirrorDefaultFrom("on")).toBe("on");
  for (const value of ["off", "ON", "On", "yes", "1", "true", "", " on", undefined]) {
    expect(mirrorDefaultFrom(value), String(value)).toBe("off");
  }
});

// Catches a stored override this build does not know being read as a decision: an unknown row is no
// override, so the deployment decides instead of the workspace freezing.
test("a workspace override is one of the two words, and an unknown row is no override", () => {
  expect(mirrorOverrideFrom("on")).toBe("on");
  expect(mirrorOverrideFrom("off")).toBe("off");
  for (const value of ["", "ON", "yes", "true", undefined]) {
    expect(mirrorOverrideFrom(value), String(value)).toBeUndefined();
  }
});

// C1 / T1: Catches an override that does not win — a workspace's own switch is worthless if the
// deployment's default decides anyway, or if "off" in a mirroring deployment is ignored.
test("a workspace override wins over the deployment in both directions", () => {
  expect(mirrorEnabled({ default: "on" })).toBe(true);
  expect(mirrorEnabled({ default: "off" })).toBe(false);
  expect(mirrorEnabled({ default: "on", override: "off" })).toBe(false);
  expect(mirrorEnabled({ default: "off", override: "on" })).toBe(true);
  expect(mirrorEnabled({ default: "on", override: "on" })).toBe(true);
  expect(mirrorEnabled({ default: "off", override: "off" })).toBe(false);
});

// Catches the deploy seam being folded away: the binding is read when the option is absent, and the
// option (the test seam) wins when it is present; the stored row, when it names a word, wins over
// both.
test("the settings come from the deploy, with the stored override on top", () => {
  expect(mirrorSettingsOf({ ARTIFACTS_MIRROR: "on" }, undefined)).toStrictEqual({ default: "on" });
  expect(mirrorSettingsOf({ ARTIFACTS_MIRROR: "off" }, "on")).toStrictEqual({
    default: "off",
    override: "on",
  });
  expect(
    mirrorSettingsOf({ artifactsMirror: false, ARTIFACTS_MIRROR: "on" }, undefined),
  ).toStrictEqual({ default: "off" });
  expect(mirrorSettingsOf({ artifactsMirror: true, ARTIFACTS_MIRROR: "off" }, "off")).toStrictEqual(
    {
      default: "on",
      override: "off",
    },
  );
  // A row this build cannot read is not an override: the deployment still decides.
  expect(mirrorSettingsOf({ ARTIFACTS_MIRROR: "on" }, "loud")).toStrictEqual({ default: "on" });
  expect(mirrorSettingsOf({}, undefined)).toStrictEqual({ default: "off" });
});
