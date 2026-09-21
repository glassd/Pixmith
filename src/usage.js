import { promises as fs } from "node:fs";
import path from "node:path";

import { listRolloutLogs } from "./codex.js";

// Codex records the ChatGPT plan's rate limits in every session log (rollout
// *.jsonl) as part of its `token_count` events. Pixmith reads the most recent
// snapshot to tell the user how much of their plan is left, and to ask before
// a job would run on paid credits. Pixmith never reads auth tokens and never
// buys anything: it only reports, and decides whether to start a job.

const TAIL_BYTES = 256 * 1024;

/** "5-hour", "weekly", or a plain duration for anything else. */
export function windowLabel(minutes) {
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function normalizeWindow(w) {
  if (!w || typeof w !== "object") return null;
  const usedPercent = Number(w.used_percent);
  const minutes = Number(w.window_minutes);
  const resetsAt = Number(w.resets_at) * 1000;
  if (!Number.isFinite(usedPercent) || !Number.isFinite(minutes) || minutes <= 0) return null;
  return { label: windowLabel(minutes), minutes, usedPercent, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

/**
 * Extract the LAST rate-limit snapshot from rollout-log text. Returns
 *   { at, plan, windows: [{label, minutes, usedPercent, resetsAt}], credits: {available, unlimited, balance}, reachedType }
 * or null when the text holds none. Lines are pre-filtered by substring so the
 * multi-megabyte base64 image lines are never JSON-parsed.
 */
export function parseRateLimits(text) {
  if (!text) return null;
  let found = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"rate_limits"') || line.length > 50_000) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const rl = o?.payload?.rate_limits;
    if (!rl || typeof rl !== "object") continue;
    const windows = [normalizeWindow(rl.primary), normalizeWindow(rl.secondary)].filter(Boolean);
    if (!windows.length) continue;
    const balance = Number(rl.credits?.balance);
    const unlimited = rl.credits?.unlimited === true;
    found = {
      at: Date.parse(o.timestamp) || null,
      plan: typeof rl.plan_type === "string" ? rl.plan_type : null,
      windows,
      credits: {
        unlimited,
        balance: Number.isFinite(balance) ? balance : 0,
        available: unlimited || (rl.credits?.has_credits === true && balance > 0),
      },
      reachedType: rl.rate_limit_reached_type ?? null,
    };
  }
  return found;
}

async function readTail(file) {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return { text: buf.toString("utf8"), whole: start === 0 };
  } finally {
    await fh.close();
  }
}

/**
 * The most recent usage snapshot Codex has written. With `sessionId`, that
 * session's log is tried first (it is the freshest right after a job). Returns
 * null when nothing usable is found — usage reporting is always best-effort.
 */
export async function readUsage({ sessionId = null, maxFiles = 5 } = {}) {
  try {
    const logs = [...(await listRolloutLogs())].map(([file, mtime]) => ({ file, mtime }));
    logs.sort((a, b) => b.mtime - a.mtime);
    const mine = sessionId ? logs.filter((l) => path.basename(l.file).toLowerCase().includes(sessionId)) : [];
    const ordered = [...mine, ...logs.filter((l) => !mine.includes(l))].slice(0, maxFiles);

    let best = null;
    for (const { file } of ordered) {
      let usage = null;
      try {
        const tail = await readTail(file);
        usage = parseRateLimits(tail.text);
        if (!usage && !tail.whole) usage = parseRateLimits(await fs.readFile(file, "utf8"));
      } catch {
        continue;
      }
      if (usage && (!best || (usage.at ?? 0) > (best.at ?? 0))) best = usage;
      if (best && mine.length === 0) break; // newest file with data wins
    }
    return best;
  } catch {
    return null;
  }
}

/** Windows that have not reset yet; a window past its reset time says nothing about now. */
export function liveWindows(usage, now = Date.now()) {
  if (!usage) return [];
  return usage.windows.filter((w) => w.resetsAt == null || w.resetsAt > now);
}

export function formatReset(resetsAt, now = Date.now()) {
  if (!resetsAt) return "soon";
  const d = new Date(resetsAt);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return `at ${time}`;
  return `${d.toLocaleDateString("en-GB", { weekday: "short" })} at ${time}`;
}

function creditsText(credits) {
  if (credits.unlimited) return "unlimited credits";
  return credits.available ? `${credits.balance} credits available` : "no credits on the account";
}

const BUY_HINT = "Credits can be added in ChatGPT under Settings > Usage, or in the Codex app under Usage & Billing.";

/** True when a live window is exhausted, i.e. the next job would not run on plan usage. */
export function limitReached(usage, now = Date.now()) {
  const live = liveWindows(usage, now);
  if (!live.length) return false;
  return live.some((w) => w.usedPercent >= 100) || Boolean(usage.reachedType);
}

/**
 * Lines appended to a finished job: how much of the plan is used, plus a
 * warning once any window passes `warnPercent`.
 */
export function usageLines(usage, { warnPercent = 80, now = Date.now() } = {}) {
  const live = liveWindows(usage, now);
  if (!live.length) return [];
  const parts = live.map((w) => `${Math.round(w.usedPercent)}% of the ${w.label} limit (resets ${formatReset(w.resetsAt, now)})`);
  const lines = [`Plan usage: ${parts.join(", ")}.`];
  const tight = live.filter((w) => w.usedPercent >= warnPercent).sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (tight) {
    const after = usage.credits.available
      ? `After that, jobs run on paid credits (${creditsText(usage.credits)}); Pixmith will ask before using them.`
      : `After that, jobs stop until the limit resets ${formatReset(tight.resetsAt, now)}, unless credits are added. ${BUY_HINT}`;
    lines.push(`Usage warning: the ${tight.label} limit is nearly used up. ${after}`);
  }
  return lines;
}

/**
 * Decide whether a new job may start. Returns { action, message }:
 *   "proceed"  start the job
 *   "confirm"  the plan limit is reached; the user must agree to continue
 *              (on credits, if there are any) by passing use_credits: true
 *   "block"    the limit is reached and the policy forbids credits
 *
 * `policy` is "ask" (default), "always" or "never". The snapshot can lag
 * behind reality (credits bought a minute ago are not in it yet), so "confirm"
 * is always overridable — only an explicit "never" blocks outright.
 */
export function creditGate(usage, { policy = "ask", useCredits = false, now = Date.now() } = {}) {
  if (!limitReached(usage, now)) return { action: "proceed", message: "" };

  const live = liveWindows(usage, now);
  const spent = live.filter((w) => w.usedPercent >= 100).sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0] ?? live[0];
  const head = `Your ChatGPT plan's ${spent.label} limit for Codex is used up; it resets ${formatReset(spent.resetsAt, now)}.`;

  if (policy === "never") {
    return {
      action: "block",
      message: `${head} Pixmith is configured never to continue on paid credits (PIXMITH_USE_CREDITS=never), so no job was started.`,
    };
  }
  if (policy === "always" || useCredits) return { action: "proceed", message: "" };

  const message = usage.credits.available
    ? `${head} The account has ${creditsText(usage.credits)}, and Codex would spend them on this job. No job was started. ` +
      "Ask the user whether to continue on paid credits; if they agree, call the tool again with use_credits: true."
    : `${head} The account shows ${creditsText(usage.credits)}, so a job would most likely fail. No job was started. ${BUY_HINT} ` +
      "If the user has just added credits and wants to continue on them, call the tool again with use_credits: true.";
  return { action: "confirm", message };
}
