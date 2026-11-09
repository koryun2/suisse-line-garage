import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "garage-"));
process.env.TOOL_TOKEN = "t0k";
process.env.BOARD_PASSWORD = "pw";
process.env.LOG_PAYLOADS = "0";

delete process.env.TWILIO_ACCOUNT_SID;

const { createServer, normalizePlate, normalizePhone, extractLookup, smsForStatus } = await import("./server.js");

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
  assert.match(r.message, /no car/i);
});

test("board requires a password", async () => {
  assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
});

test("reads the plate from the Suisse Line tool.arguments envelope", async () => {
  const r = await (
    await tool({ event: "tool.invocation", phoneNumber: null, tool: { name: "repair_status", arguments: { license_plate: "ZH987654" } } })
  ).json();
  assert.equal(r.found, true);
  assert.equal(r.status, "ready");
});

test("an empty lookup tells Anna the tool works and to ask for the plate", async () => {
  const r = await (await tool({ event: "tool.invocation", phoneNumber: null, tool: { arguments: {} } })).json();
  assert.equal(r.found, false);
  assert.equal(r.tool_working, true);
  assert.match(r.message, /call repair_status again/);
});

test("booking SMS goes to the given number (test mode writes the outbox)", async () => {
  const r = await (
    await fetch(`${base}/tools/booking-sms?token=t0k`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: { arguments: { customer_phone: "079 555 66 77", service: "Small service", date_time: "Wednesday 11 November at 14:30", car: "VW Golf" } },
      }),
    })
  ).json();
  assert.equal(r.sent, true);
  const dir = path.join(process.env.DATA_DIR, "sms-outbox");
  const files = await readdir(dir);
  const last = JSON.parse(await readFile(path.join(dir, files.sort().at(-1)), "utf8"));
  assert.equal(last.to, "+41795556677");
  assert.match(last.text, /Small service, VW Golf on Wednesday 11 November at 14:30/);
});

test("booking SMS without a phone number asks Anna for one", async () => {
  const r = await (
    await fetch(`${base}/tools/booking-sms?token=t0k`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumber: null, tool: { arguments: { date_time: "Friday 10:00" } } }),
    })
  ).json();
  assert.equal(r.sent, false);
  assert.match(r.message, /mobile number/);
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
  const updated = await patch.json();
  assert.equal(updated.notifications.length, 1);
  assert.equal(updated.notifications[0].status, "dry-run");
  const r = await (await tool({ license_plate: "ZH 123456" })).json();
  assert.equal(r.status, "ready");
  assert.match(r.message, /ready for pickup/);
});

test("ready SMS is sent once, not again when other fields change", async () => {
  const { jobs } = await (await fetch(`${base}/api/jobs`, { headers: auth })).json();
  const golf = jobs.find((j) => j.plate === "ZH 123456");
  const again = await (
    await fetch(`${base}/api/jobs/${golf.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready", note: "Keys at the desk" }),
    })
  ).json();
  assert.equal(again.notifications.length, 1);
});

test("SMS texts fit in one or two SMS segments", () => {
  const ready = smsForStatus({ status: "ready", car: "Toyota Yaris Hybrid 2021", plate: "ZH 987654" });
  const quote = smsForStatus({ status: "waiting_approval", car: "Skoda Octavia 2020", plate: "AG 45789", quoteChf: "860" });
  assert.ok(ready.length <= 160, ready.length);
  assert.ok(quote.length <= 160, quote.length);
  assert.equal(smsForStatus({ status: "in_repair" }), null);
});
