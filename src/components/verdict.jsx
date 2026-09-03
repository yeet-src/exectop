// Tier 1: the verdict. Two lines that answer "what is this application doing"
// before you read anything else — the total, the rate, a sparkline, the
// dominant behavior, and whether anything looks out of place.
import { Box, Text } from "yeet:tui";
import { C_BAD, C_DIM, C_FAINT, C_OK, C_TITLE, C_WARN, BUCKET, fmtAge, fmtCount, fmtRate, pad, sparkline } from "@/lib/format.js";

export default ({ tick, stats, buckets, outliers, idle, dropped, width: W }) => (
  <Box direction="column" height="2">
    <Text height="1" break="none">
      {() => {
        tick.get();
        const s = stats();
        if (!s.total) {
          // Nothing yet. For the first few seconds that is just startup; after
          // that it is the actual answer, so say so.
          const t = idle().sinceAttach;
          return t < 6
            ? [<Text fg={C_DIM}>{"  watching…"}</Text>]
            : [
                <Text fg={C_OK}>{"  no execs in " + fmtAge(t)}</Text>,
                <Text fg={C_DIM}>{" — nothing in this scope has launched a process"}</Text>,
              ];
        }
        return [
          <Text fg={C_DIM}>{"  "}</Text>,
          <Text bold fg={C_TITLE}>{`${fmtCount(s.total)} execs`}</Text>,
          <Text fg={C_DIM}>{` in ${s.elapsed.toFixed(0)}s · `}</Text>,
          <Text bold fg={C_TITLE}>{`${fmtRate(s.rate)}/s`}</Text>,
          // Padded to full width: yeet:tui never emits erase-in-line, so a
          // line that shortens (a 4-digit count dropping to 3, the sparkline
          // narrowing) would leave its old tail on screen.
          <Text fg={C_FAINT}>{pad("   " + sparkline(s.spark, Math.max(8, Math.min(40, W() - 44))), Math.max(10, W() - 34))}</Text>,
        ];
      }}
    </Text>
    <Text height="1" break="none">
      {() => {
        tick.get();
        const s = stats();
        if (!s.total) {
          return [<Text fg={C_FAINT}>{"  a service that is up and serving usually execs nothing at all"}</Text>];
        }
        const quiet = idle().sinceExec;
        const bs = buckets();
        const top = bs[0];
        const outs = outliers();
        const runs = [<Text fg={C_DIM}>{"  mostly "}</Text>];
        if (top) {
          runs.push(<Text bold fg={BUCKET[top.id] ?? C_TITLE}>{top.label}</Text>);
          runs.push(<Text fg={C_DIM}>{` (${((top.count / s.total) * 100).toFixed(0)}% of execs)`}</Text>);
        }
        runs.push(<Text fg={C_DIM}>{" · "}</Text>);
        runs.push(outs.length
          ? <Text bold fg={C_BAD}>{outs.length === 1 ? "1 thing that doesn't fit" : `${outs.length} things that don't fit`}</Text>
          : <Text fg={C_OK}>{"nothing out of place"}</Text>);
        // A burst that has ended is the common shape: a build spikes for a few
        // seconds and then stops. Say the stream went quiet instead of leaving
        // a rate on screen that hasn't been true for minutes.
        if (quiet != null && quiet > 10) {
          runs.push(<Text fg={C_DIM}>{`  ·  quiet for ${fmtAge(quiet)}`}</Text>);
        }
        // A dropped exec means the counts below are a floor, not a total. Say
        // so where the totals are, rather than letting a burst quietly
        // truncate the picture.
        const lost = dropped?.() ?? 0;
        if (lost > 0) {
          runs.push(<Text bold fg={C_WARN}>{`  ·  ${fmtCount(lost)} dropped`}</Text>);
        }
        // Clear the rest of the line (see above — no erase-in-line exists).
        const used = runs.reduce((n, r) => n + String(r?.props?.children ?? "").length, 0);
        runs.push(<Text>{" ".repeat(Math.max(0, W() - used - 2))}</Text>);
        return runs;
      }}
    </Text>
  </Box>
);
