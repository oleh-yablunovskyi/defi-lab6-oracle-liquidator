// Off-chain liquidator agent (section 6.4 of the lab text): the C#/Nethereum example of the lab
// text ported to TypeScript and ethers v6. It works with any JSON-RPC node: Sepolia, or a local
// Hardhat node.
// - Every POLL_INTERVAL_SECONDS (12 s by default, the average block time of Ethereum) it reads
//   the health factor of every monitored debtor with eth_call, which costs no gas.
// - When a health factor is below 1.0 it sends liquidate(debtor) from the bot wallet (the gas
//   limit and the fees are estimated by the node), waits for the receipt and prints the block
//   number and the transaction hash.
// - A failed check or a reverted liquidation is printed and the bot keeps polling. It stops
//   watching a position it has liquidated and exits when no position is left.
// The settings come from .env, or from the file named by ENV_FILE (see .env.example):
//   npm run bot
//   ENV_FILE=.env.fork npm run bot
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, Interface, JsonRpcProvider, MaxUint256, Wallet, formatEther, formatUnits, getAddress } from "ethers";
import type { TransactionReceipt } from "ethers";

const envFile = resolve(import.meta.dirname, "..", process.env.ENV_FILE || ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; add it to ${envFile} (see .env.example)`);
  return value;
}

const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || 12);
const ENGINE_ADDRESS = getAddress(setting("ENGINE_ADDRESS"));
// One or more debtors separated by commas, like the usersToMonitor array of the C# example
const DEBTORS = setting("DEBTOR_ADDRESS").split(",").map((address) => getAddress(address.trim()));
const SEPOLIA_CHAIN_ID = 11155111n;
const ONE = 10n ** 18n; // health factor 1.0 with 18 decimals

// Simplified ABIs with only the functions the bot needs (human-readable form of ethers).
// The custom error of the ERC-20 token lets ethers decode the revert when the bot has too
// little sUSD to repay the debt.
const ENGINE_ABI = [
  "function getHealthFactor(address user) view returns (uint256)",
  "function liquidate(address user)",
  "function collateralDeposited(address user) view returns (uint256)",
  "function sUsdMinted(address user) view returns (uint256)",
  "function getUsdValue(uint256 ethAmount) view returns (uint256)",
  "function priceFeed() view returns (address)",
  "function sUsd() view returns (address)",
  "event Liquidated(address indexed user, address indexed liquidator, uint256 debtCovered)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
];
const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];
const COIN_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function symbol() view returns (string)",
];

const time = (seconds?: bigint) =>
  (seconds === undefined ? new Date() : new Date(Number(seconds) * 1000)).toTimeString().slice(0, 8);
const log = (message: string) => console.log(`[${time()}] ${message}`);
const sleep = (seconds: number) => new Promise((done) => setTimeout(done, seconds * 1000));
// how much more `value` is than `debt`, in percent rounded to two decimals
const premium = (debt: bigint, value: bigint) => `${formatUnits(((value - debt) * 10000n + debt / 2n) / debt, 2)}%`;

// A read at a given block. A public endpoint balances requests over several nodes, and the one
// that answers may not have the block of a fresh receipt yet, so a failed read is retried.
async function atBlock<T>(read: (blockTag: number) => Promise<T>, blockTag: number): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read(blockTag);
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(2);
    }
  }
}

// The reason of a reverted call: the require message, a custom error, or the RPC error. ethers
// decodes only the standard Error(string) when a transaction fails in the gas estimation, so a
// custom error is decoded from the revert data with the ABI above.
const engineInterface = new Interface(ENGINE_ABI);
function reason(error: unknown): string {
  const { revert, data, shortMessage, message } = error as {
    revert?: { name: string; args: unknown[] };
    data?: unknown;
    shortMessage?: string;
    message?: string;
  };
  const parsed = revert ?? (typeof data === "string" && data.length >= 10 ? engineInterface.parseError(data) : null);
  if (parsed?.name === "Error") return `revert "${parsed.args[0]}"`;
  if (parsed) return `revert ${parsed.name}(${parsed.args.join(", ")})`;
  return shortMessage ?? message ?? String(error);
}

// 1. The bot wallet and the connection to the RPC node. The private key never leaves this
//    process: ethers signs the transactions locally and sends them with eth_sendRawTransaction.
const probe = await fetch(RPC_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
});
const chainId = BigInt(((await probe.json()) as { result: string }).result);
// cacheTimeout -1: no reuse of a recent identical read, every poll asks the node again
const provider = new JsonRpcProvider(RPC_URL, chainId, { staticNetwork: true, cacheTimeout: -1 });
const wallet = new Wallet(setting("BOT_PRIVATE_KEY"), provider);
if ((await provider.getCode(ENGINE_ADDRESS)) === "0x") throw new Error(`No contract at ${ENGINE_ADDRESS}`);
const engine = new Contract(ENGINE_ADDRESS, ENGINE_ABI, wallet);
const feed = new Contract(await engine.priceFeed(), FEED_ABI, provider);
const coin = new Contract(await engine.sUsd(), COIN_ABI, provider);
const symbol: string = await coin.symbol();
const feedDecimals: bigint = await feed.decimals();
const explorer = chainId === SEPOLIA_CHAIN_ID ? "https://sepolia.etherscan.io/tx/" : undefined;

console.log("Запуск бота-ліквідатора. Очікування зміни ціни...");
console.log(`  RPC:           ${RPC_URL} (chain id ${chainId})`);
console.log(`  StableEngine:  ${ENGINE_ADDRESS}`);
console.log(`  Оракул:        ${await feed.getAddress()} (${await feed.description()}, ${feedDecimals} знаків)`);
console.log(`  Гаманець бота: ${wallet.address}`);
console.log(`                 ${formatEther(await provider.getBalance(wallet))} ETH, ${formatEther(await coin.balanceOf(wallet))} ${symbol}`);
console.log(`  Боржники:      ${DEBTORS.join(", ")}`);
console.log(`  Інтервал:      ${POLL_INTERVAL_SECONDS} с`);

// 2. liquidate(debtor): the transaction and its receipt. The node estimates the gas first, so a
//    liquidation that would revert is not sent at all; a mined but reverted one throws in wait().
async function liquidate(debtor: string): Promise<TransactionReceipt> {
  const tx = await engine.liquidate(debtor);
  log(`Транзакцію надіслано: ${tx.hash}, очікування квитанції...`);
  const receipt = (await tx.wait()) as TransactionReceipt;
  log(`[УСПІХ] Позицію ліквідовано у блоці ${receipt.blockNumber}. Tx: ${receipt.hash}`);
  if (explorer) log(`        ${explorer}${receipt.hash}`);
  return receipt;
}

// 3. What the liquidation changed: the state at its block against the state one block earlier
async function printResult(debtor: string, receipt: TransactionReceipt) {
  const event = receipt.logs.map((entry) => engine.interface.parseLog(entry)).find((parsed) => parsed?.name === "Liquidated");
  const debtCovered: bigint = event!.args.debtCovered;
  const block = receipt.blockNumber;
  const collateralAt = (blockTag: number): Promise<bigint> => engine.collateralDeposited(debtor, { blockTag });
  const balanceAt = (blockTag: number) => provider.getBalance(wallet, blockTag);
  const collateralTaken = (await atBlock(collateralAt, block - 1)) - (await atBlock(collateralAt, block));
  const ethGained = (await atBlock(balanceAt, block)) - (await atBlock(balanceAt, block - 1));
  const usdAt = (amount: bigint) => (blockTag: number): Promise<bigint> => engine.getUsdValue(amount, { blockTag });
  const takenUsd = await atBlock(usdAt(collateralTaken), block);
  const feeUsd = await atBlock(usdAt(receipt.fee), block);
  log(`        газ ${receipt.gasUsed}, комісія ${formatEther(receipt.fee)} ETH ` +
    `(${formatUnits(receipt.gasPrice, "gwei")} gwei) = ${formatEther(feeUsd)} USD`);
  log(`        спалено ${formatEther(debtCovered)} ${symbol} бота, отримано застави ${formatEther(collateralTaken)} ETH ` +
    `= ${formatEther(takenUsd)} USD`);
  log(`        бонус ${formatEther(takenUsd - debtCovered)} USD (${premium(debtCovered, takenUsd)} від боргу), ` +
    `після газу ${formatEther(takenUsd - debtCovered - feeUsd)} USD`);
  const coinsLeft: bigint = await atBlock((blockTag) => coin.balanceOf(wallet, { blockTag }), block);
  log(`        баланс бота змінився на ${formatEther(ethGained)} ETH (застава мінус комісія), ` +
    `залишилось ${formatEther(coinsLeft)} ${symbol}`);
  const debtLeft: bigint = await atBlock((blockTag) => engine.sUsdMinted(debtor, { blockTag }), block);
  log(`        боржнику залишилось застави ${formatEther(await atBlock(collateralAt, block))} ETH, ` +
    `борг ${formatEther(debtLeft)} ${symbol}`);
}

// 4. The monitoring loop
const watched = new Set(DEBTORS);
while (watched.size > 0) {
  try {
    const [, answer, , updatedAt] = await feed.latestRoundData();
    log(`Блок ${await provider.getBlockNumber()} | ETH/USD ${formatUnits(answer, feedDecimals)} (оновлено ${time(updatedAt)})`);
  } catch (error) {
    log(`Помилка читання оракула: ${reason(error)}`);
  }
  for (const debtor of watched) {
    try {
      // reading the state (a view function) costs no gas
      const healthFactor: bigint = await engine.getHealthFactor(debtor);
      log(`Позиція ${debtor} | HF: ${healthFactor === MaxUint256 ? "max (немає боргу)" : formatEther(healthFactor)}`);

      if (healthFactor < ONE) {
        log(`[УВАГА] Виявлено неплатоспроможну позицію ${debtor}! Ініціалізація ліквідації...`);
        const receipt = await liquidate(debtor);
        watched.delete(debtor);
        await printResult(debtor, receipt).catch((error) => log(`Не вдалося прочитати результат: ${reason(error)}`));
      }
    } catch (error) {
      log(`Помилка перевірки позиції ${debtor}: ${reason(error)}`);
    }
  }
  if (watched.size > 0) await sleep(POLL_INTERVAL_SECONDS);
}
log("Усі позиції зі списку ліквідовано, бот завершує роботу.");
