import { expect, test } from "vitest";
import { bottomOffset, FOLLOW_SLACK_PX, followOf } from "./follow.ts";

// Catches: a reader scrolled up being pulled back to the end by every new line.
test("only a reader at the end follows", () => {
  const atEnd = { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 };
  expect(followOf(atEnd)).toBe("following");
  expect(followOf({ ...atEnd, scrollTop: 800 })).toBe("reading");
});

// Catches: a container that does not overflow (a short conversation) being treated as "reading",
// so the first long answer appears below the fold with no way to see it.
test("a transcript that fits is always at its end", () => {
  expect(followOf({ scrollTop: 0, scrollHeight: 40, clientHeight: 100 })).toBe("following");
  expect(followOf({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe("following");
});

// Catches: a rounding difference of a pixel or two counting as "scrolled away".
test("a few pixels of slack still count as the end", () => {
  expect(followOf({ scrollTop: 876, scrollHeight: 1000, clientHeight: 100 })).toBe("following");
  expect(FOLLOW_SLACK_PX).toBeGreaterThan(0);
  expect(
    followOf({
      scrollTop: 1000 - 100 - FOLLOW_SLACK_PX - 1,
      scrollHeight: 1000,
      clientHeight: 100,
    }),
  ).toBe("reading");
});

test("the bottom offset never goes above the first line", () => {
  expect(bottomOffset({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(900);
  expect(bottomOffset({ scrollTop: 0, scrollHeight: 40, clientHeight: 100 })).toBe(0);
});
