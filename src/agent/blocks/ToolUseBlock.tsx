import type { ToolResultBlockData, ToolUseBlockData } from "../types";
import { ExecToolBlock } from "./ExecToolBlock";
import { FileToolBlock } from "./FileToolBlock";
import { GenericToolBlock } from "./GenericToolBlock";
import { SearchToolBlock } from "./SearchToolBlock";
import { WebToolBlock } from "./WebToolBlock";
import { TaskToolBlock } from "./TaskToolBlock";
import { getToolFamily } from "./getToolFamily";
import { isTaskTool } from "../subagentSelectors";

interface ToolUseBlockProps {
  block: ToolUseBlockData;
  result: ToolResultBlockData | undefined;
}

/**
 * Thin router. Dispatches to one of several family-specific renderers
 * based on the tool name. See playbook §5 and `getToolFamily.ts`.
 *
 * The subagent-spawning tools (`Task`, `agent`, `agent_dispatch`) get
 * their own family-style renderer that surfaces the agent's reply
 * cleanly and folds away the agentId / usage noise.
 */
export function ToolUseBlock({ block, result }: ToolUseBlockProps) {
  if (isTaskTool(block.name)) {
    return <TaskToolBlock block={block} result={result} />;
  }
  const family = getToolFamily(block.name);
  switch (family) {
    case "file":
      return <FileToolBlock block={block} result={result} />;
    case "exec":
      return <ExecToolBlock block={block} result={result} />;
    case "search":
      return <SearchToolBlock block={block} result={result} />;
    case "web":
      return <WebToolBlock block={block} result={result} />;
    case "generic":
    default:
      return <GenericToolBlock block={block} result={result} />;
  }
}
