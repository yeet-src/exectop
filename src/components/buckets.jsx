// Tier 2: what the application is doing, by behavior. One row per bucket with
// a share bar — the high-level shape, readable without moving the cursor.
import { Box, Text } from "yeet:tui";
import { BUCKET, C_DIM, C_TEXT, bar, lpad, pad } from "@/lib/format.js";

const LABEL_W = 17;

export default ({ tick, stats, buckets, width: W, maxRows }) => (
  <Box direction="column" overflow="hidden">
    {() => {
      tick.get();
      const total = Math.max(1, stats().total);
      const barW = Math.max(8, Math.min(30, W() - LABEL_W - 16));
      return buckets().slice(0, maxRows).map((b) => {
        const frac = b.count / total;
        const col = BUCKET[b.id] ?? C_TEXT;
        return (
          <Text height="1" break="none">
            <Text fg={col}>{"  " + pad(b.label, LABEL_W)}</Text>
            <Text fg={col}>{bar(frac, barW)}</Text>
            <Text fg={C_TEXT}>{lpad(String(b.count), 7)}</Text>
            <Text fg={C_DIM}>{pad(lpad(`${(frac * 100).toFixed(1)}%`, 7), Math.max(7, W() - LABEL_W - barW - 9))}</Text>
          </Text>
        );
      });
    }}
  </Box>
);
