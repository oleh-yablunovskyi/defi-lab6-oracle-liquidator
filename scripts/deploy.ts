// Control task, step 1: deploy StableCoin and StableEngine and make the engine the owner of the
// stablecoin. The engine takes the address of the Chainlink ETH/USD price feed:
// - on Sepolia, and on a local fork of Sepolia, it is the real feed from the lab text;
// - a plain local node has no Chainlink, so there the script first deploys MockV3Aggregator
//   from @chainlink/contracts with 8 decimals and a price of 2000 USD.
//   npx hardhat run scripts/deploy.ts --network sepolia
//   npx hardhat run scripts/deploy.ts --network localhost
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { network } from "hardhat";
import type { BaseContract, ContractTransactionResponse, TransactionReceipt } from "ethers";

// Chainlink ETH/USD price feed on Sepolia (section 6.2 of the lab text)
const SEPOLIA_ETH_USD_FEED = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
const SEPOLIA_CHAIN_ID = 11155111n;
// The mock on a plain local node answers like the real feed: 2000 USD with 8 decimals
const MOCK_DECIMALS = 8;
const MOCK_PRICE = 2000n * 10n ** 8n;
// The functions of the feed this script reads (human-readable ABI of AggregatorV3Interface)
const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

// The name and the symbol of the stablecoin come from the env file that hardhat.config.ts
// loads (see .env.example); without them the neutral defaults below are used
const NAME = process.env.STABLECOIN_NAME || "StudentUSD";
const SYMBOL = process.env.STABLECOIN_SYMBOL || "sUSD";

// Hardhat 3 has no global `ethers` object: it comes from a connection to the network chosen
// with --network
const { ethers, networkName } = await network.create();
const { formatEther, formatUnits } = ethers;
const { chainId } = await ethers.provider.getNetwork();
const onSepolia = chainId === SEPOLIA_CHAIN_ID;
const transactions: Record<string, string> = {};

function printReceipt(label: string, receipt: TransactionReceipt) {
  transactions[label] = receipt.hash;
  console.log(`[Tx] ${label}: ${receipt.hash}`);
  console.log(`     block ${receipt.blockNumber}, status ${receipt.status}, gas used ${receipt.gasUsed}, ` +
    `fee ${formatEther(receipt.fee)} ETH at ${formatUnits(receipt.gasPrice, "gwei")} gwei`);
  if (onSepolia) console.log(`     https://sepolia.etherscan.io/tx/${receipt.hash}`);
}

async function send(label: string, response: Promise<ContractTransactionResponse>) {
  printReceipt(label, (await (await response).wait()) as TransactionReceipt);
}

async function deployed(label: string, contract: BaseContract) {
  printReceipt(`deploy ${label}`, (await contract.deploymentTransaction()!.wait()) as TransactionReceipt);
  const address = await contract.getAddress();
  console.log(`     ${label} at ${address}`);
  if (onSepolia) console.log(`     https://sepolia.etherscan.io/address/${address}`);
  return address;
}

const [deployer] = await ethers.getSigners();
if (deployer === undefined) throw new Error(`No account on ${networkName}: set DEPLOYER_PRIVATE_KEY in the env file`);
console.log(`[Network] ${networkName}, chain id ${chainId}, block ${await ethers.provider.getBlockNumber()}`);
const balanceBefore = await ethers.provider.getBalance(deployer);
console.log(`[Deployer] ${deployer.address}, balance ${formatEther(balanceBefore)} ETH`);
console.log(`[Config] stablecoin name "${NAME}", symbol "${SYMBOL}"`);

// A second deployment by mistake would cost real Sepolia ETH, so an existing one is kept
const file = `deployments/${networkName}.json`;
if (existsSync(file)) {
  const previous = JSON.parse(await readFile(file, "utf8"));
  if ((await ethers.provider.getCode(previous.stableEngine)) !== "0x") {
    throw new Error(`${file} already points to a StableEngine at ${previous.stableEngine}; delete the file to deploy again`);
  }
}

// 0. The price feed. Sepolia and its fork have the real one; a plain local node gets the mock.
let feedAddress = SEPOLIA_ETH_USD_FEED;
const feedIsMock = (await ethers.provider.getCode(SEPOLIA_ETH_USD_FEED)) === "0x";
if (feedIsMock) {
  if (onSepolia) throw new Error(`No contract at ${SEPOLIA_ETH_USD_FEED} on Sepolia`);
  console.log(`\n[Feed] no Chainlink feed at ${SEPOLIA_ETH_USD_FEED} on this chain, deploying the mock`);
  const mock = await ethers.deployContract("MockV3Aggregator", [MOCK_DECIMALS, MOCK_PRICE], deployer);
  feedAddress = await deployed("MockV3Aggregator", mock);
}
const feed = new ethers.Contract(feedAddress, FEED_ABI, ethers.provider);
const decimals: bigint = await feed.decimals();
const [roundId, answer, , updatedAt] = await feed.latestRoundData();
console.log(`\n[Feed] ${feedAddress}: "${await feed.description()}", ${decimals} decimals`);
console.log(`       latest round ${roundId}: answer ${answer} = ${formatUnits(answer, decimals)} USD, ` +
  `updated ${new Date(Number(updatedAt) * 1000).toISOString()}`);

// 1. The stablecoin. Its first owner is the deployer.
console.log();
const coin = await ethers.deployContract("StableCoin", [NAME, SYMBOL, deployer.address], deployer);
const coinAddress = await deployed("StableCoin", coin);
console.log(`     name "${await coin.name()}", symbol "${await coin.symbol()}", decimals ${await coin.decimals()}`);

// 2. The engine, which keeps the ETH collateral and the debts and reads the price from the feed
console.log();
const engine = await ethers.deployContract("StableEngine", [coinAddress, feedAddress], deployer);
const engineAddress = await deployed("StableEngine", engine);
console.log(`     sUsd() = ${await engine.sUsd()}`);
console.log(`     priceFeed() = ${await engine.priceFeed()}`);
console.log(`     COLLATERAL_RATIO = ${await engine.COLLATERAL_RATIO()}%, MIN_HEALTH_FACTOR = ` +
  `${formatEther(await engine.MIN_HEALTH_FACTOR())}, LIQUIDATION_BONUS = ${await engine.LIQUIDATION_BONUS()}%`);
console.log(`     getUsdValue(1 ETH) = ${formatEther(await engine.getUsdValue(10n ** 18n))} USD`);

// 3. The engine becomes the only owner of the stablecoin: from now on only its code can call
//    mint and burn
console.log(`\n[Owner] before: StableCoin.owner() = ${await coin.owner()} (deployer)`);
await send("StableCoin.transferOwnership(StableEngine)", coin.transferOwnership(engineAddress));
console.log(`[Owner] after:  StableCoin.owner() = ${await coin.owner()} (StableEngine)`);

// 4. Save the addresses for the next scripts
const deployment = {
  network: networkName,
  chainId: Number(chainId),
  deployer: deployer.address,
  priceFeed: feedAddress,
  priceFeedIsMock: feedIsMock,
  stableCoin: coinAddress,
  stableEngine: engineAddress,
  transactions,
};
await mkdir("deployments", { recursive: true });
await writeFile(file, JSON.stringify(deployment, null, 2) + "\n");
console.log(`Addresses saved to ${file}`);

// 5. A check without a transaction (eth_call): a mint by the deployer must now revert with the
//    custom error of Ownable, which the node returns ABI-encoded in `error.data`
try {
  await coin.mint.staticCall(deployer.address, 1n);
  console.log("[Check] StableCoin.mint called by the deployer DOES NOT revert");
  process.exitCode = 1;
} catch (error) {
  const data = (error as { data?: unknown }).data;
  const parsed = typeof data === "string" ? coin.interface.parseError(data) : null;
  console.log(parsed === null
    ? `[Check] StableCoin.mint called by the deployer reverts: ${(error as Error).message}`
    : `[Check] StableCoin.mint called by the deployer reverts with ${parsed.name}(${parsed.args.join(", ")})`);
}

const balanceAfter = await ethers.provider.getBalance(deployer);
console.log(`\n[Deployer] balance ${formatEther(balanceAfter)} ETH, spent ${formatEther(balanceBefore - balanceAfter)} ETH`);
