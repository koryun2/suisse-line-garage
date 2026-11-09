import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const LOG_DIR = path.join(DATA_DIR, "webhook-log");
const PORT = Number(process.env.PORT || 8787);
const TOOL_TOKEN = process.env.TOOL_TOKEN || "dev-token";
const BOARD_PASSWORD = process.env.BOARD_PASSWORD || "garage";
const LOG_PAYLOADS = process.env.LOG_PAYLOADS !== "0";

export const STATUSES = {
  received: "The car has arrived and is waiting for a mechanic.",
  diagnosing: "A mechanic is checking the car to find the problem.",
  waiting_approval: "We have a quote ready and need the customer's OK before we continue.",
  waiting_parts: "We are waiting for parts to arrive.",
  in_repair: "The repair is in progress.",
  ready: "The car is ready for pickup.",
  picked_up: "The car has already been picked up.",
};

export function normalizePlate(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizePhone(value) {
  let digits = String(value || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = "+" + digits.slice(2);
  if (digits.startsWith("0") && !digits.startsWith("00")) digits = "+41" + digits.slice(1);
  return digits;
}

function findKeyDeep(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k.toLowerCase()) && (typeof v === "string" || typeof v === "number") && String(v).trim()) {
      return String(v);
    }
  }
  for (const v of Object.values(obj)) {
    const hit = findKeyDeep(v, keys, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const PLATE_KEYS = ["license_plate", "licence_plate", "plate", "kennzeichen", "registration"];
const PHONE_KEYS = ["caller_phone", "from_number", "caller_number", "from", "caller", "phone_number", "customer_phone"];

export function extractLookup(body, query = {}) {
  const plate = query.license_plate || findKeyDeep(body, PLATE_KEYS);
  const phone = query.caller_phone || findKeyDeep(body, PHONE_KEYS);
  return { plate: normalizePlate(plate), phone: normalizePhone(phone) };
}

function formatWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-GB", {
    timeZone: "Europe/Zurich",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function answerFor(jobs, { plate, phone }) {
  const open = jobs.filter((j) => j.status !== "picked_up");
  let matches = [];
  if (plate) matches = jobs.filter((j) => normalizePlate(j.plate) === plate);
  if (!matches.length && phone) matches = open.filter((j) => j.phone && normalizePhone(j.phone) === phone);

  if (!matches.length) {
    return {
      found: false,
      message: plate
        ? `No car with plate ${plate} is in the workshop. Ask the caller to repeat the plate, or offer a callback from the workshop.`
        : "No car is linked to this caller's number. Ask the caller for the licence plate.",
    };
  }

  const job = matches.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
  const parts = [`${job.car || "The car"} (plate ${job.plate}): ${STATUSES[job.status] || job.status}`];
  const eta = formatWhen(job.readyAt);
  if (eta && job.status !== "ready" && job.status !== "picked_up") parts.push(`Expected ready: ${eta}.`);
  if (job.status === "waiting_approval" && job.quoteChf) parts.push(`Quote: CHF ${job.quoteChf}.`);
  if (job.note) parts.push(`Note for the customer: ${job.note}`);
  if (job.status === "ready") parts.push("Pickup during opening hours; payment by card or TWINT at the desk.");

  return {
    found: true,
    plate: job.plate,
    car: job.car || null,
    status: job.status,
    ready_at: job.readyAt || null,
    quote_chf: job.quoteChf || null,
    message: parts.join(" "),
  };
}

async function loadJobs() {
  if (!existsSync(JOBS_FILE)) {
    await mkdir(DATA_DIR, { recursive: true });
    const seed = JSON.parse(await readFile(path.join(here, "seed-jobs.json"), "utf8"));
    await writeFile(JOBS_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  return JSON.parse(await readFile(JOBS_FILE, "utf8"));
}

async function saveJobs(jobs) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

async function logPayload(body) {
  if (!LOG_PAYLOADS) return;
  await mkdir(LOG_DIR, { recursive: true });
  const name = new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  await writeFile(path.join(LOG_DIR, name), JSON.stringify(body, null, 2));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error("too large"));
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function boardAuthorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const [, pass] = Buffer.from(header.slice(6), "base64").toString().split(":");
  return safeEqual(pass || "", BOARD_PASSWORD);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const query = Object.fromEntries(url.searchParams);

      if (url.pathname === "/health") return send(res, 200, { ok: true });

      if (url.pathname === "/tools/repair-status") {
        if (!safeEqual(query.token || req.headers["x-tool-token"] || "", TOOL_TOKEN)) {
          return send(res, 401, { error: "unauthorized" });
        }
        const raw = req.method === "POST" ? await readBody(req) : "";
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = { raw };
        }
        await logPayload({ method: req.method, query: { ...query, token: undefined }, body });
        const result = answerFor(await loadJobs(), extractLookup(body, query));
        return send(res, 200, result);
      }

      if (url.pathname === "/" || url.pathname.startsWith("/api/jobs")) {
        if (!boardAuthorized(req)) {
          res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Workshop board"' });
          return res.end("Login required");
        }
      }

      if (url.pathname === "/" && req.method === "GET") {
        return send(res, 200, await readFile(path.join(here, "board.html"), "utf8"), "text/html");
      }

      if (url.pathname === "/api/jobs" && req.method === "GET") {
        return send(res, 200, { jobs: await loadJobs(), statuses: STATUSES });
      }

      if (url.pathname === "/api/jobs" && req.method === "POST") {
        const input = JSON.parse((await readBody(req)) || "{}");
        if (!normalizePlate(input.plate)) return send(res, 400, { error: "plate is required" });
        const jobs = await loadJobs();
        const job = {
          id: randomUUID(),
          plate: String(input.plate).toUpperCase().trim(),
          car: input.car || "",
          customer: input.customer || "",
          phone: input.phone || "",
          status: STATUSES[input.status] ? input.status : "received",
          readyAt: input.readyAt || "",
          quoteChf: input.quoteChf || "",
          note: input.note || "",
          updatedAt: new Date().toISOString(),
        };
        jobs.push(job);
        await saveJobs(jobs);
        return send(res, 201, job);
      }

      const match = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
      if (match && req.method === "PATCH") {
        const input = JSON.parse((await readBody(req)) || "{}");
        const jobs = await loadJobs();
        const job = jobs.find((j) => j.id === match[1]);
        if (!job) return send(res, 404, { error: "not found" });
        for (const k of ["car", "customer", "phone", "readyAt", "quoteChf", "note"]) {
          if (k in input) job[k] = input[k];
        }
        if ("plate" in input && normalizePlate(input.plate)) job.plate = String(input.plate).toUpperCase().trim();
        if (STATUSES[input.status]) job.status = input.status;
        job.updatedAt = new Date().toISOString();
        await saveJobs(jobs);
        return send(res, 200, job);
      }
      if (match && req.method === "DELETE") {
        const jobs = await loadJobs();
        await saveJobs(jobs.filter((j) => j.id !== match[1]));
        return send(res, 204, {});
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      console.error(err);
      send(res, 500, { error: "server error" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => {
    console.log(`Workshop board: http://localhost:${PORT}/  (password: BOARD_PASSWORD)`);
    console.log(`Tool webhook:   http://localhost:${PORT}/tools/repair-status?token=<TOOL_TOKEN>`);
  });
}
