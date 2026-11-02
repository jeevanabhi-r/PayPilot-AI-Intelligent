
const fs = require("fs");
const dotenv = require("dotenv");

const file = ".env";
const raw = fs.readFileSync(file, "utf8");
const parsed = dotenv.parse(raw);

const key = parsed.FIREBASE_PRIVATE_KEY;

if (!key || !key.includes("-----BEGIN PRIVATE KEY-----")) {
  throw new Error("Firebase private key is missing or invalid.");
}

const fixed = key.replace(/\r\n|\n|\r/g, "\\n");

const lines = raw.split(/\r?\n/);
const index = lines.findIndex(line =>
  line.startsWith("FIREBASE_PRIVATE_KEY=")
);

if (index === -1) {
  throw new Error("FIREBASE_PRIVATE_KEY entry not found.");
}

lines[index] = 'FIREBASE_PRIVATE_KEY="' + fixed + '"';

fs.writeFileSync(file, lines.join("\n") + "\n");

console.log("Firebase private key formatting corrected.");
