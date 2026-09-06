export { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
export { TerminalStack } from "./TerminalStack";
export {
  type TerminalAppearance,
  type TerminalAppearanceOverride,
  pruneAppearance,
  resolveAppearance,
} from "./lib/appearanceOverride";
export type { PtySession } from "./lib/pty-bridge";
export { useTerminalFont } from "./lib/useTerminalFont";
export {
  registerRemoteOpener,
  clearFocusedTerminal,
  disposeSession,
  leafHasForegroundProcess,
  leafIdForPty,
  navigateFocusedBlocks,
  ptyIdForLeaf,
  respawnSession,
  whenSessionReady,
  writeToSession,
} from "./lib/useTerminalSession";
export {
  type AgentTabStatus,
  tabAgentStatus,
  useAgentActivityStore,
} from "./lib/agentActivity";
export {
  type TerminalPathDropTarget,
  useTerminalFileDrop,
} from "./lib/useTerminalFileDrop";
export {
  findLeafCwd,
  hasLeaf,
  isLeaf,
  leafIds,
  type PaneBounds,
  type PaneId,
  type PaneNode,
  type SplitDir,
} from "./lib/panes";
export type { TerminalBackground } from "./lib/terminalBackground";
