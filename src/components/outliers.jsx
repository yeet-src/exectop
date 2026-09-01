// Tier 3a: what doesn't fit, ranked. The panel that makes this a tool rather
// than a readout — and the one held to the strictest bar, because a false
// alarm here costs more trust than a miss. Every reason shown is a property
// of an exec we actually observed (see lib/model.js for the scoring).
//
// Selecting a row jumps the tree below to that fold, pre-expanded: the
// high-level finding and its evidence are one keystroke apart.
import { Box, Text } from "yeet:tui";
import { C_BAD, C_DIM, C_FAINT, C_OK, C_SEL_BG, C_TEXT, clip, pad } from "@/lib/format.js";

export default ({ tick, outliers, total, selected, focused, width: W, maxRows }) => (
  <Box direction="column" overflow="hidden">
    {() => {
      tick.get();
      const outs = outliers();
      if (!outs.length) {
        // With no execs at all there is nothing to have judged, so don't claim
        // everything looked fine — say there was nothing to look at.
        const seen = total?.() ?? 0;
        return [
          <Text height="1" break="none" fg={seen ? C_OK : C_DIM}>
            {seen
              ? "  nothing out of place — every command here looks like ordinary work"
              : "  nothing to judge yet — no process has been launched in this scope"}
          </Text>,
        ];
      }
      const nameW = Math.max(20, Math.floor(W() * 0.42));
      const sel = selected.get();
      const on = focused.get();
      return outs.slice(0, maxRows).map((o, i) => {
        const isSel = on && i === sel;
        return (
          <Text height="1" break="none" bg={isSel ? C_SEL_BG : undefined}>
            <Text fg={C_BAD}>{"  ▲ "}</Text>
            <Text bold fg={C_TEXT}>{pad(clip(o.fold.label, nameW), nameW)}</Text>
            <Text fg={C_DIM}>{pad("  " + clip(o.reasons.join(", "), Math.max(12, W() - nameW - 8)), Math.max(12, W() - nameW - 6))}</Text>
          </Text>
        );
      });
    }}
  </Box>
);
