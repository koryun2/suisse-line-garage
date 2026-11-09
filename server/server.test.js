import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "garage-"));
process.env.TOOL_TOKEN = "t0k";
process.env.BOARD_PASSWORD = "pw";
process.env.LOG_PAYLOADS = "0";

const { createServer, normalizePlate, normalizePhone, extractLookup } = await import("./server.js");

const server = createServer().listen(0);
const base = `http://localhost:${server.address().port}`;
const auth = { Authorization: "Basic " + Buffer.from("x:pw").toString("base64") };

const tool = (body, q = "token=t0k") =>
  fetch(`${base}/tools/repair-status?${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test.after(() => server.close());

test("normalises plates and Swiss phone numbers", () => {
  assert.equal(normalizePlate("zh 123-456"), "ZH123456");
  assert.equal(normalizePhone("079 111 22 33"), "+41791112233");
  assert.equal(normalizePhone("0041 79 111 22 33"), "+41791112233");
});

test("finds the plate wherever the platform nests it", () => {
  assert.equal(extractLookup({ parameters: { license_plate: "ZH 1" } }).plate, "ZH1");
  assert.equal(extractLookup({ data: { args: { plate: "ag 2" } } }).plate, "AG2");
});

test("rejects calls without the token", async () => {
  const r = await tool({ license_plate: "ZH 123456" }, "token=wrong");
  assert.equal(r.status, 401);
});

test("answers by plate", async () => {
  const r = await (await tool({ parameters: { license_plate: "zh123456" } })).json();
  assert.equal(r.found, true);
  assert.equal(r.status, "in_repair");
  assert.match(r.message, /Brake pads/);
  assert.match(r.message, /Expected ready/);
});

test("includes the quote when approval is needed", async () => {
  const r = await (await tool({ license_plate: "AG 45789" })).json();
  assert.equal(r.status, "waiting_approval");
  assert.match(r.message, /CHF 860/);
});

test("falls back to the caller's phone number", async () => {
  const r = await (await tool({ call: { from_number: "078 777 88 99" } })).json();
  assert.equal(r.found, true);
  assert.equal(r.status, "ready");
});

test("unknown plate gives a safe answer instead of guessing", async () => {
  const r = await (await tool({ license_plate: "BE 000" })).json();
  assert.equal(r.found, false);
  assert.match(r.message, /No car/);
});

test("board requires a password", async () => {
  assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
});

test("status change on the board is what the caller hears", async () => {
  const { jobs } = await (await fetch(`${base}/api/jobs`, { headers: auth })).json();
  const golf = jobs.find((j) => j.plate === "ZH 123456");
  const patch = await fetch(`${base}/api/jobs/${golf.id}`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "ready" }),
  });
  assert.equal(patch.status, 200);
  const r = await (await tool({ license_plate: "ZH 123456" })).json();
  assert.equal(r.status, "ready");
  assert.match(r.message, /ready for pickup/);
});
