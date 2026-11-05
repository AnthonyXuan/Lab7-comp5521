import { expect } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import { network } from "hardhat";
import {
  deployLab, units, openRwaPosition, addYield, position, fixed, printPosition, printEvents,
} from "../lib/lab.js";

const connection = await network.create();
after(async () => connection.close());

describe("Yield-bearing RWA collateral", function () {
  let lab;
  beforeEach(async function () {
    lab = await deployLab(connection.ethers);
  });

  it("test_rwa_passive_de-risking | 75 assets increase collateral health without new shares or debt", async function () {
    const { alice, owner, asset, vault, engine, stable } = lab;
    const { shares, vaultDepositTx } = await openRwaPosition(lab);
    await expect(vaultDepositTx).to.emit(vault, "Deposit")
      .withArgs(alice.address, alice.address, units("1500"), shares);
    const before = await position(lab);
    const supplyBefore = await stable.totalSupply();
    const assetSupplyBefore = await asset.totalSupply();
    const shareSupplyBefore = await vault.totalSupply();

    expect(shares).to.equal(units("1500"));
    expect(before.vaultShares).to.equal(shares);
    expect(before.collateralUsd).to.equal(units("1500"));
    expect(before.debt).to.equal(units("900"));
    expect(before.hf).to.equal(units("1500") * units("1") / units("1350"));
    printPosition("Before yield", before);
    console.log(`      Assets per share  ${fixed(await vault.convertToAssets(units("1")), 4)}`);

    const yieldTx = await addYield(lab);
    await expect(yieldTx).to.emit(vault, "YieldAccrued").withArgs(units("75"), units("1575"));
    await expect(yieldTx).to.emit(asset, "Transfer")
      .withArgs(owner.address, vault.target, units("75"));

    const afterYield = await position(lab);
    const underlyingClaim = await vault.convertToAssets(shares);
    expect(await vault.totalAssets()).to.equal(units("1575"));
    expect(await asset.balanceOf(vault.target)).to.equal(units("1575"));
    expect(await asset.balanceOf(owner.address)).to.equal(0n);
    expect(await asset.totalSupply()).to.equal(assetSupplyBefore);
    expect(await vault.totalSupply()).to.equal(shareSupplyBefore);
    expect(afterYield.vaultShares).to.equal(before.vaultShares);
    expect(await vault.balanceOf(engine.target)).to.equal(shares);
    expect(await vault.balanceOf(alice.address)).to.equal(0n); // Shares are locked in the engine.
    expect(afterYield.debt).to.equal(before.debt);
    expect(afterYield.wallet).to.equal(before.wallet);
    expect(await stable.totalSupply()).to.equal(supplyBefore);
    // OpenZeppelin's virtual asset/share introduces a one-wei difference here.
    expect(underlyingClaim).to.be.closeTo(units("1575"), 1n);
    expect(afterYield.collateralUsd).to.equal(underlyingClaim);
    expect(afterYield.hf).to.equal(underlyingClaim * units("1") / units("1350"));
    expect(afterYield.hf).to.be.greaterThan(before.hf);
    expect(await engine.totalDebt()).to.equal(await stable.totalSupply());

    console.log("    Decoded yield receipt:");
    printEvents(lab, await yieldTx.wait());
    printPosition("After 5% simulated yield", afterYield);
    console.log(`      Assets per share  ${fixed(await vault.convertToAssets(units("1")), 4)}`);
    console.log("      Vault shares      1,500 -> 1,500 | Debt: 900 -> 900");
    console.log("      HF                1.1111 -> 1.1667");
  });
});
