import { existsSync } from "node:fs";
import { resolve } from "node:path";
import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

// Local settings (the stablecoin name, private keys, the bot settings) are read from .env in
// this folder, or from the file named by ENV_FILE, e.g. ENV_FILE=.env.fork for the fork
// rehearsal. Git ignores both; .env.example lists the variables. A variable that is already
// set in the shell is not replaced by the file.
const envFile = resolve(import.meta.dirname, process.env.ENV_FILE || ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Public Sepolia endpoint that needs no account or API key; a non-empty SEPOLIA_RPC_URL replaces it
const sepoliaRpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    // The price feed mock of Chainlink for the tests and for a plain local node, where there is
    // no real feed. None of the contracts imports it, so it is compiled from the npm package.
    npmFilesToBuild: ["@chainlink/contracts/src/v0.8/shared/mocks/MockV3Aggregator.sol"],
    profiles: {
      // The optimizer is on in the default profile too, so the tests, the scripts and the
      // deployment to Sepolia all use the same bytecode. Sepolia charges for every byte of
      // deployed code, and the optimized code is much smaller.
      default: {
        version: "0.8.34",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      production: {
        version: "0.8.34",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  // Built-in networks need no config: "default" is the in-process chain of `npx hardhat test`,
  // "localhost" is the node started with `npx hardhat node` on http://127.0.0.1:8545.
  networks: {
    // The Sepolia testnet of the control task. Transactions are signed with DEPLOYER_PRIVATE_KEY,
    // the wallet that deploys the contracts and opens the position. Without the key the network
    // has no accounts and can only be read. The bot has its own key and does not use Hardhat.
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: sepoliaRpcUrl,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [configVariable("DEPLOYER_PRIVATE_KEY")] : [],
    },
    // A local fork of Sepolia for a rehearsal: `npx hardhat node --network sepoliaFork` starts a
    // node on http://127.0.0.1:8545 that reads Sepolia state, the Chainlink feed among it, as of
    // the latest block; the scripts reach it as "localhost". Transactions run only on this node
    // and never reach Sepolia. The "amsterdam" hardfork is the Glamsterdam upgrade that Sepolia
    // runs, so the gas costs on the fork are close to the real ones.
    sepoliaFork: {
      type: "edr-simulated",
      chainType: "l1",
      hardfork: "amsterdam",
      forking: {
        url: sepoliaRpcUrl,
      },
      // Test accounts made for this lab, funded only on the fork. The phrase is public, so never
      // send real funds to these addresses.
      accounts: {
        mnemonic: "click repeat ability fat topic biology stem stem vessel enemy worth pink",
      },
    },
  },
});
