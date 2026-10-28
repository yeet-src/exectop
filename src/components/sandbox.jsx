// The sandbox view — the default screen when exectop is watching an agent whose
// commands run under a sandbox. It answers one question before any other: did
// anything sensitive run OUTSIDE the sandbox, where it wasn't declawed?
//
// Two panels, read top to bottom:
//   got past the sandbox  — sensitive commands that ran in the agent's own
//                           namespace (the sandbox was not in force for them)
//   blocked by the sandbox — the same kind of command that ran inside it, where
//                            the credential path or the network was walled off
//
// A headline above both turns red the moment anything is in the first panel and
// stays green while it is empty — the one glance that says "held" or "didn't".
//
// Wording is held to the credibility rule: the kernel tells us an exec ran in
// the host namespace, not WHY (an approved retry, an excluded command, a
// command you typed all look the same), so nothing here says "escaped". The
// detail names what the command reaches, from its argv.
import { Box, Text } from "yeet:tui";
import {
  C_BAD, C_DIM, C_FAINT, C_OK, C_SEL_BG, C_TEXT, C_TITLE, clip, fmtAge, pad,
} from "@/lib/format.js";

const now = () => Date.now();
const ageOf = (ts) => (ts ? fmtAge((now() - ts) / 1000) : "");

// The headline. One line that is the verdict, plus a count on each side.
const Headline = ({ tick, verdicts, width: W }) => (
  <Text height="1" break="none">
    {() => {
      tick.get();
      const v = verdicts();
      if (!v.detected) {
        return [<Text fg={C_DIM}>{"  watching for sandboxed commands…"}</Text>];
      }
      const past = v.past.length;
      const blocked = v.blocked.length;
      const runs = [<Text fg={C_DIM}>{"  "}</Text>];
      if (past) {
        runs.push(<Text bold fg={C_BAD}>{`✗ ${past} got past the sandbox`}</Text>);
      } else {
        runs.push(<Text bold fg={C_OK}>{"✓ the sandbox held"}</Text>);
      }
      runs.push(<Text fg={C_FAINT}>{"      "}</Text>);
      runs.push(<Text fg={blocked ? C_OK : C_DIM}>{`✓ ${blocked} blocked by the sandbox`}</Text>);
      // Clear the rest of the line (yeet:tui has no erase-in-line).
      const used = runs.reduce((n, r) => n + String(r?.props?.children ?? "").length, 0);
      runs.push(<Text>{" ".repeat(Math.max(0, W() - used - 2))}</Text>);
      return runs;
    }}
  </Text>
);

// One finding row: a mark, the command, and the plain-language detail. `sel` is
// the index into the flattened [past…, blocked…] list, so one cursor moves
// across both panels and Enter can drop into the tree.
const Row = ({ item, mark, markColor, selected, W }) => (
  <Text height="1" break="none" bg={selected ? C_SEL_BG : undefined}>
    <Text fg={markColor}>{"  " + mark + " "}</Text>
    <Text fg={C_FAINT}>{pad(ageOf(item.ts), 5)}</Text>
    <Text bold fg={C_TEXT}>{"  " + pad(clip(item.fold.label, Math.max(16, Math.floor(W * 0.34))), Math.max(16, Math.floor(W * 0.34)))}</Text>
    <Text fg={C_DIM}>{pad("  " + clip(item.detail, Math.max(16, W - Math.floor(W * 0.34) - 14)), Math.max(16, W - Math.floor(W * 0.34) - 12))}</Text>
  </Text>
);

const SectionRule = ({ label, color, width: W }) => (
  <Text height="1" break="none" fg={color}>
    {() => "── " + label + " " + "─".repeat(Math.max(0, W() - label.length - 5))}
  </Text>
);

export default ({ tick, verdicts, selected, focused, width: W }) => (
  <Box direction="column" overflow="hidden">
    <Headline tick={tick} verdicts={verdicts} width={W} />
    <Box height="1" />
    {() => {
      tick.get();
      const v = verdicts();
      const on = focused.get();
      const sel = selected.get();
      const out = [];

      if (!v.detected) {
        out.push(
          <Text height="1" break="none" fg={C_FAINT}>
            {"  No sandboxed command has run yet. exectop sees one once the agent"}
          </Text>,
          <Text height="1" break="none" fg={C_FAINT}>
            {"  launches a command that runs in a separate namespace."}
          </Text>,
        );
        return out;
      }

      // Panel 1: got past.
      out.push(<SectionRule label="got past the sandbox" color={C_BAD} width={W} />);
      if (!v.past.length) {
        out.push(
          <Text height="1" break="none" fg={C_OK}>
            {"  nothing — every sensitive command ran inside the sandbox"}
          </Text>,
        );
      } else {
        v.past.forEach((item, i) => {
          out.push(<Row item={item} mark="✗" markColor={C_BAD} selected={on && sel === i} W={W()} />);
        });
      }

      out.push(<Text height="1" />);

      // Panel 2: blocked.
      out.push(<SectionRule label="blocked by the sandbox" color={C_OK} width={W} />);
      if (!v.blocked.length) {
        out.push(
          <Text height="1" break="none" fg={C_DIM}>
            {"  nothing sensitive has run inside the sandbox yet"}
          </Text>,
        );
      } else {
        const base = v.past.length;
        v.blocked.forEach((item, i) => {
          out.push(<Row item={item} mark="✓" markColor={C_OK} selected={on && sel === base + i} W={W()} />);
        });
      }
      return out;
    }}
  </Box>
);

// The flattened selectable list, so main.jsx can bound the cursor and resolve a
// selection to its fold without re-deriving the ordering.
export const verdictList = (v) => [...v.past, ...v.blocked];
