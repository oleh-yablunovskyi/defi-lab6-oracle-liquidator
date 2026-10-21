// Control task, step 4: the Chainlink price cannot be changed on a testnet, so the lab-only
// backdoor reduceCollateralForTesting cuts the debtor's collateral in the registry until the
// health factor falls to about 0.9 at the current oracle price.
// liquidate() works for a health factor below 1.0 down to 1.1 / 1.5 = 0.7333: below that the
// collateral is worth less than the debt plus the 10% bonus, and liquidate() reverts with
// "Not enough collateral to liquidate". 0.9 leaves room for the price to move either way.
//   npx hardhat run scripts/break-position.ts --network sepolia
//   ENV_FILE=.env.fork npx hardhat run scripts/break-position.ts --network localhost
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { network } from "hardhat";
import type { TransactionReceipt } from "ethers";

const SEPOLIA_CHAIN_ID = 11155111n;
const TARGET_HEALTH_FACTOR = 90n; // 0.90, in hundredths
const ONE = 10n ** 18n;

const { ethers, networkName } = await network.create();
const { formatEther, formatUnits } = ethers;
const { chainId } = await ethers.provider.getNetwork();
const onSepolia = chainId === SEPOLIA_CHAIN_ID;
// On Sepolia the scripts wait for one more block after the block that includes a transaction:
// a public endpoint may balance requests over several nodes, and the reads that follow must not
// reach a node that has not seen the transaction yet. A local node mines only on demand, so
// there a single block is all there is.
const CONFIRMATIONS = onSepolia ? 2 : 1;

const file = `deployments/${networkName}.json`;
if (!existsSync(file)) throw new Error(`No ${file}, run scripts/deploy.ts first`);
const deployment = JSON.parse(await readFile(file, "utf8"));
if (deployment.debtor === undefined) throw new Error("No position yet, run scripts/open-position.ts first");
const [caller] = await ethers.getSigners();
if (caller === undefined) throw new Error(`No account on ${networkName}: set DEPLOYER_PRIVATE_KEY in the env file`);
const engine = (await ethers.getContractAt("StableEngine", deployment.stableEngine)).connect(caller);
const debtor: string = deployment.debtor;
const ratio = await engine.COLLATERAL_RATIO();

// getHealthFactor of the contract, computed for any amount of collateral
async function healthFactorFor(collateral: bigint, debt: bigint) {
  return (((await engine.getUsdValue(collateral)) * 100n) / ratio * ONE) / debt;
}

console.log(`[Network] ${networkName}, chain id ${chainId}, block ${await ethers.provider.getBlockNumber()}`);
console.log(`[StableEngine] ${deployment.stableEngine}`);
const price = await engine.getUsdValue(ONE);
console.log(`[Price] getUsdValue(1 ETH) = ${formatEther(price)} USD`);
const collateral = await engine.collateralDeposited(debtor);
const debt = await engine.sUsdMinted(debtor);
if (debt === 0n) throw new Error(`${debtor} has no debt`);
const before = await engine.getHealthFactor(debtor);
console.log(`[Debtor] ${debtor}`);
console.log(`[Before] collateral ${formatEther(collateral)} ETH, debt ${formatEther(debt)}, health factor ${formatEther(before)}`);

// Collateral for HF 0.9 is worth debt * 1.5 * 0.9 USD; in ETH that is the USD value divided by the
// price of 1 ETH (both with 18 decimals), rounded down
const targetUsd = (debt * ratio * TARGET_HEALTH_FACTOR) / (100n * 100n);
const targetCollateral = (targetUsd * ONE) / price;
const cut = collateral - targetCollateral;
const forecast = await healthFactorFor(targetCollateral, debt);
// the lowest health factor at which the collateral still covers the debt plus the bonus
const reward = (debt * ONE) / price;
const lowest = await healthFactorFor(reward + (reward * (await engine.LIQUIDATION_BONUS())) / 100n, debt);
console.log(`[Plan] collateral for HF 0.9: ${formatEther(debt)} * ${ratio} / 100 * 0.9 = ${formatEther(targetUsd)} USD`);
console.log(`       = ${formatEther(targetUsd)} / ${formatEther(price)} = ${formatEther(targetCollateral)} ETH`);
console.log(`       cut ${formatEther(collateral)} - ${formatEther(targetCollateral)} = ${formatEther(cut)} ETH (${cut} wei)`);
console.log(`       health factor after the cut: ${formatEther(forecast)}`);
console.log(`       liquidation possible from ${formatEther(lowest)} up to 1.0`);
if (cut <= 0n || forecast >= ONE || forecast < lowest) throw new Error("The cut does not give a liquidatable position");

const receipt = (await (await engine.reduceCollateralForTesting(debtor, cut)).wait(CONFIRMATIONS)) as TransactionReceipt;
deployment.transactions["StableEngine.reduceCollateralForTesting"] = receipt.hash;
console.log(`[Tx] StableEngine.reduceCollateralForTesting: ${receipt.hash}`);
console.log(`     block ${receipt.blockNumber}, status ${receipt.status}, gas used ${receipt.gasUsed}, ` +
  `fee ${formatEther(receipt.fee)} ETH at ${formatUnits(receipt.gasPrice, "gwei")} gwei`);
if (onSepolia) console.log(`     https://sepolia.etherscan.io/tx/${receipt.hash}`);
await writeFile(file, JSON.stringify(deployment, null, 2) + "\n");

const after = await engine.getHealthFactor(debtor);
console.log(`[After]  collateral ${formatEther(await engine.collateralDeposited(debtor))} ETH, debt ` +
  `${formatEther(await engine.sUsdMinted(debtor))}, health factor ${after === ethers.MaxUint256 ? "max (no debt)" : formatEther(after)}`);
console.log(`[Engine] ETH balance ${formatEther(await ethers.provider.getBalance(deployment.stableEngine))}: ` +
  `the cut ${formatEther(cut)} ETH stays in the contract, but no registry entry owns it any more`);

// eth_call of liquidate on behalf of the bot: a free check that the bot's transaction will pass.
// The bot polls on its own schedule, so it may have liquidated the position already.
if (deployment.bot !== undefined) {
  try {
    await engine.connect(ethers.provider).liquidate.staticCall(debtor, { from: deployment.bot });
    console.log(`[Check] liquidate(debtor) sent by the bot ${deployment.bot} would succeed now`);
  } catch (error) {
    const reason = (error as { reason?: string }).reason ?? (error as Error).message;
    console.log(`[Check] liquidate(debtor) sent by the bot reverts: ${reason}`);
  }
}
