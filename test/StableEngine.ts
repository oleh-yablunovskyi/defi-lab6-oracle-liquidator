import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();
const { MaxUint256, parseEther, parseUnits } = ethers;

// The mock answers like the real ETH/USD feed of Chainlink: a price with 8 decimals
const FEED_DECIMALS = 8;
const usdPrice = (usd: string) => parseUnits(usd, FEED_DECIMALS);
const HEALTH_FACTOR_OK = "Health factor is ok";
const HEALTH_FACTOR_BROKEN = "Health factor is broken (under 1.0)";

// The deploy order of scripts/deploy.ts: the feed (a mock here), the coin, the engine, then the
// engine becomes the owner of the coin
async function deployFixture() {
  const [admin, borrower, liquidator, stranger] = await ethers.getSigners();
  const feed = await ethers.deployContract("MockV3Aggregator", [FEED_DECIMALS, usdPrice("2000")]);
  const coin = await ethers.deployContract("StableCoin", ["StudentUSD", "sUSD", admin.address]);
  const engine = await ethers.deployContract("StableEngine", [await coin.getAddress(), await feed.getAddress()]);
  await coin.transferOwnership(await engine.getAddress());
  return { admin, borrower, liquidator, stranger, feed, coin, engine };
}

// The borrower deposits 1.65 ETH (3300 USD at 2000 USD) and mints 2000 sUSD:
// 3300 * 100 / 150 = 2200 USD against 2000 of debt, so the health factor is 1.1.
// The liquidator needs sUSD to repay the debt, so the borrower passes the coins on to it.
async function positionFixture() {
  const deployed = await deployFixture();
  const { borrower, liquidator, coin, engine } = deployed;
  await engine.connect(borrower).depositCollateral({ value: parseEther("1.65") });
  await engine.connect(borrower).mintStablecoin(parseEther("2000"));
  await coin.connect(borrower).transfer(liquidator.address, parseEther("2000"));
  return deployed;
}

describe("StableCoin", function () {
  it("belongs to the engine, so the deployer can no longer mint or burn", async function () {
    const { admin, coin, engine } = await networkHelpers.loadFixture(deployFixture);

    expect(await coin.owner()).to.equal(await engine.getAddress());
    await expect(coin.mint(admin.address, 1n))
      .to.be.revertedWithCustomError(coin, "OwnableUnauthorizedAccount")
      .withArgs(admin.address);
    await expect(coin.burn(admin.address, 1n))
      .to.be.revertedWithCustomError(coin, "OwnableUnauthorizedAccount")
      .withArgs(admin.address);
  });
});

describe("StableEngine: oracle price", function () {
  it("scales the 8-decimal Chainlink price to 18 decimals", async function () {
    const { feed, engine } = await networkHelpers.loadFixture(deployFixture);

    expect(await engine.priceFeed()).to.equal(await feed.getAddress());
    expect(await feed.decimals()).to.equal(8n);
    expect((await feed.latestRoundData())[1]).to.equal(200000000000n); // 2000 USD = 2000 * 1e8
    expect(await engine.getUsdValue(parseEther("1"))).to.equal(parseEther("2000"));

    // every digit of the feed answer is kept: 2452.12345678 USD per ETH
    await feed.updateAnswer(usdPrice("2452.12345678"));
    expect(await engine.getUsdValue(parseEther("1"))).to.equal(parseEther("2452.12345678"));
    expect(await engine.getUsdValue(parseEther("0.01"))).to.equal(parseEther("24.5212345678"));
  });

  it("reverts on a zero or negative price, but takes a stale one", async function () {
    const { borrower, feed, engine } = await networkHelpers.loadFixture(deployFixture);
    await engine.connect(borrower).depositCollateral({ value: parseEther("1") });

    await feed.updateAnswer(0n);
    await expect(engine.getUsdValue(parseEther("1"))).to.be.revertedWith("Invalid oracle price");
    await expect(engine.connect(borrower).mintStablecoin(1n)).to.be.revertedWith("Invalid oracle price");
    await feed.updateAnswer(-1n);
    await expect(engine.getUsdValue(parseEther("1"))).to.be.revertedWith("Invalid oracle price");

    // a round last updated on 1 January 1970: the engine does not look at updatedAt
    await feed.updateRoundData(7n, usdPrice("2000"), 1n, 1n);
    const [roundId, , , updatedAt] = await feed.latestRoundData();
    expect([roundId, updatedAt]).to.deep.equal([7n, 1n]);
    expect(await engine.getUsdValue(parseEther("1"))).to.equal(parseEther("2000"));
  });
});

describe("StableEngine: liquidation", function () {
  it("opens a position with a health factor of 1.1 that cannot be liquidated", async function () {
    const { borrower, liquidator, stranger, coin, engine } = await networkHelpers.loadFixture(positionFixture);

    expect(await engine.collateralDeposited(borrower.address)).to.equal(parseEther("1.65"));
    expect(await engine.sUsdMinted(borrower.address)).to.equal(parseEther("2000"));
    expect(await coin.balanceOf(liquidator.address)).to.equal(parseEther("2000"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(parseEther("1.1"));
    await expect(engine.connect(liquidator).liquidate(borrower.address)).to.be.revertedWith(HEALTH_FACTOR_OK);

    // without debt the health factor is type(uint256).max
    expect(await engine.getHealthFactor(stranger.address)).to.equal(MaxUint256);
    await expect(engine.connect(liquidator).liquidate(stranger.address)).to.be.revertedWith(HEALTH_FACTOR_OK);
  });

  it("allows a liquidation only strictly below 1.0", async function () {
    const { borrower, liquidator, feed, coin, engine } = await networkHelpers.loadFixture(deployFixture);
    // 1.5 ETH = 3000 USD, 3000 * 100 / 150 = 2000 USD against 2000 sUSD: exactly 1.0
    await engine.connect(borrower).depositCollateral({ value: parseEther("1.5") });
    await engine.connect(borrower).mintStablecoin(parseEther("2000"));
    await coin.connect(borrower).transfer(liquidator.address, parseEther("2000"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(parseEther("1"));
    await expect(engine.connect(liquidator).liquidate(borrower.address)).to.be.revertedWith(HEALTH_FACTOR_OK);

    // the smallest step of the feed, 0.00000001 USD, is enough
    await feed.updateAnswer(usdPrice("1999.99999999"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(999999999995000000n);
    await expect(engine.connect(liquidator).liquidate(borrower.address)).to.emit(engine, "Liquidated");
  });

  it("liquidates after a price drop and pays the liquidator a 10% bonus", async function () {
    const { borrower, liquidator, feed, coin, engine } = await networkHelpers.loadFixture(positionFixture);

    // ETH falls to 1600 USD: 1.65 ETH = 2640 USD, 2640 * 100 / 150 = 1760 USD, 1760 / 2000 = 0.88
    await feed.updateAnswer(usdPrice("1600"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(parseEther("0.88"));

    // 2000 sUSD of debt is 2000 / 1600 = 1.25 ETH, with the bonus 1.25 + 0.125 = 1.375 ETH,
    // worth 1.375 * 1600 = 2200 USD: 200 USD (10%) more than the liquidator pays
    const liquidation = engine.connect(liquidator).liquidate(borrower.address);
    await expect(liquidation)
      .to.emit(engine, "Liquidated")
      .withArgs(borrower.address, liquidator.address, parseEther("2000"));
    await expect(liquidation).to.changeEtherBalances(ethers, [liquidator, engine], [parseEther("1.375"), parseEther("-1.375")]);
    await expect(liquidation).to.changeTokenBalance(ethers, coin, liquidator, parseEther("-2000"));
    expect(await engine.getUsdValue(parseEther("1.375"))).to.equal(parseEther("2200"));

    expect(await engine.sUsdMinted(borrower.address)).to.equal(0n);
    expect(await engine.collateralDeposited(borrower.address)).to.equal(parseEther("0.275"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(MaxUint256);
    expect(await coin.totalSupply()).to.equal(0n);

    // the borrower keeps the rest of the collateral and can take it back
    await expect(engine.connect(borrower).withdrawCollateral(parseEther("0.275")))
      .to.changeEtherBalance(ethers, borrower, parseEther("0.275"));
  });

  it("liquidates after the backdoor cuts the collateral; the cut ETH stays in the engine", async function () {
    const { borrower, liquidator, stranger, coin, engine } = await networkHelpers.loadFixture(positionFixture);

    // no access control: any account can cut anyone's collateral
    await expect(engine.connect(stranger).reduceCollateralForTesting(borrower.address, parseEther("2")))
      .to.be.revertedWith("Amount exceeds balance");
    await engine.connect(stranger).reduceCollateralForTesting(borrower.address, parseEther("0.3"));
    // 1.35 ETH = 2700 USD, 2700 * 100 / 150 = 1800 USD, 1800 / 2000 = 0.9
    expect(await engine.collateralDeposited(borrower.address)).to.equal(parseEther("1.35"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(parseEther("0.9"));

    // liquidate burns the debt from the caller's balance: an account without sUSD cannot do it
    await expect(engine.connect(stranger).liquidate(borrower.address))
      .to.be.revertedWithCustomError(coin, "ERC20InsufficientBalance")
      .withArgs(stranger.address, 0n, parseEther("2000"));

    // 2000 / 2000 = 1 ETH plus 10%
    await expect(engine.connect(liquidator).liquidate(borrower.address))
      .to.changeEtherBalances(ethers, [liquidator, engine], [parseEther("1.1"), parseEther("-1.1")]);
    expect(await engine.collateralDeposited(borrower.address)).to.equal(parseEther("0.25"));
    // 1.65 - 1.1 = 0.55 ETH are left in the engine, but only 0.25 ETH belong to anybody
    expect(await ethers.provider.getBalance(await engine.getAddress())).to.equal(parseEther("0.55"));
  });

  it("cannot liquidate below a health factor of 1.1 / 1.5 = 0.7333", async function () {
    const { borrower, liquidator, feed, engine } = await networkHelpers.loadFixture(positionFixture);

    // At 1334 USD the health factor is 0.7337 and the collateral still covers the debt with the
    // bonus: 1.1 * 2000 / 1334 = 1.649 ETH <= 1.65 ETH
    await feed.updateAnswer(usdPrice("1334"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(733700000000000000n);
    await engine.connect(liquidator).liquidate.staticCall(borrower.address);

    // At 1333 USD (health factor 0.73315) it would take 1.1 * 2000 / 1333 = 1.6504 ETH
    await feed.updateAnswer(usdPrice("1333"));
    expect(await engine.getHealthFactor(borrower.address)).to.equal(733150000000000000n);
    await expect(engine.connect(liquidator).liquidate(borrower.address))
      .to.be.revertedWith("Not enough collateral to liquidate");
  });
});

describe("StableEngine: deposit, repayment and withdrawal", function () {
  it("takes ETH as collateral", async function () {
    const { borrower, engine } = await networkHelpers.loadFixture(deployFixture);

    const deposit = engine.connect(borrower).depositCollateral({ value: parseEther("1.65") });
    await expect(deposit).to.emit(engine, "CollateralDeposited").withArgs(borrower.address, parseEther("1.65"));
    await expect(deposit).to.changeEtherBalances(ethers, [borrower, engine], [parseEther("-1.65"), parseEther("1.65")]);
    expect(await engine.collateralDeposited(borrower.address)).to.equal(parseEther("1.65"));
    await expect(engine.connect(borrower).depositCollateral({ value: 0n })).to.be.revertedWith("Needs more than 0");
  });

  it("burns stablecoins and returns collateral while the health factor stays at least 1.0", async function () {
    const { borrower, coin, engine } = await networkHelpers.loadFixture(deployFixture);
    const user = engine.connect(borrower);
    await user.depositCollateral({ value: parseEther("1.65") });
    await user.mintStablecoin(parseEther("1000"));

    await expect(user.burnStablecoin(parseEther("2000"))).to.be.revertedWith("Burning more than minted");
    await expect(user.burnStablecoin(parseEther("400")))
      .to.emit(engine, "StablecoinBurned")
      .withArgs(borrower.address, parseEther("400"));
    expect(await engine.sUsdMinted(borrower.address)).to.equal(parseEther("600"));
    expect(await coin.totalSupply()).to.equal(parseEther("600"));

    // 600 sUSD of debt need at least 600 * 1.5 / 2000 = 0.45 ETH, so 1.2 of the 1.65 ETH can
    // leave (the health factor becomes exactly 1.0) and 1.21 ETH cannot
    await expect(user.withdrawCollateral(parseEther("1.21"))).to.be.revertedWith(HEALTH_FACTOR_BROKEN);
    await expect(user.withdrawCollateral(parseEther("1.2")))
      .to.changeEtherBalances(ethers, [borrower, engine], [parseEther("1.2"), parseEther("-1.2")]);
    expect(await engine.getHealthFactor(borrower.address)).to.equal(parseEther("1"));
    await expect(user.withdrawCollateral(parseEther("1"))).to.be.revertedWith("Insufficient collateral");
  });
});
