# DeFi lab 6 — Chainlink price oracle, liquidation and a liquidator bot

Lab work #6 for the course "Decentralized Finance (DeFi) and Cryptocurrency Technologies" (SUICT).
It continues lab 5: the lending engine no longer takes a mock ETH price from a variable but reads
the Chainlink ETH/USD price feed, a position whose health factor falls below 1.0 can be
liquidated by anyone for a 10% bonus, and an off-chain bot watches a debtor and liquidates it.

- `StableCoin` is the ERC-20 stablecoin of lab 5; only its owner, the engine, can mint and burn.
- `StableEngine` keeps the ETH collateral and the debts. `getUsdValue` calls `latestRoundData()`
  of the feed (`AggregatorV3Interface` from `@chainlink/contracts`) and scales the 8-decimal
  price to 18 decimals. `liquidate(user)` burns the whole debt from the caller's sUSD and pays the
  caller collateral worth the debt plus 10%. `reduceCollateralForTesting` is a lab-only backdoor:
  the price of a real feed cannot be moved on a testnet, so the backdoor cuts a debtor's
  collateral to make the position liquidatable.

  ```text
  health factor = (collateral value in USD * 100 / 150) / debt
  ```

- `bot/liquidator.ts` is the liquidator, a TypeScript and ethers v6 port of the C#/Nethereum agent
  from the lab text: it reads the health factor every 12 seconds and sends `liquidate` when it
  drops below 1.0.

The control task runs on the Sepolia testnet with the real feed
`0x694AA1769357215DE4FAC081bf1f309aDC325306`. The same flow can be rehearsed on a local fork of
Sepolia, which reads the real feed but never sends anything to Sepolia.

## Layout

| Path | What it is |
| --- | --- |
| `contracts/StableCoin.sol` | The stablecoin of lab 5; name and symbol are constructor parameters. |
| `contracts/StableEngine.sol` | The engine from the lab text: Chainlink price, `liquidate`, the backdoor. |
| `scripts/deploy.ts` | Deploys the coin and the engine with the feed address, hands the coin over to the engine, writes `deployments/<network>.json`. On a plain local node it deploys `MockV3Aggregator` first. |
| `scripts/open-position.ts` | The debtor deposits ETH (0.01 ETH with the real feed, 2 ETH with the mock) and mints up to a health factor of 1.1 at the current price; the minted coins and 0.002 ETH for gas go to the bot wallet. |
| `scripts/break-position.ts` | Calls the backdoor with the amount that drops the health factor to 0.9 at the current price. |
| `bot/liquidator.ts` | The liquidator bot. |
| `bot/new-wallet.ts` | Creates a random bot wallet and saves its key to the env file. |
| `test/StableEngine.ts` | Mocha tests on Chainlink's `MockV3Aggregator`. |
| `.env.example` | Every setting, without keys. |

## Requirements

Node.js 22.18 or newer, which runs TypeScript files directly (checked with Node.js 22.22.2 and
npm 11.14.0). `npm install` also installs `@chainlink/contracts`, which brings about 200 packages
of its own tooling; the project compiles only four Solidity files from it: `AggregatorV3Interface.sol`
and `MockV3Aggregator.sol` with the two interfaces the mock imports.

## Tests

```bash
npm install
npx hardhat test
npx hardhat test --gas-stats
npx tsc --noEmit
```

The tests run on Hardhat's in-process chain with `MockV3Aggregator` (8 decimals, 2000 USD): price
scaling, the zero-price check, a health factor of exactly 1.1, liquidation strictly below 1.0,
the 10% bonus after a price drop and after the backdoor, the lower bound of 1.1 / 1.5 = 0.7333,
deposit, burn and withdrawal, and the ownership of the coin.

## Settings

Scripts and the bot read `.env`, or the file named by `ENV_FILE` (for example
`ENV_FILE=.env.fork`). Git ignores both. A variable set in the shell wins over the file.

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `STABLECOIN_NAME`, `STABLECOIN_SYMBOL` | `StudentUSD`, `sUSD` | `deploy.ts` | ERC-20 name and symbol |
| `SEPOLIA_RPC_URL` | `https://ethereum-sepolia-rpc.publicnode.com` | Hardhat | endpoint of `--network sepolia` and of the fork |
| `DEPLOYER_PRIVATE_KEY` | none | Hardhat | the wallet that deploys and opens the position on Sepolia; without it the `sepolia` network is read-only |
| `BOT_PRIVATE_KEY` | none | the bot, `open-position.ts` (address only) | the bot wallet; `npm run new-bot-wallet` creates one |
| `RPC_URL` | `https://ethereum-sepolia-rpc.publicnode.com` | the bot | endpoint the bot reads and sends through |
| `ENGINE_ADDRESS`, `DEBTOR_ADDRESS` | none | the bot | the engine and the debtors to watch (comma separated); `open-position.ts` prints both |
| `POLL_INTERVAL_SECONDS` | `12` | the bot | seconds between checks |

## Rehearsal on a local fork of Sepolia

`npx hardhat node --network sepoliaFork` starts a node that reads Sepolia state, the Chainlink
feed included, and runs the transactions locally with the gas rules of Sepolia's current
hardfork (`amsterdam`). Its accounts come from a test mnemonic in `hardhat.config.ts`.

```bash
# terminal 1
npx hardhat node --network sepoliaFork

# terminal 2: an env file for the fork with a throwaway bot wallet
grep '^STABLECOIN_' .env > .env.fork
printf 'RPC_URL=http://127.0.0.1:8545\nPOLL_INTERVAL_SECONDS=12\n' >> .env.fork
ENV_FILE=.env.fork npm run new-bot-wallet
ENV_FILE=.env.fork npx hardhat run scripts/deploy.ts --network localhost
ENV_FILE=.env.fork npx hardhat run scripts/open-position.ts --network localhost
# add ENGINE_ADDRESS=... and DEBTOR_ADDRESS=... printed by open-position.ts to .env.fork

# terminal 3: the bot reports the position as healthy (HF 1.1)
ENV_FILE=.env.fork npm run bot

# terminal 2: the backdoor drops the health factor to 0.9; within 12 s the bot liquidates
ENV_FILE=.env.fork npx hardhat run scripts/break-position.ts --network localhost
```

A plain `npx hardhat node` works the same way with the mock feed instead of the real one.

An excerpt of the bot's output in such a run (feed answer 2452.40 USD, 0.01 ETH of collateral):

```text
[01:39:30] Позиція 0xeA109B61Af732f6059A2f7106102d79378cb1404 | HF: 1.1
[01:39:42] Блок 11958195 | ETH/USD 2452.4 (оновлено 00:16:12)
[01:39:42] Позиція 0xeA109B61Af732f6059A2f7106102d79378cb1404 | HF: 0.899999999999999909
[01:39:42] [УВАГА] Виявлено неплатоспроможну позицію 0xeA109B61Af732f6059A2f7106102d79378cb1404! Ініціалізація ліквідації...
[01:39:42] Транзакцію надіслано: 0x1a9c2433cd627070f8bd2874a87c25f52ec694996bc96803eeb2b22fd57671e1, очікування квитанції...
[01:39:42] [УСПІХ] Позицію ліквідовано у блоці 11958196. Tx: 0x1a9c2433cd627070f8bd2874a87c25f52ec694996bc96803eeb2b22fd57671e1
[01:39:42]         газ 94767, комісія 0.000094767000852903 ETH (1.000000009 gwei) = 0.232406592891659317 USD
[01:39:42]         бонус 1.486303030303028668 USD (10.0% від боргу), після газу 1.253896437411369351 USD
[01:39:42] Усі позиції зі списку ліквідовано, бот завершує роботу.
```

The bot burned 14.863030303030303030 coins of debt and received 0.006666666666666666 ETH
(16.349333 USD): the debt divided by the price plus 10%. In ETH the whole scenario does not
depend on the price: the debt is worth 20/33 of the deposit, the bot gets 2/3 of it, the
backdoor cuts 2/11, and the debtor keeps 5/33 as collateral.

## Control task on Sepolia

The deployer needs about 0.023 ETH of Sepolia ETH: about 0.011 ETH of gas at a tip of 1 gwei,
0.01 ETH of collateral and 0.002 ETH for the bot wallet. The bot pays its own gas.

```bash
# .env: DEPLOYER_PRIVATE_KEY of a funded wallet, then a new bot wallet
npm run new-bot-wallet
npx hardhat run scripts/deploy.ts --network sepolia
npx hardhat run scripts/open-position.ts --network sepolia
# add ENGINE_ADDRESS and DEBTOR_ADDRESS printed by open-position.ts to .env
npm run bot                                                # another terminal
npx hardhat run scripts/break-position.ts --network sepolia
```

Every script prints the hashes of its transactions with links to Sepolia Etherscan. On Sepolia
the scripts wait for one more block after each transaction before they read the new state.

### The run on Sepolia

The control task ran on Sepolia on 21 October 2026. The deployer and debtor was
`0x09662A780cF56bFe7Ec70A455644E74061d9543C`, the bot wallet
`0x0eCac25e24540649Cc65e99273BDA4f03e647D65`; the name and symbol of the stablecoin came from
`.env`. The feed answered 2442.7505312 USD.

| Contract | Address |
| --- | --- |
| `StableCoin` | [`0x77b05d389058a7F14eb98E7529D6cE69F229Aed8`](https://sepolia.etherscan.io/address/0x77b05d389058a7F14eb98E7529D6cE69F229Aed8) |
| `StableEngine` | [`0xf5d28Fa6BC1E16c8f11Fc7BC27d4FB27B9a00ebF`](https://sepolia.etherscan.io/address/0xf5d28Fa6BC1E16c8f11Fc7BC27d4FB27B9a00ebF) |
| Chainlink ETH/USD feed | [`0x694AA1769357215DE4FAC081bf1f309aDC325306`](https://sepolia.etherscan.io/address/0x694AA1769357215DE4FAC081bf1f309aDC325306) |

| Step | Transaction | Block |
| --- | --- | ---: |
| deploy `StableCoin` | [`0x42086047…3db28b8d`](https://sepolia.etherscan.io/tx/0x4208604716ffb2fbb1ecc98e55a9ae3f55392e710f4972fdb9c2a7593db28b8d) | 11960224 |
| deploy `StableEngine` | [`0xfa1da315…d791dbe7`](https://sepolia.etherscan.io/tx/0xfa1da315342f1acb3cebd2565d9a97735d0785e0a976fe76704397d2d791dbe7) | 11960226 |
| `transferOwnership` to the engine | [`0x4a4d90e4…4998d974`](https://sepolia.etherscan.io/tx/0x4a4d90e42028d92982827b08a2c7e73427572bc3455ab0df7b5f0b494998d974) | 11960228 |
| `depositCollateral` 0.01 ETH | [`0xe0568ce4…00a2004d`](https://sepolia.etherscan.io/tx/0xe0568ce47e0f653375484ed9950a0f032394ac6f1c570b3a8e9fe70600a2004d) | 11960231 |
| `mintStablecoin`, health factor 1.1 | [`0x56f93121…5dd5bce1`](https://sepolia.etherscan.io/tx/0x56f9312108fe0cc751b61bec49e3a31fb4a62a29d6acab43267b06215dd5bce1) | 11960233 |
| 0.002 ETH to the bot wallet | [`0x2758493d…81f22137`](https://sepolia.etherscan.io/tx/0x2758493dbcfdae0eb1841d7d03e34468e1ed7f74fde72a5c3b059c2981f22137) | 11960235 |
| coin `transfer` to the bot | [`0xef64db31…55dd50d5`](https://sepolia.etherscan.io/tx/0xef64db310aeba5e97e7a7b983915f25b0d3e71b75c76964770aa513555dd50d5) | 11960237 |
| `reduceCollateralForTesting`, health factor 0.9 | [`0xfa7a3c02…26f8368e`](https://sepolia.etherscan.io/tx/0xfa7a3c02e4577e7c86024cfc7f7b33bbe996125c0d8cc7e4c1edbc6a26f8368e) | 11960244 |
| **`liquidate` by the bot** | [`0x1b34f4f67d2a96627eb701d2878c7a7868fc8082d82ca322dad89517be084cd7`](https://sepolia.etherscan.io/tx/0x1b34f4f67d2a96627eb701d2878c7a7868fc8082d82ca322dad89517be084cd7) | 11960246 |

The bot saw the health factor of 0.899999999999999909 in its first check after the backdoor
block and liquidated two blocks later. It burned 14.804548673939393939 coins of debt and got
0.006666666666666666 ETH (16.285 USD at the feed price), 10% more than the debt, for
0.000000017675520808 ETH of gas at a tip of 0.0002 gwei. The deployer spent 0.02262823 ETH:
0.01062823 ETH of gas (10,628,230 gas at 1 gwei), 0.01 ETH of collateral and 0.002 ETH for the
bot. The engine keeps 0.003333333333333334 ETH: the debtor's remaining collateral and the part
cut by the backdoor, which belongs to nobody.

## Gas

Gas used on the fork with the `amsterdam` hardfork, `eth_estimateGas` of the same transactions
on Sepolia before the run (read-only, with state overrides), and the gas they used on Sepolia.
Since the Glamsterdam upgrade Sepolia charges much more for new state, so deploying code and
creating accounts or storage slots costs several times more than on Hardhat's default `osaka`
chain.

| Transaction | Fork, gas used | Sepolia, estimate | Sepolia, gas used |
| --- | ---: | ---: | ---: |
| deploy `StableCoin` | 4,119,455 | 4,151,603 | 4,117,755 |
| deploy `StableEngine` | 5,605,299 | 5,651,767 | 5,606,311 |
| `transferOwnership` | 30,753 | 29,999 | 29,853 |
| `depositCollateral` (0.01 ETH) | 133,877 | 134,088 | 132,977 |
| `mintStablecoin` | 387,928 | 383,103 | 378,928 |
| 0.002 ETH to the new bot wallet | 204,600 | 207,391 | 204,600 |
| coin `transfer` to the bot | 130,143 | 141,359 | 129,219 |
| `reduceCollateralForTesting` | 29,487 | 28,934 | 28,587 |
| `liquidate` (by the bot) | 94,767 | 111,274 | 88,367 |

On the fork the transactions used from 0.02% less to 7.2% more gas than on Sepolia, and every
estimate was above the gas used, by up to 26%. An estimate is the smallest gas limit with which a
transaction succeeds, so it also covers gas that is refunded at the end (the coin transfer and
`liquidate` clear storage slots); and Hardhat marks its `amsterdam` support as experimental, so
some prices on the fork differ from Sepolia's.

## Notes

- `reduceCollateralForTesting` has no access control, as in the lab text: anyone can cut anyone's
  collateral. The cut ETH stays in the engine, but no entry of the registry owns it any more.
  Never deploy this function outside a lab.
- The engine checks only that the price is positive. It does not look at `updatedAt`, so a stale
  price is accepted (Sepolia's feed updates about once an hour).
- `withdrawCollateral` and `liquidate` pay ETH with `transfer`, as in the lab text; Solidity 0.8.34
  warns that it is deprecated. It forwards only 2300 gas, so a contract wallet whose `receive`
  needs more cannot withdraw or liquidate; plain accounts are fine.
- `liquidate` always repays the whole debt and needs the collateral to cover the debt plus 10%:
  it works for a health factor from 1.1 / 1.5 = 0.7333 up to, but not including, 1.0.

The written report is kept outside this repository.
