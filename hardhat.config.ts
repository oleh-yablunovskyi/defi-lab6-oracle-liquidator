import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

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
});
