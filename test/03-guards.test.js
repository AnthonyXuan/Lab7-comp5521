import { expect } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import { MaxUint256, ZeroAddress } from "ethers";
import { network } from "hardhat";
import {
  deployLab, units, depositEth, openEthPosition, fundLiquidator,
  openRwaPosition, addYield, position, printPosition,
} from "../lib/lab.js";

const connection = await network.create();
after(async () => connection.close());

// Deliberately exclude native ETH: a mined failed transaction can still consume gas.
async function settlementState(lab) {
  return {
    alice: await position(lab),
    bob: await position(lab, lab.bob.address),
    bobWeth: await lab.weth.balanceOf(lab.bob.address),
    engineWeth: await lab.weth.balanceOf(lab.engine.target),
    engineStable: await lab.stable.balanceOf(lab.engine.target),
    totalDebt: await lab.engine.totalDebt(),
    supply: await lab.stable.totalSupply(),
  };
}

describe("Extra verification | Access control, repayment, and liquidation limits", function () {
  let lab;
  beforeEach(async function () {
    lab = await deployLab(connection.ethers);
  });

  it("only the engine can mint or burn, including when the caller is the token owner", async function () {
    const { stable, alice, owner } = lab;
    for (const caller of [alice, owner]) {
      await expect(stable.connect(caller).mint(caller.address, units("1")))
        .to.be.revertedWithCustomError(stable, "OnlyEngine");
      await expect(stable.connect(caller).burn(units("1")))
        .to.be.revertedWithCustomError(stable, "OnlyEngine");
    }
    expect(await stable.totalSupply()).to.equal(0n);
  });

  it("only the owner can initialize the engine, and the engine cannot be replaced", async function () {
    const { stable, alice, engine, owner, ethers } = lab;
    await expect(stable.connect(alice).setEngine(engine.target))
      .to.be.revertedWithCustomError(stable, "OwnableUnauthorizedAccount").withArgs(alice.address);
    await expect(stable.setEngine(engine.target))
      .to.be.revertedWithCustomError(stable, "EngineAlreadySet");

    const fresh = await ethers.deployContract("StableToken", [owner.address]);
    await fresh.waitForDeployment();
    await expect(fresh.setEngine(ZeroAddress)).to.be.revertedWithCustomError(fresh, "InvalidEngine");
    await expect(fresh.setEngine(alice.address)).to.be.revertedWithCustomError(fresh, "InvalidEngine");
    expect(await stable.engine()).to.equal(engine.target);
  });

  it("minting without collateral cannot create either debt or supply", async function () {
    const { engine, alice, stable } = lab;
    await expect(engine.connect(alice).mint(units("1")))
      .to.be.revertedWithCustomError(engine, "BreachesLiquidationThreshold");
    expect(await engine.userDebt(alice.address)).to.equal(0n);
    expect(await engine.totalDebt()).to.equal(0n);
    expect(await stable.totalSupply()).to.equal(0n);
  });

  it("a failed collateral transfer rolls back the deposit ledger", async function () {
    const { weth, engine, alice } = lab;
    await (await weth.connect(alice).deposit({ value: units("0.5") })).wait();
    await expect(engine.connect(alice).depositCollateral(weth.target, units("0.5")))
      .to.be.revertedWithCustomError(weth, "ERC20InsufficientAllowance");
    expect(await engine.userCollateral(alice.address, weth.target)).to.equal(0n);
    expect(await weth.balanceOf(alice.address)).to.equal(units("0.5"));
    expect(await weth.balanceOf(engine.target)).to.equal(0n);
  });

  it("the underlying asset itself is not an allowed collateral token", async function () {
    const { asset, engine, alice } = lab;
    await expect(engine.connect(alice).depositCollateral(asset.target, units("1")))
      .to.be.revertedWithCustomError(engine, "UnsupportedCollateral").withArgs(asset.target);
  });

  it("zero-value operations are rejected", async function () {
    const { engine, alice, bob, weth } = lab;
    await expect(engine.connect(alice).depositCollateral(weth.target, 0n))
      .to.be.revertedWithCustomError(engine, "ZeroAmount");
    await expect(engine.connect(alice).mint(0n)).to.be.revertedWithCustomError(engine, "ZeroAmount");
    await expect(engine.connect(alice).repay(0n)).to.be.revertedWithCustomError(engine, "ZeroAmount");
    await expect(engine.connect(alice).withdrawCollateral(weth.target, 0n))
      .to.be.revertedWithCustomError(engine, "ZeroAmount");
    await expect(engine.connect(bob).liquidate(alice.address, weth.target, 0n))
      .to.be.revertedWithCustomError(engine, "ZeroAmount");
  });

  it("unsafe withdrawals revert without changing collateral or token balances", async function () {
    const { engine, alice, weth } = lab;
    await openEthPosition(lab);
    const before = await settlementState(lab);
    await expect(engine.connect(alice).withdrawCollateral(weth.target, units("0.01")))
      .to.be.revertedWithCustomError(engine, "BreachesLiquidationThreshold");
    await expect(engine.connect(alice).withdrawCollateral(weth.target, units("1")))
      .to.be.revertedWithCustomError(engine, "InsufficientCollateral");
    expect(await settlementState(lab)).to.deep.equal(before);
  });

  it("repayment burns supply and unlocks collateral; full repayment permits full withdrawal", async function () {
    const { engine, alice, stable, weth } = lab;
    await openEthPosition(lab);
    await (await stable.connect(alice).approve(engine.target, units("1000"))).wait();
    await expect(engine.connect(alice).repay(units("100")))
      .to.emit(engine, "DebtRepaid").withArgs(alice.address, alice.address, units("100"));
    expect(await stable.totalSupply()).to.equal(units("900"));
    expect(await engine.userDebt(alice.address)).to.equal(units("900"));
    expect(await engine.totalDebt()).to.equal(units("900"));
    await (await engine.connect(alice).withdrawCollateral(weth.target, units("0.05"))).wait();
    expect(await engine.healthFactor(alice.address)).to.equal(units("1"));

    await (await engine.connect(alice).repay(units("900"))).wait();
    expect(await engine.healthFactor(alice.address)).to.equal(MaxUint256);
    await (await engine.connect(alice).withdrawCollateral(weth.target, units("0.45"))).wait();
    expect(await weth.balanceOf(alice.address)).to.equal(units("0.5"));
    expect(await weth.balanceOf(engine.target)).to.equal(0n);
    expect(await stable.balanceOf(engine.target)).to.equal(0n);
    expect(await stable.totalSupply()).to.equal(0n);
    expect(await engine.totalDebt()).to.equal(0n);
  });

  it("failed repayment without approval rolls back debt and supply", async function () {
    const { engine, alice, stable } = lab;
    await openEthPosition(lab);
    const before = await settlementState(lab);
    await expect(engine.connect(alice).repay(units("100")))
      .to.be.revertedWithCustomError(stable, "ERC20InsufficientAllowance");
    expect(await settlementState(lab)).to.deep.equal(before);
  });

  it("repayment above outstanding debt is rejected", async function () {
    const { engine, alice } = lab;
    await openEthPosition(lab);
    const before = await settlementState(lab);
    await expect(engine.connect(alice).repay(units("1001")))
      .to.be.revertedWithCustomError(engine, "RepaymentExceedsDebt");
    expect(await settlementState(lab)).to.deep.equal(before);
  });

  it("an unhealthy borrower can still repay to recover solvency", async function () {
    const { engine, feed, weth, stable, alice } = lab;
    await openEthPosition(lab);
    await (await feed.setPrice(weth.target, units("2400"))).wait();
    await (await stable.connect(alice).approve(engine.target, units("200"))).wait();
    await (await engine.connect(alice).repay(units("200"))).wait();
    expect(await engine.healthFactor(alice.address)).to.equal(units("1"));
    expect(await engine.userDebt(alice.address)).to.equal(units("800"));
    expect(await stable.totalSupply()).to.equal(units("800"));
  });

  it("liquidation at exactly HF = 1 is rejected", async function () {
    const { engine, alice, bob, weth } = lab;
    await openEthPosition(lab);
    await fundLiquidator(lab);
    const before = await settlementState(lab);
    await expect(engine.connect(bob).liquidate(alice.address, weth.target, units("1000")))
      .to.be.revertedWithCustomError(engine, "PositionIsHealthy");
    expect(await settlementState(lab)).to.deep.equal(before);
  });

  it("liquidation without Bob's allowance rolls back repayment and seizure together", async function () {
    const { engine, alice, bob, weth, stable, feed } = lab;
    await openEthPosition(lab);
    await fundLiquidator(lab);
    await (await feed.setPrice(weth.target, units("2400"))).wait();
    await (await stable.connect(bob).approve(engine.target, 0n)).wait();
    const before = await settlementState(lab);
    await expect(engine.connect(bob).liquidate(alice.address, weth.target, units("1000")))
      .to.be.revertedWithCustomError(stable, "ERC20InsufficientAllowance");
    expect(await settlementState(lab)).to.deep.equal(before);
  });

  it("partial liquidation improves HF while leaving some debt outstanding", async function () {
    const { engine, alice, bob, weth, feed, stable } = lab;
    await openEthPosition(lab);
    await fundLiquidator(lab);
    await (await feed.setPrice(weth.target, units("2400"))).wait();
    const hfBefore = await engine.healthFactor(alice.address);
    const quote = await engine.quoteLiquidation(weth.target, units("500"));
    await (await engine.connect(bob).liquidate(alice.address, weth.target, units("500"))).wait();
    expect(await engine.userDebt(alice.address)).to.equal(units("500"));
    expect(await engine.healthFactor(alice.address)).to.be.greaterThan(hfBefore);
    expect(await engine.healthFactor(alice.address)).to.be.lessThan(units("1"));
    expect(await weth.balanceOf(bob.address)).to.equal(quote);
    expect(await stable.balanceOf(bob.address)).to.equal(units("500"));
    expect(await stable.balanceOf(alice.address)).to.equal(units("1000"));
    expect(await engine.totalDebt()).to.equal(await stable.totalSupply());
  });

  it("liquidation cannot repay more than the borrower's debt", async function () {
    const { engine, alice, bob, weth, feed } = lab;
    await openEthPosition(lab);
    await fundLiquidator(lab);
    await (await feed.setPrice(weth.target, units("2400"))).wait();
    await expect(engine.connect(bob).liquidate(alice.address, weth.target, units("1001")))
      .to.be.revertedWithCustomError(engine, "RepaymentExceedsDebt");
  });

  it("borrowers cannot liquidate themselves to bypass withdrawal restrictions", async function () {
    const { engine, alice, weth, feed } = lab;
    await openEthPosition(lab);
    await (await feed.setPrice(weth.target, units("2400"))).wait();
    await expect(engine.connect(alice).liquidate(alice.address, weth.target, units("1000")))
      .to.be.revertedWithCustomError(engine, "CannotLiquidateSelf");
  });

  it("test_insufficient_collateral_after_30_percent_crash | $1,050 cannot cover $1,100", async function () {
    const { engine, alice, bob, weth, feed } = lab;
    await openEthPosition(lab);
    await fundLiquidator(lab);
    await (await feed.setPrice(weth.target, units("2100"))).wait();
    const before = await settlementState(lab);
    expect(before.alice.collateralUsd).to.equal(units("1050"));
    expect(before.alice.hf).to.equal(units("0.7"));
    expect(await engine.quoteLiquidation(weth.target, units("1000"))).to.be.greaterThan(units("0.5"));
    await expect(engine.connect(bob).liquidate(alice.address, weth.target, units("1000")))
      .to.be.revertedWithCustomError(engine, "InsufficientCollateral");
    expect(await settlementState(lab)).to.deep.equal(before);
    printPosition("discussion | A 30% crash", before.alice);
    console.log("      Full liquidation reverts: $1,050 available < $1,100 required.");
    console.log("      This model leaves the position unresolved; it has no bad-debt backstop.");
  });

  it("a partial liquidation that worsens HF also rolls back all settlement", async function () {
    const { engine, alice, bob, weth, feed } = lab;
    await openEthPosition(lab);
    await fundLiquidator(lab);
    await (await feed.setPrice(weth.target, units("2100"))).wait();
    const before = await settlementState(lab);
    await expect(engine.connect(bob).liquidate(alice.address, weth.target, units("500")))
      .to.be.revertedWithCustomError(engine, "LiquidationDoesNotImproveHealth");
    expect(await settlementState(lab)).to.deep.equal(before);
  });

  it("only the instructor can change prices; missing and zero prices are rejected", async function () {
    const { feed, weth, alice } = lab;
    await expect(feed.connect(alice).setPrice(weth.target, units("1")))
      .to.be.revertedWithCustomError(feed, "OwnableUnauthorizedAccount").withArgs(alice.address);
    await expect(feed.setPrice(weth.target, 0n)).to.be.revertedWithCustomError(feed, "InvalidPrice");
    await expect(feed.setPrice(ZeroAddress, units("1"))).to.be.revertedWithCustomError(feed, "InvalidPrice");
    await expect(feed.getPrice(alice.address))
      .to.be.revertedWithCustomError(feed, "PriceNotSet").withArgs(alice.address);
    expect(await feed.getPrice(weth.target)).to.equal(units("3000"));
  });

  it("simulated yield needs instructor authority, actual assets, and approval", async function () {
    const { vault, alice, asset } = lab;
    await openRwaPosition(lab);
    await expect(vault.connect(alice).accrueYield(units("75")))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount").withArgs(alice.address);
    await expect(vault.accrueYield(units("75")))
      .to.be.revertedWithCustomError(asset, "ERC20InsufficientAllowance");
    await expect(vault.accrueYield(0n)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    expect(await vault.totalAssets()).to.equal(units("1500"));
  });

  it("vault collateral follows the underlying price, including a depeg after yield", async function () {
    const { feed, asset, engine, alice } = lab;
    await openRwaPosition(lab);
    await (await addYield(lab)).wait();
    const hfAfterYield = await engine.healthFactor(alice.address);
    await (await feed.setPrice(asset.target, units("0.8"))).wait();
    expect(await engine.accountCollateralValue(alice.address)).to.be.closeTo(units("1260"), 1n);
    expect(await engine.healthFactor(alice.address)).to.be.lessThan(hfAfterYield);
    expect(await engine.healthFactor(alice.address)).to.be.lessThan(units("1"));
  });

  it("RWA liquidation transfers shares with the bonus, and those shares can be redeemed", async function () {
    const { feed, asset, vault, engine, alice, bob, stable } = lab;
    await openRwaPosition(lab);
    await (await addYield(lab)).wait();
    await fundLiquidator(lab);
    await (await feed.setPrice(asset.target, units("0.8"))).wait();
    const quote = await engine.quoteLiquidation(vault.target, units("900"));
    await expect(engine.connect(bob).liquidate(alice.address, vault.target, units("900")))
      .to.emit(engine, "Liquidated").withArgs(bob.address, alice.address, vault.target, units("900"), quote);
    expect(await vault.balanceOf(bob.address)).to.equal(quote);
    expect(await engine.collateralValue(vault.target, quote)).to.be.closeTo(units("990"), 2n);
    expect(await engine.userDebt(alice.address)).to.equal(0n);
    expect(await stable.balanceOf(alice.address)).to.equal(units("900"));
    expect(await stable.balanceOf(bob.address)).to.equal(units("100"));
    expect(await engine.totalDebt()).to.equal(await stable.totalSupply());

    const expectedAssets = await vault.previewRedeem(quote);
    await (await vault.connect(bob).redeem(quote, bob.address, bob.address)).wait();
    expect(await asset.balanceOf(bob.address)).to.equal(expectedAssets);
    expect(expectedAssets).to.be.closeTo(units("1237.5"), 2n);
  });

  it("multiple collateral types contribute to the same debt and HF", async function () {
    const { alice, engine, weth, vault, stable } = lab;
    await openRwaPosition(lab); // $1,500 vault collateral, 900 debt.
    await (await depositEth(lab, alice, "0.5")).wait(); // Another $1,500.
    await (await engine.connect(alice).mint(units("1100"))).wait();
    expect(await engine.accountCollateralValue(alice.address)).to.equal(units("3000"));
    expect(await engine.userCollateral(alice.address, weth.target)).to.equal(units("0.5"));
    expect(await engine.userCollateral(alice.address, vault.target)).to.equal(units("1500"));
    expect(await engine.userDebt(alice.address)).to.equal(units("2000"));
    expect(await engine.healthFactor(alice.address)).to.equal(units("1"));
    expect(await engine.totalDebt()).to.equal(await stable.totalSupply());
  });

  it("wrapped ETH can be unwrapped back to native local ETH", async function () {
    const { alice, weth, ethers } = lab;
    await (await weth.connect(alice).deposit({ value: units("0.5") })).wait();
    expect(await ethers.provider.getBalance(weth.target)).to.equal(units("0.5"));
    await (await weth.connect(alice).withdraw(units("0.5"))).wait();
    expect(await weth.balanceOf(alice.address)).to.equal(0n);
    expect(await weth.totalSupply()).to.equal(0n);
    expect(await ethers.provider.getBalance(weth.target)).to.equal(0n);
  });
});
