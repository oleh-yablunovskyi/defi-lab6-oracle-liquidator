// Creates a new random wallet for the liquidator bot and saves its private key as BOT_PRIVATE_KEY
// in .env, or in the file named by ENV_FILE. A key that is already there is never replaced,
// because that wallet may hold funds. Only the address is printed.
//   npm run new-bot-wallet
//   ENV_FILE=.env.fork npm run new-bot-wallet
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";

const envFile = resolve(import.meta.dirname, "..", process.env.ENV_FILE || ".env");
const text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
const existing = /^BOT_PRIVATE_KEY=(.+)$/m.exec(text);
if (existing) {
  throw new Error(`${envFile} already has BOT_PRIVATE_KEY, the wallet ${new Wallet(existing[1].trim()).address}`);
}

const wallet = Wallet.createRandom();
const line = `BOT_PRIVATE_KEY=${wallet.privateKey}`;
// fill the empty BOT_PRIVATE_KEY= line copied from .env.example, or add the line at the end
const updated = /^BOT_PRIVATE_KEY=$/m.test(text)
  ? text.replace(/^BOT_PRIVATE_KEY=$/m, line)
  : `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
writeFileSync(envFile, updated, { mode: 0o600 });
console.log(`New bot wallet ${wallet.address}`);
console.log(`Its private key is saved to ${envFile} as BOT_PRIVATE_KEY`);
