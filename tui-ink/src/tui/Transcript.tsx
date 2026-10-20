/**
 * SpawnHeader — startup banner at the top of the Agents view: top/bottom rule
 * lines (input-bar style) + a blinking mascot. Uses the live palette (so
 * /palette recolors it). Gone once you Enter into a chat. (spawn-1.0 M3-7c)
 */

import React, { useContext, useEffect, useState } from "react";
import { Box, Text } from "ink";
import { PaletteContext } from "../ui.js";

/** A little mascot whose eyes blink every few seconds. */
function Mascot({ color }: { color: string }): React.ReactElement {
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      setClosed(true);
      const c = setTimeout(() => setClosed(false), 140);
      return () => clearTimeout(c);
    }, 3200);
    return () => clearInterval(t);
  }, []);
  const eyes = closed ? "─ ─" : "● ●";
  return (
    <Box flexDirection="column" marginRight={2}>
      <Text color={color}> ▟███▙ </Text>
      <Text color={color}>╭─────╮</Text>
      <Text color={color}>│ {eyes} │</Text>
      <Text color={color}>╰─────╯</Text>
    </Box>
  );
}

export function SpawnHeader({ model }: { model: string }): React.ReactElement {
  const p = useContext(PaletteContext);
  const cwd = process.cwd();
  const rule = "─".repeat(process.stdout.columns ?? 80);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{rule}</Text>
      <Box paddingX={1}>
        <Mascot color={p.accent} />
        <Box flexDirection="column">
          <Text><Text color={p.accent} bold>◆ Relay · 接力</Text><Text dimColor>  multi-agent · full-duplex</Text></Text>
          <Text dimColor>model:     <Text color={p.text}>{model}</Text>   <Text color={p.accent}>/model</Text> to change</Text>
          <Text dimColor>directory: {cwd}</Text>
          <Text dimColor>commands:  <Text color={p.accent}>Enter</Text> open · <Text color={p.accent}>Ctrl+G</Text> agents · <Text color={p.accent}>/command</Text> · <Text color={p.accent}>Shift+Tab</Text> thinking · <Text color={p.accent}>Ctrl+L</Text> models</Text>
        </Box>
      </Box>
      <Text dimColor>{rule}</Text>
    </Box>
  );
}
