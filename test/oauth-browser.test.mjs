import assert from "node:assert/strict";
import test from "node:test";
import { browserCommand } from "../lib/browser-command.js";

test("browserCommand preserves the Windows OAuth URL as one argument without a shell", () => {
  const url = "https://example.com/authorize?response_type=code&client_id=dsh-mcp&state=abc123";
  assert.deepEqual(browserCommand(url, "win32"), [
    "rundll32.exe", ["url.dll,FileProtocolHandler", url],
  ]);
});

test("browserCommand keeps the macOS and Linux openers unchanged", () => {
  const url = "https://example.com/authorize?response_type=code&state=abc123";
  assert.deepEqual(browserCommand(url, "darwin"), ["open", [url]]);
  assert.deepEqual(browserCommand(url, "linux"), ["xdg-open", [url]]);
});
