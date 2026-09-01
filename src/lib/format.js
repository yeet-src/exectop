// Pure presentation: palette, string helpers, small chart primitives.
// No signals, no BPF. Imported by components through the `@/` alias.
//
// Palette follows pktscope's truecolor convention. The discipline: chrome
// stays dim so it recedes, data stays bright, and strong color is reserved
// for MEANING — here, which behavior bucket a command belongs to.
import { rgb } from "yeet:tui";

export const C_BRAND = rgb(125, 211, 252);
export const C_TITLE = rgb(240, 246, 252);
export const C_TEXT = rgb(235, 240, 245);
export const C_DIM = rgb(120, 130, 140);
export const C_FAINT = rgb(80, 88, 98);
export const C_OK = rgb(74, 222, 128);
export const C_WARN = rgb(250, 204, 21);
export const C_BAD = rgb(248, 113, 113);
export const C_FLASH = rgb(255, 255, 255); // a just-seen exec, before it decays
export const C_SEL_BG = rgb(38, 66, 104);
export const C_RAIL = rgb(28, 32, 38);
export const C_CAP = rgb(52, 58, 66);

// One color per behavior bucket. A row's color IS its category — no badge
// column, which would break alignment and read slower (redissnoop's trick).
export const BUCKET = {
  compile: rgb(199, 168, 255), // violet
  runtime: rgb(125, 211, 252), // sky
  shell: rgb(163, 230, 53),    // lime
  files: rgb(94, 234, 212),    // teal
  text: rgb(148, 163, 184),    // slate — the shell-plumbing majority
  vcs: rgb(253, 186, 116),     // apricot
  net: rgb(248, 113, 113),     // red — the one that should catch the eye
  other: rgb(120, 130, 140),
};

export const bucketOf = (c) =>
  /^(cc1|cc1plus|cc|gcc|g\+\+|clang|clang\+\+|as|ld|ar|ranlib|collect2|make|cmake|ninja)$/.test(c) ? "compile" :
  /^(node|python3?|ruby|perl|deno|bun|npm|npx|yarn|pnpm|node-gyp-build)$/.test(c) ? "runtime" :
  /^(sh|bash|dash|zsh)$/.test(c) ? "shell" :
  /^(rm|mv|cp|mkdir|rmdir|install|tar|gzip|gunzip|unzip|xz|chmod|chown|touch|ln|readlink|dirname|basename)$/.test(c) ? "files" :
  /^(sed|awk|grep|egrep|fgrep|printf|echo|cat|head|tail|cut|tr|sort|uniq|wc|tee|seq|expr|test|true|false|env|which|date|sleep|uname|id|stat|find|xargs|ls|pwd)$/.test(c) ? "text" :
  /^(git|hg|svn)$/.test(c) ? "vcs" :
  /^(curl|wget|nc|ncat|socat|ssh|scp|sftp|rsync|openssl|base64)$/.test(c) ? "net" : "other";

export const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));
export const lpad = (s, n) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
export const clip = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…");

// Thousands separators WITHOUT toLocaleString(). The isolate has no ICU data,
// and Number.prototype.toLocaleString() throws "Internal error. Icu error."
// there — inside a render that surfaces as the whole TUI dying on the first
// frame that has data, with the error printed after the screen tears down.
export const fmtCount = (n) => {
  const s = String(Math.round(n));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
};

// An age in seconds, read as prose: "4s", "90s", "4m", "1h12m".
export const fmtAge = (sec) => {
  const s = Math.max(0, Math.round(sec));
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

export const fmtRate = (perSec) =>
  perSec < 10 ? perSec.toFixed(1) : perSec < 1000 ? String(Math.round(perSec)) : `${(perSec / 1e3).toFixed(1)}K`;

export const fmtMs = (us) =>
  us < 1000 ? `${Math.round(us)}µs` : us < 1e6 ? `${(us / 1000).toFixed(1)}ms` : `${(us / 1e6).toFixed(1)}s`;

// A proportion bar. Returns a STRING (callers wrap it in one <Text>), not an
// array of runs — the run-concatenation trap only bites when mixing colors.
export const bar = (frac, width) => {
  const full = Math.max(0, Math.min(width, Math.round(frac * width)));
  return "█".repeat(full) + "·".repeat(width - full);
};

const SPARK = "▁▂▃▄▅▆▇█";
export const sparkline = (vals, width) => {
  const v = vals.slice(-width);
  if (!v.length) return "";
  const max = Math.max(1, ...v);
  return v.map((x) => SPARK[Math.min(7, Math.floor((x / max) * 7.99))]).join("");
};
