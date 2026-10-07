import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../src/app/api/actions/route";

function request(origin: string, host: string) {
  // Next may normalize request.url to localhost while preserving the actual Host.
  return new Request("http://localhost:3000/api/actions", {
    method: "POST",
    headers: { origin, host, "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "send",
      sender: "alice@demo",
      receiver: "bob@demo",
      amount: "0.001",
    }),
  });
}
test("same-origin loopback requests reach validation despite normalized URL", async () => {
  const response = await POST(
    request("http://127.0.0.1:3000", "127.0.0.1:3000"),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /decimal places/);
});
test("cross-origin and malformed origins are blocked before actions", async () => {
  for (const origin of [
    "https://another-site.example",
    "null",
    "file://localhost:3000",
  ]) {
    assert.equal((await POST(request(origin, "127.0.0.1:3000"))).status, 403);
  }
});
