// Tier 3b: every exec, with repetition folded. A build that fires cc1 200
// times is ONE row saying ×200, not 200 rows nobody can read — the folding is
// what makes an exec stream legible at all.
//
// The tension worth knowing about: folding is also how a finding can hide. On
// a real npm install, folding `sh -c` on script text shattered one node-gyp
// recipe into dozens of rows, and folding it too aggressively would bury a
// suspicious one-liner inside a common bucket. lib/model.js documents where
// that line is drawn.
//
// Expanding a row shows the concrete argv of recent execs in that fold, which
// is where the elided paths come back.
import { Box, Text } from "yeet:tui";
import {
  BUCKET, C_DIM, C_FAINT, C_FLASH, C_SEL_BG, C_TEXT, bar, bucketOf, clip, fmtMs, lpad, pad,
} from "@/lib/format.js";

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export const TreeHeader = ({ width: W }) => (
  <Text height="1" break="none" fg={C_FAINT}>
    {() => {
      const nameW = Math.max(24, Math.floor(W() * 0.46));
      return "  " + pad("  command", nameW + 4) + lpad("count", 5) + "   " +
        pad("share", Math.max(8, Math.min(16, W() - 76)) + 8) +
        lpad("fork→exec", 9) + "  parent";
    }}
  </Text>
);

export default ({ tick, folds, flashes, selected, expanded, focused, top, width: W, maxRows }) => (
  <Box direction="column" overflow="hidden">
    {() => {
      tick.get();
      const fs = folds();
      const total = Math.max(1, fs.reduce((s, f) => s + f.count, 0));
      const nameW = Math.max(24, Math.floor(W() * 0.46));
      const barW = Math.max(8, Math.min(16, W() - 76));
      const sel = selected.get();
      const on = focused.get();
      const exp = expanded.get();
      const now = Date.now();

      const rows = [];
      const budget = typeof maxRows === "function" ? maxRows() : maxRows;
      for (let i = top.get(); i < fs.length && rows.length < budget; i++) {
        const f = fs[i];
        const isSel = on && i === sel;
        const isExp = exp.has(f.key);
        const col = BUCKET[bucketOf(f.comm)] ?? C_TEXT;
        const share = f.count / total;
        // A fold seen within the flash window renders white, so a process that
        // lived 3ms still registers even though its row never scrolls.
        const fresh = (flashes.get(f.key) ?? 0) > now;

        rows.push(
          <Text height="1" break="none" bg={isSel ? C_SEL_BG : undefined}>
            <Text fg={C_DIM}>{"  " + (isExp ? "▾ " : f.count > 1 ? "▸ " : "  ")}</Text>
            <Text bold={fresh} fg={fresh ? C_FLASH : col}>{pad(clip(f.label, nameW), nameW)}</Text>
            <Text bold fg={C_TEXT}>{lpad(f.count > 1 ? `×${f.count}` : "×1", 7)}</Text>
            <Text fg={col}>{"  " + bar(share, barW)}</Text>
            <Text fg={C_DIM}>{lpad(`${(share * 100).toFixed(1)}%`, 7)}</Text>
            <Text fg={C_DIM}>{lpad(fmtMs(median(f.lats)), 9)}</Text>
            {/* The trailing field is padded to the full row width. yeet:tui
                repaints by overwriting only the cells that changed and never
                emits an erase-in-line, so a row that gets SHORTER leaves its
                old tail on screen — "sh,node" overwritten by "sh" leaves
                ",node" behind. Every row must therefore clear its own line. */}
            <Text fg={C_FAINT}>{pad("  " + clip([...f.parents].join(","), 14), Math.max(0, W() - nameW - 34))}</Text>
          </Text>,
        );

        if (isExp) {
          for (const s of f.samples.slice(-6)) {
            if (rows.length >= budget) break;
            rows.push(
              <Text height="1" break="none">
                <Text fg={C_FAINT}>{"    ↳ "}</Text>
                <Text fg={C_DIM}>{pad(clip(s.argv.join(" "), Math.max(20, W() - 26)), Math.max(20, W() - 26))}</Text>
                <Text fg={C_FAINT}>{lpad(`pid ${s.pid}`, 12)}</Text>
              </Text>,
            );
          }
          if (f.count > 6 && rows.length < budget) {
            rows.push(
              <Text height="1" break="none" fg={C_FAINT}>{pad(`    ↳ …${f.count - 6} more`, W() - 1)}</Text>,
            );
          }
        }
      }
      return rows;
    }}
  </Box>
);
