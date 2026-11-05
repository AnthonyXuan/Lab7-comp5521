import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  deployLab, units, openEthPosition, fundLiquidator, openRwaPosition, addYield,
  position, fixed, printPosition, printEvents,
} from "../lib/lab.js";

// An uninterrupted lecture demo. Automated assertions remain in test/*.test.js.
const connection = await network.create();
try {
  console.log("\nLAB 8 | Stablecoins, liquidation, and yield-bearing RWA collateral");
  console.log("All balances are local teaching assets. Display values are rounded.");

  const ethLab = await deployLab(connection.ethers);
  const { alice, bob, engine, stable, feed, weth } = ethLab;
  const { depositTx, mintTx } = await openEthPosition(ethLab);
  printPosition("1. Alice deposits 0.5 ETH and borrows 1,000 LABUSD", await position(ethLab));
  printEvents(ethLab, await depositTx.wait());
  printEvents(ethLab, await mintTx.wait());

  // Alice is already at the limit: even one additional LABUSD is rejected.
  let rejected = false;
  try {
    await (await engine.connect(alice).mint(units("1"))).wait();
  } catch (error) {
    // Only swallow the expected custom error; unrelated failures must stop the demo.
    const data = error.data ?? error.error?.data;
    const decoded = typeof data === "string" ? engine.interface.parseError(data) : null;
    if (decoded?.name !== "BreachesLiquidationThreshold") throw error;
    rejected = true;
    console.log("\n    2. Borrowing limit enforced: one more LABUSD reverts.");
    console.log("      BreachesLiquidationThreshold() | Debt and supply stay at 1,000.");
  }
  assert.ok(rejected, "The overborrowing transaction must revert");

  await fundLiquidator(ethLab);
  console.log("\n    Bob separately locks 1 ETH and borrows 1,000 LABUSD. Total supply is now 2,000.");
  await (await feed.setPrice(weth.target, units("2400"))).wait();
  printPosition("3. A 20% ETH crash makes Alice liquidatable", await position(ethLab));
  const liquidation = await engine.connect(bob).liquidate(alice.address, weth.target, units("1000"));
  console.log("    Atomic settlement events:");
  printEvents(ethLab, await liquidation.wait());
  printPosition("4. Alice keeps her original stablecoins", await position(ethLab));
  const bobValue = await engine.collateralValue(weth.target, await weth.balanceOf(bob.address));
  console.log(`      Bob receives $${fixed(bobValue)} in WETH; his own 1,000 debt remains.`);
  console.log(`      Remaining total supply: ${fixed(await stable.totalSupply())} LABUSD`);

  const rwaLab = await deployLab(connection.ethers);
  await openRwaPosition(rwaLab);
  printPosition("5. A separate RWA example: 1,500 vault shares and 900 debt", await position(rwaLab));
  const yieldTx = await addYield(rwaLab);
  console.log("    Yield arrives as an actual transfer of 75 underlying assets:");
  printEvents(rwaLab, await yieldTx.wait());
  printPosition("6. Yield increases collateral health without minting shares", await position(rwaLab));
  console.log("\nTry npm run test:guards for the 30% crash and other boundary cases.\n");
} finally {
  await connection.close();
}
