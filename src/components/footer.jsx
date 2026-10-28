// Key-hint rail. Raised key-caps: the glyph in bold gold on a tile a shade
// lighter than the rail, then a dimmed label, so keys pop out of the line.
import { Box, Text } from "yeet:tui";
import { C_CAP, C_DIM, C_RAIL, C_WARN } from "@/lib/format.js";

const hint = (keys, label) => [
  <Text bg={C_CAP} bold fg={C_WARN}>{` ${keys} `}</Text>,
  <Text fg={C_DIM}>{` ${label}   `}</Text>,
];

export default ({ paused, view, sandboxSeen }) => (
  <Box height="1" direction="row" bg={C_RAIL}>
    <Text break="none">
      {() => {
        const sbx = view?.get?.() === "sandbox";
        const parts = ["  ", ...hint("↑/↓", "move")];
        parts.push(...hint("⏎", sbx ? "show command" : "expand"));
        if (!sbx) parts.push(...hint("tab", "pane"));
        // Offer the view toggle only once there is a sandbox view to switch to.
        if (sandboxSeen?.get?.()) parts.push(...hint("s", sbx ? "all execs" : "sandbox"));
        parts.push(...hint("p", paused.get() ? "resume" : "pause"));
        parts.push(...hint("q", "quit"));
        return parts;
      }}
    </Text>
  </Box>
);
