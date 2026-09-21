import { test } from "node:test";
import assert from "node:assert/strict";

import { creditGate, formatReset, limitReached, liveWindows, parseRateLimits, usageLines, windowLabel } from "../src/usage.js";

const NOW = Date.parse("2026-09-21T21:30:00Z");
const line = (rate_limits, timestamp = "2026-09-21T21:29:54.913Z") =>
  JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: {}, rate_limits } });
const limits = (over = {}) => ({
  limit_id: "codex",
  primary: { used_percent: 16.0, window_minutes: 300, resets_at: NOW / 1000 + 7200 },
  secondary: { used_percent: 3.0, window_minutes: 10080, resets_at: NOW / 1000 + 172800 },
  credits: { has_credits: false, unlimited: false, balance: "0" },
  plan_type: "plus",
  rate_limit_reached_type: null,
  ...over,
});

test("windowLabel: names the common windows", () => {
  assert.equal(windowLabel(300), "5-hour");
  assert.equal(windowLabel(10080), "weekly");
  assert.equal(windowLabel(1440), "1-day");
  assert.equal(windowLabel(45), "45-minute");
});

test("parseRateLimits: takes the last snapshot and skips junk and huge lines", () => {
  const huge = JSON.stringify({ payload: { rate_limits: limits(), blob: "A".repeat(60_000) } });
  const text = [line(limits({ primary: { used_percent: 10, window_minutes: 300, resets_at: 1 } })), "not json \"rate_limits\"", huge, line(limits()), ""].join("\n");
  const u = parseRateLimits(text);
  assert.equal(u.plan, "plus");
  assert.equal(u.at, Date.parse("2026-09-21T21:29:54.913Z"));
  assert.deepEqual(u.windows.map((w) => [w.label, w.usedPercent]), [["5-hour", 16], ["weekly", 3]]);
  assert.deepEqual(u.credits, { unlimited: false, balance: 0, available: false });
  assert.equal(parseRateLimits("nothing here"), null);
  assert.equal(parseRateLimits(""), null);
  assert.equal(parseRateLimits(line({ primary: null, secondary: null })), null);

  const rich = parseRateLimits(line(limits({ credits: { has_credits: true, unlimited: false, balance: "250" } })));
  assert.deepEqual(rich.credits, { unlimited: false, balance: 250, available: true });
  assert.equal(parseRateLimits(line(limits({ credits: { has_credits: true, unlimited: false, balance: "0" } }))).credits.available, false);
  assert.equal(parseRateLimits(line(limits({ credits: { unlimited: true } }))).credits.available, true);
});

test("liveWindows / limitReached: a window past its reset says nothing about now", () => {
  const u = parseRateLimits(line(limits({ primary: { used_percent: 100, window_minutes: 300, resets_at: NOW / 1000 - 60 } })));
  assert.deepEqual(liveWindows(u, NOW).map((w) => w.label), ["weekly"]);
  assert.equal(limitReached(u, NOW), false);
  assert.equal(limitReached(parseRateLimits(line(limits({ secondary: { used_percent: 100, window_minutes: 10080, resets_at: NOW / 1000 + 60 } }))), NOW), true);
  assert.equal(limitReached(parseRateLimits(line(limits({ rate_limit_reached_type: "primary" }))), NOW), true);
  assert.equal(limitReached(null, NOW), false);
});

test("usageLines: usage summary, and a warning that depends on credits", () => {
  const calm = usageLines(parseRateLimits(line(limits())), { now: NOW });
  assert.equal(calm.length, 1);
  assert.match(calm[0], /^Plan usage: 16% of the 5-hour limit \(resets at \d\d:\d\d\), 3% of the weekly limit \(resets \w{3} at \d\d:\d\d\)\.$/);

  const tight = limits({ primary: { used_percent: 91.4, window_minutes: 300, resets_at: NOW / 1000 + 7200 } });
  const noCredits = usageLines(parseRateLimits(line(tight)), { now: NOW });
  assert.match(noCredits[0], /91% of the 5-hour limit/);
  assert.match(noCredits[1], /Usage warning: the 5-hour limit is nearly used up\. After that, jobs stop until the limit resets at \d\d:\d\d, unless credits are added\./);

  const withCredits = usageLines(parseRateLimits(line({ ...tight, credits: { has_credits: true, unlimited: false, balance: "40" } })), { now: NOW });
  assert.match(withCredits[1], /jobs run on paid credits \(40 credits available\); Pixmith will ask before using them\./);

  assert.equal(usageLines(parseRateLimits(line(tight)), { now: NOW, warnPercent: 95 }).length, 1);
  assert.deepEqual(usageLines(null), []);
  assert.match(formatReset(null), /soon/);
});

test("creditGate: proceed, confirm, block", () => {
  const spent = limits({ primary: { used_percent: 100, window_minutes: 300, resets_at: NOW / 1000 + 7200 } });
  const broke = parseRateLimits(line(spent));
  const funded = parseRateLimits(line({ ...spent, credits: { has_credits: true, unlimited: false, balance: "250" } }));

  assert.equal(creditGate(parseRateLimits(line(limits())), { now: NOW }).action, "proceed");
  assert.equal(creditGate(null, { now: NOW }).action, "proceed");

  const ask = creditGate(funded, { now: NOW });
  assert.equal(ask.action, "confirm");
  assert.match(ask.message, /5-hour limit for Codex is used up; it resets at \d\d:\d\d\. The account has 250 credits available/);
  assert.equal(creditGate(funded, { now: NOW, useCredits: true }).action, "proceed");
  assert.equal(creditGate(funded, { now: NOW, policy: "always" }).action, "proceed");
  assert.equal(creditGate(funded, { now: NOW, policy: "never", useCredits: true }).action, "block");

  // No credits in the snapshot: still overridable, because the snapshot can lag a fresh purchase.
  const none = creditGate(broke, { now: NOW });
  assert.equal(none.action, "confirm");
  assert.match(none.message, /no credits on the account, so a job would most likely fail/);
  assert.equal(creditGate(broke, { now: NOW, useCredits: true }).action, "proceed");
});
