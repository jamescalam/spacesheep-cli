"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseClaude } = require("../lib/memory");

test("Claude compaction in the middle of a turn keeps the real prompt and both replies", () => {
  const lines = [
    { type: "user", timestamp: "2026-10-20T10:00:00Z",
      message: { role: "user", content: "Check why the build fails." } },
    { type: "assistant", timestamp: "2026-10-20T10:00:01Z",
      message: { role: "assistant", content: [{ type: "text", text: "I'll inspect the build configuration." }] } },
    { type: "assistant", timestamp: "2026-10-20T10:00:02Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "read-config", name: "Read", input: { file_path: "/project/package.json" } }] } },
    { type: "system", subtype: "compact_boundary", timestamp: "2026-10-20T10:00:03Z" },
    { type: "user", timestamp: "2026-10-20T10:00:04Z", isCompactSummary: true, isVisibleInTranscriptOnly: true,
      message: { role: "user", content: "This session is being continued from a previous conversation. The user asked why the build fails." } },
    { type: "assistant", timestamp: "2026-10-20T10:00:05Z",
      message: { role: "assistant", content: [{ type: "text", text: "The build script points to a missing file." }] } },
  ].map((record) => JSON.stringify(record)).concat("");

  const parsed = parseClaude(lines, 0);
  assert.equal(parsed.turns.length, 1);
  assert.deepEqual(parsed.turns[0], {
    user: "Check why the build fails.",
    assistant: "I'll inspect the build configuration.\n\nThe build script points to a missing file.",
    at: Date.parse("2026-10-20T10:00:00Z"),
    endLine: 5,
  });
  assert.equal(parsed.line, 6);
});
