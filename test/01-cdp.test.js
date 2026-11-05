import { expect } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import { MaxUint256, ZeroAddress } from "ethers";
import { network } from "hardhat";
import {
  deployLab, units, depositEth, openEthPosition, fundLiquidator,
  position, fixed, printPosition, printEvents,
} from "../lib/lab.js";

const connection = await network.create();
after(async () => connection.close());

describe("ETH collateral and liquidation", function () {
  let lab;
  beforeEach(async function () {
    lab = await deployLab(connection.ethers);
  });

  it("test_normal_stablecoin_minting | 0.5 ETH backs 1,000 LABUSD at HF = 1", async function () {
    const { alice, engine, stable, weth } = lab;
    const depositTx = await depositEth(lab, alice);
    await expect(depositTx).to.emit(engine, "CollateralDeposited")
      .withArgs(alice.address, weth.target, units("0.5"));

    const mintTx = await engine.connect(alice).mint(units("1000"));
    await expect(mintTx).to.emit(engine, "TokensMinted").withArgs(alice.address, units("1000"));
    await expect(mintTx).to.emit(stable, "Transfer").withArgs(ZeroAddress, alice.address, units("1000"));

    const p = await position(lab);
    expect(p.collateralUsd).to.equal(units("1500"));
    expect(p.debt).to.equal(units("1000"));
    expect(p.wallet).to.equal(units("1000"));
    expect(p.hf).to.equal(units("1"));
    expect(await stable.totalSupply()).to.equal(units("1000"));
    expect(await engine.totalDebt()).to.equal(await stable.totalSupply());
    expect(await weth.balanceOf(engine.target)).to.equal(units("0.5"));

    printPosition("Alice's new position", p);
    console.log("    Decoded deposit and mint receipts:");
    printEvents(lab, await depositTx.wait());
    printEvents(lab, await mintTx.wait());
  });

  it("test_reject_excessive_borrowing | minting 1,001 reverts and leaves accounting unchanged", async function () {
    const { alice, engine, stable, weth } = lab;
    await (await depositEth(lab, alice)).wait();
    const before = await position(lab);
    const supplyBefore = await stable.totalSupply();
    const debtBefore = await engine.totalDebt();

    await expect(engine.connect(alice).mint(units("1001")))
      .to.be.revertedWithCustomError(engine, "BreachesLiquidationThreshold");

    expect(await position(lab)).to.deep.equal(before);
    expect(await stable.totalSupply()).to.equal(supplyBefore);
    expect(await engine.totalDebt()).to.equal(debtBefore);
    expect(await weth.balanceOf(engine.target)).to.equal(units("0.5"));

    const projectedHf = units("1500") * units("1") / units("1501.5");
    console.log(`\n    Projected HF for 1,001 debt: ${fixed(projectedHf, 6)}`);
    console.log("      Expected revert: BreachesLiquidationThreshold()");
    console.log("      Debt: 0 -> 0 | Supply: 0 -> 0 | Locked WETH: 0.5 -> 0.5");
  });

  it("test_market_crash_and_liquidation | Bob repays Alice's debt; Alice keeps her wallet", async function () {
    const { alice, bob, engine, stable, weth, feed } = lab;
    await openEthPosition(lab);
    // Bob locks his own 1 ETH and borrows his own 1,000 tokens before the crash.
    await fundLiquidator(lab);
    printPosition("Alice before the crash", await position(lab));
    expect(await stable.totalSupply()).to.equal(units("2000"));

    const priceTx = await feed.setPrice(weth.target, units("2400"));
    await expect(priceTx).to.emit(feed, "PriceUpdated")
      .withArgs(weth.target, units("3000"), units("2400"));
    expect(await engine.healthFactor(alice.address)).to.equal(units("0.8"));
    expect(await engine.accountCollateralValue(alice.address)).to.equal(units("1200"));
    printPosition("Alice after the 20% crash", await position(lab));

    const supplyBefore = await stable.totalSupply();
    const aliceWalletBefore = await stable.balanceOf(alice.address);
    const collateralToSeize = await engine.quoteLiquidation(weth.target, units("1000"));
    const liquidationTx = await engine.connect(bob).liquidate(alice.address, weth.target, units("1000"));
    await expect(liquidationTx).to.emit(engine, "Liquidated")
      .withArgs(bob.address, alice.address, weth.target, units("1000"), collateralToSeize);
    await expect(liquidationTx).to.emit(engine, "DebtRepaid")
      .withArgs(alice.address, bob.address, units("1000"));
    await expect(liquidationTx).to.emit(stable, "Transfer")
      .withArgs(engine.target, ZeroAddress, units("1000"));

    const aliceAfter = await position(lab);
    const bobWeth = await weth.balanceOf(bob.address);
    const bobReceivedUsd = await engine.collateralValue(weth.target, bobWeth);
    expect(bobWeth).to.equal(collateralToSeize);
    // One wei of WETH is worth 2,400 wei of USD at this price. Seizure rounds UP.
    expect(bobReceivedUsd).to.be.gte(units("1100"));
    expect(bobReceivedUsd - units("1100")).to.be.lessThan(2400n);
    expect(aliceAfter.collateralUsd).to.be.closeTo(units("100"), 2400n);
    expect(aliceAfter.wallet).to.equal(aliceWalletBefore);
    expect(aliceAfter.wallet).to.equal(units("1000"));
    expect(aliceAfter.debt).to.equal(0n);
    expect(aliceAfter.hf).to.equal(MaxUint256);
    expect(aliceAfter.wethCollateral + bobWeth).to.equal(units("0.5"));
    expect(await stable.balanceOf(bob.address)).to.equal(0n);
    expect(await stable.balanceOf(engine.target)).to.equal(0n);
    expect(await stable.totalSupply()).to.equal(supplyBefore - units("1000"));
    expect(await engine.userDebt(bob.address)).to.equal(units("1000"));
    expect(await engine.healthFactor(bob.address)).to.equal(units("1.6"));
    expect(await engine.totalDebt()).to.equal(await stable.totalSupply());

    console.log("    Decoded liquidation receipt:");
    printEvents(lab, await liquidationTx.wait());
    printPosition("Alice after liquidation", aliceAfter);
    console.log(`      Bob receives      ${fixed(bobWeth, 8)} WETH = $${fixed(bobReceivedUsd)}`);
    console.log("      Total supply      2,000 -> 1,000 (Bob's independent debt remains)");
    console.log(`      Alice's net assets $${fixed(aliceAfter.wallet + aliceAfter.collateralUsd)} (ignoring gas)`);

    // The remaining collateral still belongs to Alice and can actually be withdrawn.
    const remaining = aliceAfter.wethCollateral;
    await expect(engine.connect(alice).withdrawCollateral(weth.target, remaining))
      .to.emit(engine, "CollateralWithdrawn").withArgs(alice.address, weth.target, remaining);
    expect(await weth.balanceOf(alice.address)).to.equal(remaining);
    expect(await engine.userCollateral(alice.address, weth.target)).to.equal(0n);
  });
});
