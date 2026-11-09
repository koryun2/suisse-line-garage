import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function smsConfigured() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = process.env;
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM);
}

async function writeOutbox(to, text, result) {
  const dir = path.join(process.env.DATA_DIR, "sms-outbox");
  await mkdir(dir, { recursive: true });
  const name = new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  await writeFile(path.join(dir, name), JSON.stringify({ to, text, ...result }, null, 2));
}

export async function sendSms(to, text) {
  if (!to) return { status: "skipped", error: "no phone number" };
  if (!smsConfigured()) {
    const result = { status: "dry-run" };
    await writeOutbox(to, text, result);
    return result;
  }

  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: text }),
    });
    const data = await r.json();
    const result = r.ok ? { status: "sent", id: data.sid } : { status: "failed", error: data.message };
    await writeOutbox(to, text, result);
    return result;
  } catch (err) {
    const result = { status: "failed", error: err.message };
    await writeOutbox(to, text, result);
    return result;
  }
}
