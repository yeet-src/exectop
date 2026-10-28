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
// command you typed all look the same), so nothing here says "escaped". A
// "got past" line is argv-inferred unless the file-open probe confirmed a real
// read, which is tagged [verified]; the blocked side states only the namespace.
import { Box, Text } from "yeet:tui";
import {
  C_BAD, C_DIM, C_FAINT, C_OK, C_SEL_BG, C_TEXT, clip, fmtAge, pad,
} from "@/lib/format.js";

const now = () => Date.now();
const ageOf = (ts) => (ts ? fmtAge((now() - ts) / 1000) : "");

// The headline: the verdict, a count on each side, and — when the cursor is in
// a finding — an N/total position so movement is visible (Necco's rule: a cursor
// that can't be seen moving reads as broken).
const Headline = ({ tick, verdicts, selected, focused, width: W }) => (
  <Text height="1" break="none">
    {() => {
      tick.get();
      const v = verdicts();
      if (!v.detected) {
        return [<Text fg={C_DIM}>{"  watching for sandboxed commands…"}</Text>];
      }
      const past = v.past.length;
      const blocked = v.blocked.length;
      const total = past + blocked;
      const runs = [<Text fg={C_DIM}>{"  "}</Text>];
      runs.push(past
        ? <Text bold fg={C_BAD}>{`✗ ${past} got past the sandbox`}</Text>
        : <Text bold fg={C_OK}>{"✓ the sandbox held"}</Text>);
      runs.push(<Text fg={C_FAINT}>{"      "}</Text>);
      runs.push(<Text fg={blocked ? C_OK : C_DIM}>{`✓ ${blocked} blocked by the sandbox`}</Text>);
      // Right-aligned position counter, shown only while a finding is selected.
      let tail = "";
      if (focused.get() && total) tail = `${selected.get() + 1}/${total}`;
      const used = runs.reduce((n, r) => n + String(r?.props?.children ?? "").length, 0);
      const gap = Math.max(1, W() - used - tail.length - 2);
      runs.push(<Text>{" ".repeat(gap)}</Text>);
      if (tail) runs.push(<Text fg={C_FAINT}>{tail}</Text>);
      return runs;
    }}
  </Text>
);

// The column header for the finding rows, so the three columns read on their own.
const ColHead = ({ width: W }) => (
  <Text height="1" break="none" fg={C_FAINT}>
    {() => "     " + pad("age", 5) + "  " + pad("command", Math.max(16, Math.floor(W() * 0.34))) + "  what happened"}
  </Text>
);

// One finding row: cursor caret, mark, age, command, and the plain-language
// detail. The caret + background together make the selection unmistakable; the
// detail brightens and gets a [verified] tag when the file-open probe confirmed
// a real read, so a kernel fact is visibly distinct from an argv inference.
const Row = ({ item, mark, markColor, selected, W }) => {
  const labelW = Math.max(16, Math.floor(W * 0.34));
  const tag = item.verified ? "  [verified]" : "";
  const detailW = Math.max(16, W - labelW - 16 - tag.length);
  return (
    <Text height="1" break="none" bg={selected ? C_SEL_BG : undefined}>
      <Text bold fg={markColor}>{selected ? " ▸ " : "   "}</Text>
      <Text fg={markColor}>{mark + " "}</Text>
      <Text fg={C_FAINT}>{pad(ageOf(item.ts), 5)}</Text>
      <Text bold fg={C_TEXT}>{"  " + pad(clip(item.fold.label, labelW), labelW)}</Text>
      <Text fg={item.verified ? C_TEXT : C_DIM}>{"  " + clip(item.detail, detailW)}</Text>
      {tag ? <Text bold fg={C_OK}>{tag}</Text> : null}
    </Text>
  );
};

const SectionRule = ({ label, color, width: W }) => (
  <Text height="1" break="none" fg={color}>
    {() => "── " + label + " " + "─".repeat(Math.max(0, W() - label.length - 5))}
  </Text>
);

export default ({ tick, verdicts, selected, focused, width: W }) => (
  <Box direction="column" overflow="hidden">
    <Headline tick={tick} verdicts={verdicts} selected={selected} focused={focused} width={W} />
    {/* One-line explainer so the two panel names are self-defining. */}
    <Text height="1" break="none" fg={C_FAINT}>
      {() => "  got past = ran in the agent's own namespace · blocked = ran inside the sandbox"}
    </Text>
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

      out.push(<ColHead width={W} />);

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
