/**
 * `slashReceiptForMessage` — turn an "empty" assistant turn into a
 * meaningful confirmation card when the user's preceding turn was a
 * recognised slash command (`/compact`, `/clear`, `/init`, `/review`).
 *
 * Background: claude `--print --input-format stream-json` accepts
 * these slash commands but emits an assistant turn whose only text
 * block is the literal string `"(no content)"` — there's no normal
 * conversational reply because the command's side-effect happens
 * internally (compacting state, clearing history, …).  Rendering
 * that raw "(no content)" text reads as a broken response.  This
 * selector recognises the pattern and returns a structured
 * `SlashReceipt` that the MessageRow can render as a small "✓ Compacted"
 * card instead.
 */
import { describe, it, expect } from "vitest";
import {
  isSlashReceiptCommand,
  isEmptyAssistantBlocks,
  slashReceiptForMessage,
  slashReceiptAfterUserMessage,
} from "../agent/slashReceiptSelector";
import type { RenderedMessage } from "../agent/messageStore";

function userMessage(text: string): RenderedMessage {
  return {
    id: `user-${text}`,
    role: "user",
    blocks: [{ type: "text", text }],
    timestamp: 0,
  };
}

function assistantMessage(text: string | null): RenderedMessage {
  return {
    id: `assistant-${text ?? "empty"}`,
    role: "assistant",
    blocks: text === null ? [] : [{ type: "text", text }],
    timestamp: 0,
  };
}

describe("isSlashReceiptCommand", () => {
  it("recognises the SDK-native slash commands", () => {
    expect(isSlashReceiptCommand("/compact")).toBe("compact");
    expect(isSlashReceiptCommand("/clear")).toBe("clear");
    expect(isSlashReceiptCommand("/init")).toBe("init");
    expect(isSlashReceiptCommand("/review")).toBe("review");
  });

  it("normalises case and ignores surrounding whitespace", () => {
    expect(isSlashReceiptCommand("  /COMPACT  ")).toBe("compact");
    expect(isSlashReceiptCommand("\t/Clear")).toBe("clear");
  });

  it("returns null for plain prose", () => {
    expect(isSlashReceiptCommand("hello")).toBeNull();
    expect(isSlashReceiptCommand("can you /compact this?")).toBeNull();
  });

  it("returns null for slash commands not in the receipt set", () => {
    expect(isSlashReceiptCommand("/mcp")).toBeNull();
    expect(isSlashReceiptCommand("/agents")).toBeNull();
    expect(isSlashReceiptCommand("/help")).toBeNull();
  });

  it("returns null when the slash command carries additional arguments", () => {
    // `/compact some preamble` is no longer a bare command — the
    // user wrote prose alongside, so we shouldn't suppress the reply.
    expect(isSlashReceiptCommand("/compact please")).toBeNull();
    expect(isSlashReceiptCommand("/clear and then say hi")).toBeNull();
  });
});

describe("isEmptyAssistantBlocks", () => {
  it("true for zero blocks", () => {
    expect(isEmptyAssistantBlocks([])).toBe(true);
  });

  it("true for only-whitespace text blocks", () => {
    expect(isEmptyAssistantBlocks([{ type: "text", text: "   \n\t  " }])).toBe(true);
  });

  it("true for the literal `(no content)` placeholder Claude emits", () => {
    expect(isEmptyAssistantBlocks([{ type: "text", text: "(no content)" }])).toBe(true);
    expect(
      isEmptyAssistantBlocks([{ type: "text", text: "  (no content)\n" }]),
    ).toBe(true);
  });

  it("false when there's any real text", () => {
    expect(isEmptyAssistantBlocks([{ type: "text", text: "hello there" }])).toBe(false);
  });

  it("false when there's a tool_use block (the turn did real work)", () => {
    expect(
      isEmptyAssistantBlocks([
        { type: "tool_use", id: "t", name: "Read", input: {} },
      ]),
    ).toBe(false);
  });

  it("false when there's a thinking block with actual content", () => {
    expect(
      isEmptyAssistantBlocks([{ type: "thinking", thinking: "hmm" }]),
    ).toBe(false);
  });
});

describe("slashReceiptForMessage", () => {
  it("returns a compact receipt when /compact → empty assistant", () => {
    const receipt = slashReceiptForMessage(
      assistantMessage("(no content)"),
      userMessage("/compact"),
    );
    expect(receipt).not.toBeNull();
    expect(receipt!.command).toBe("compact");
    expect(receipt!.label).toMatch(/compact/i);
  });

  it("returns a clear receipt when /clear → empty assistant", () => {
    const receipt = slashReceiptForMessage(
      assistantMessage("(no content)"),
      userMessage("/clear"),
    );
    expect(receipt).not.toBeNull();
    expect(receipt!.command).toBe("clear");
    expect(receipt!.label).toMatch(/clear/i);
  });

  it("returns null when the assistant message has real content", () => {
    expect(
      slashReceiptForMessage(
        assistantMessage("Sure — here's the summary."),
        userMessage("/compact"),
      ),
    ).toBeNull();
  });

  it("returns null when the prior message was prose, not a receipt verb", () => {
    expect(
      slashReceiptForMessage(
        assistantMessage("(no content)"),
        userMessage("hi"),
      ),
    ).toBeNull();
  });

  it("returns null when the prior message was a non-receipt slash command", () => {
    // `/mcp` opens a TUI in a separate path — even if it WERE
    // somehow followed by an empty assistant turn (it isn't, in
    // practice), we don't want to claim it "succeeded as compact".
    expect(
      slashReceiptForMessage(
        assistantMessage("(no content)"),
        userMessage("/mcp"),
      ),
    ).toBeNull();
  });

  it("returns null when there is no preceding message at all", () => {
    expect(
      slashReceiptForMessage(assistantMessage("(no content)"), null),
    ).toBeNull();
  });

  it("returns null when the assistant message is on a non-assistant role", () => {
    // Defensive: never paint a receipt on a user message.
    expect(
      slashReceiptForMessage(
        userMessage("(no content)"),
        userMessage("/compact"),
      ),
    ).toBeNull();
  });
});

/* ─── No-reply receipts (the /compact case) ────────────────────────
 *
 * `/clear` over stream-json emits an assistant message containing the
 * literal "(no content)" placeholder — that path is covered above.
 * `/compact` is different: empirically it emits NO assistant message
 * at all, only a `result` event.  The "replace empty assistant"
 * detector therefore never fires for /compact, and the user is left
 * staring at their /compact prompt with nothing to acknowledge that
 * the command worked.
 *
 * `slashReceiptAfterUserMessage` is the second path: for a
 * receipt-verb user message that has NO assistant reply in the next
 * slot (the next message is another user message, or there is no
 * next message), return a synthesized receipt to render right after.
 */
describe("slashReceiptAfterUserMessage", () => {
  it("returns a receipt when /compact has NO assistant reply (next is another user)", () => {
    const r = slashReceiptAfterUserMessage(userMessage("/compact"), userMessage("/clear"));
    expect(r).not.toBeNull();
    expect(r!.command).toBe("compact");
  });

  it("returns a receipt when /compact has no following message at all", () => {
    const r = slashReceiptAfterUserMessage(userMessage("/compact"), null);
    expect(r).not.toBeNull();
    expect(r!.command).toBe("compact");
  });

  it("returns null when /compact IS followed by an assistant message (the receipt-replace path handles it)", () => {
    // If an assistant turn lands — empty or real — the post-receipt
    // logic must NOT also inject a duplicate card.  Whichever path
    // fires first wins.
    const r = slashReceiptAfterUserMessage(
      userMessage("/compact"),
      assistantMessage("(no content)"),
    );
    expect(r).toBeNull();
  });

  it("returns null when /compact got a real assistant reply", () => {
    const r = slashReceiptAfterUserMessage(
      userMessage("/compact"),
      assistantMessage("Conversation summarised in 4 bullets:\n• …"),
    );
    expect(r).toBeNull();
  });

  it("returns null for non-receipt user messages", () => {
    expect(
      slashReceiptAfterUserMessage(userMessage("hello"), null),
    ).toBeNull();
    expect(
      slashReceiptAfterUserMessage(userMessage("/mcp"), null),
    ).toBeNull();
  });

  it("returns null when the message is on a non-user role (defensive)", () => {
    expect(
      slashReceiptAfterUserMessage(
        assistantMessage("/compact"),
        userMessage("ping"),
      ),
    ).toBeNull();
  });

  it("works for all four receipt verbs", () => {
    for (const verb of ["compact", "clear", "init", "review"] as const) {
      const r = slashReceiptAfterUserMessage(userMessage(`/${verb}`), null);
      expect(r).not.toBeNull();
      expect(r!.command).toBe(verb);
    }
  });
});
