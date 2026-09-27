import type { TextBlockData } from "../types";
import { MarkdownBody } from "./MarkdownBody";

interface TextBlockProps {
  block: TextBlockData;
  /**
   * Vestigial prop, kept on the surface so existing callers + tests
   * keep compiling.  The streaming "cursor" element was retired in
   * 1.2.2 — the WorkingFootline + MarginDraft now carry the "agent
   * is still writing" signal, and the growing text itself is the
   * proof of streaming.  See
   * `docs/design/agent-working-experience.html`.
   */
  isStreamingTail?: boolean;
}

/**
 * Assistant text block — full GFM markdown via <MarkdownBody>.
 * Tables, lists, headings, code fences (highlighted), inline code,
 * links, mermaid diagrams.
 */
export function TextBlock({ block }: TextBlockProps) {
  return (
    <div className="agent-text-block">
      <MarkdownBody source={block.text} />
    </div>
  );
}
