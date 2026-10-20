// Control task, step 2: the debtor (the deployer, account #0) deposits ETH as collateral and
// mints the stablecoin up to a health factor of about 1.1 at the current oracle price.
// liquidate() burns the debt from the liquidator's own sUSD, so the minted coins are then sent
// to the bot wallet (the address of BOT_PRIVATE_KEY), together with 0.002 ETH for gas if the
// bot wallet has less than 0.001 ETH. The script only uses the address of that key.
//   npx hardhat run scripts/open-position.ts --network sepolia
//   ENV_FILE=.env.fork npx hardhat run scripts/open-position.ts --network localhost
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { network } from "hardhat";
import type { ContractTransactionResponse, TransactionReceipt, TransactionResponse } from "ethers";

const SEPOLIA_CHAIN_ID = 11155111n;
const TARGET_HEALTH_FACTOR = 110n; // 1.10, in hundredths
const BOT_MIN_BALANCE = "0.001"; // ETH
const BOT_FUNDING = "0.002"; // ETH

const { ethers, networkName } = await network.create();
const { formatEther, formatUnits, parseEther } = ethers;
const { chainId } = await ethers.provider.getNetwork();
const onSepolia = chainId === SEPOLIA_CHAIN_ID;

const file = `deployments/${networkName}.json`;
if (!existsSync(file)) throw new Error(`No ${file}, run scripts/deploy.ts first`);
const deployment = JSON.parse(await readFile(file, "utf8"));
if ((await ethers.provider.getCode(deployment.stableEngine)) === "0x") {
  throw new Error(`No StableEngine at ${deployment.stableEngine}, run scripts/deploy.ts first`);
}
const [debtor] = await ethers.getSigners();
if (debtor === undefined) throw new Error(`No account on ${networkName}: set DEPLOYER_PRIVATE_KEY in the env file`);
const coin = (await ethers.getContractAt("StableCoin", deployment.stableCoin)).connect(debtor);
const engine = (await ethers.getContractAt("StableEngine", deployment.stableEngine)).connect(debtor);
const symbol = await coin.symbol();
const ratio = await engine.COLLATERAL_RATIO();
// 0.01 ETH where the price is real (Sepolia and its fork), 2 ETH with the mock feed
const deposit = parseEther(deployment.priceFeedIsMock ? "2" : "0.01");

function printReceipt(label: string, receipt: TransactionReceipt) {
  deployment.transactions[label] = receipt.hash;
  console.log(`[Tx] ${label}: ${receipt.hash}`);
  console.log(`     block ${receipt.blockNumber}, status ${receipt.status}, gas used ${receipt.gasUsed}, ` +
    `fee ${formatEther(receipt.fee)} ETH at ${formatUnits(receipt.gasPrice, "gwei")} gwei`);
  if (onSepolia) console.log(`     https://sepolia.etherscan.io/tx/${receipt.hash}`);
}

async function send(label: string, response: Promise<ContractTransactionResponse | TransactionResponse>) {
  printReceipt(label, (await (await response).wait()) as TransactionReceipt);
}

async function position() {
  const collateral = await engine.collateralDeposited(debtor);
  const debt = await engine.sUsdMinted(debtor);
  const healthFactor = await engine.getHealthFactor(debtor);
  console.log(`[Position] collateral ${formatEther(collateral)} ETH = ${formatEther(await engine.getUsdValue(collateral))} USD`);
  console.log(`           debt ${formatEther(debt)} ${symbol}`);
  console.log(healthFactor === ethers.MaxUint256
    ? "           health factor: type(uint256).max (no debt)"
    : `           health factor: ${formatEther(healthFactor)} (${healthFactor})`);
}

console.log(`[Network] ${networkName}, chain id ${chainId}, block ${await ethers.provider.getBlockNumber()}`);
console.log(`[StableEngine] ${deployment.stableEngine}, coin ${await coin.name()} (${symbol}) ${deployment.stableCoin}`);
const feed = new ethers.Contract(await engine.priceFeed(), [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
], ethers.provider);
const [roundId, answer, , updatedAt] = await feed.latestRoundData();
console.log(`[Feed] ${await feed.getAddress()}${deployment.priceFeedIsMock ? " (mock)" : ""}: round ${roundId}, ` +
  `answer ${answer} = ${formatUnits(answer, await feed.decimals())} USD, updated ${new Date(Number(updatedAt) * 1000).toISOString()}`);
console.log(`       getUsdValue(1 ETH) = ${formatEther(await engine.getUsdValue(10n ** 18n))} USD`);
console.log(`[Debtor] ${debtor.address}, balance ${formatEther(await ethers.provider.getBalance(debtor))} ETH`);

// 1. Deposit of the collateral
console.log(`\n1. depositCollateral: ${formatEther(deposit)} ETH`);
await send("StableEngine.depositCollateral", engine.depositCollateral({ value: deposit }));
await position();

// 2. The mint. With the integer math of getHealthFactor
//      limit = getUsdValue(collateral) * 100 / COLLATERAL_RATIO   (the largest debt at HF 1.0)
//      HF    = limit * 1e18 / debt,
//    so the debt for HF 1.1 is limit / 1.1, rounded down, which keeps HF at 1.1 or a little above.
console.log("\n2. mintStablecoin: the amount that gives a health factor of 1.1");
const collateral = await engine.collateralDeposited(debtor);
const collateralUsd = await engine.getUsdValue(collateral);
const limit = (collateralUsd * 100n) / ratio;
const targetDebt = (limit * 100n) / TARGET_HEALTH_FACTOR;
const toMint = targetDebt - (await engine.sUsdMinted(debtor));
if (toMint <= 0n) throw new Error("The debt is already at a health factor of 1.1 or below");
console.log(`[Plan] getUsdValue(${formatEther(collateral)} ETH) = ${formatEther(collateralUsd)} USD`);
console.log(`       debt at HF 1.0: ${formatEther(collateralUsd)} * 100 / ${ratio} = ${formatEther(limit)} ${symbol}`);
console.log(`       debt at HF 1.1: ${formatEther(limit)} / 1.1 = ${formatEther(targetDebt)} ${symbol}`);
await send("StableEngine.mintStablecoin", engine.mintStablecoin(toMint));
await position();

// 3. The bot wallet gets the coins it needs to repay the debt, and some ETH for gas
const botKey = process.env.BOT_PRIVATE_KEY;
if (!botKey) {
  console.log(`\n3. No BOT_PRIVATE_KEY in the env file: the ${symbol} stay with the debtor`);
} else {
  const bot = ethers.computeAddress(botKey);
  console.log(`\n3. Bot wallet ${bot}`);
  const botBalance = await ethers.provider.getBalance(bot);
  console.log(`[Bot] balance ${formatEther(botBalance)} ETH, ${formatEther(await coin.balanceOf(bot))} ${symbol}`);
  if (botBalance < parseEther(BOT_MIN_BALANCE)) {
    await send(`send ${BOT_FUNDING} ETH to the bot`, debtor.sendTransaction({ to: bot, value: parseEther(BOT_FUNDING) }));
  }
  console.log(`[Bot] gets the minted ${formatEther(toMint)} ${symbol}`);
  await send("StableCoin.transfer to the bot", coin.transfer(bot, toMint));
  console.log(`[Bot] balance ${formatEther(await ethers.provider.getBalance(bot))} ETH, ${formatEther(await coin.balanceOf(bot))} ${symbol}`);
  deployment.bot = bot;
}
deployment.debtor = debtor.address;
await writeFile(file, JSON.stringify(deployment, null, 2) + "\n");

console.log(`\n[Debtor] balance ${formatEther(await ethers.provider.getBalance(debtor))} ETH, ${formatEther(await coin.balanceOf(debtor))} ${symbol}`);
console.log("Settings of the bot (bot/liquidator.ts) for the env file:");
console.log(`  ENGINE_ADDRESS=${deployment.stableEngine}`);
console.log(`  DEBTOR_ADDRESS=${debtor.address}`);
