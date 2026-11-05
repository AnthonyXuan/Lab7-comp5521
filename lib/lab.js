import { MaxUint256, ZeroAddress, parseEther } from "ethers";

// All lab assets and prices use 18 decimals. Keep calculations in bigint, never float.
export const units = parseEther;

/** Deploy a complete, independent system on the supplied local network. */
export async function deployLab(ethers) {
  const [owner, alice, bob, outsider] = await ethers.getSigners();
  const stable = await ethers.deployContract("StableToken", [owner.address]);
  const feed = await ethers.deployContract("MockPriceFeed", [owner.address]);
  const weth = await ethers.deployContract("MockWETH");
  const asset = await ethers.deployContract("MockERC20", ["Mock Treasury Dollar", "mUSD"]);
  await Promise.all([stable, feed, weth, asset].map((c) => c.waitForDeployment()));

  const vault = await ethers.deployContract("MockRwaVault", [asset.target, owner.address]);
  await vault.waitForDeployment();
  const engine = await ethers.deployContract("StableEngine", [
    stable.target, feed.target, weth.target, vault.target,
  ]);
  await engine.waitForDeployment();

  await (await stable.setEngine(engine.target)).wait();
  await (await feed.setPrice(weth.target, units("3000"))).wait();
  await (await feed.setPrice(asset.target, units("1"))).wait();
  // Only the MOCK UNDERLYING is freely minted. Stablecoins always require engine debt.
  await (await asset.mint(alice.address, units("1500"))).wait();
  await (await asset.mint(owner.address, units("75"))).wait();

  return { ethers, owner, alice, bob, outsider, stable, feed, weth, asset, vault, engine };
}

export async function depositEth(lab, signer, amount = "0.5") {
  const { weth, engine } = lab;
  await (await weth.connect(signer).deposit({ value: units(amount) })).wait();
  await (await weth.connect(signer).approve(engine.target, units(amount))).wait();
  return engine.connect(signer).depositCollateral(weth.target, units(amount));
}

export async function openEthPosition(lab, signer = lab.alice, collateral = "0.5", debt = "1000") {
  const depositTx = await depositEth(lab, signer, collateral);
  await depositTx.wait();
  const mintTx = await lab.engine.connect(signer).mint(units(debt));
  await mintTx.wait();
  return { depositTx, mintTx };
}

/** Bob borrows independently; his tokens do not come from Alice or an admin mint. */
export async function fundLiquidator(lab) {
  await openEthPosition(lab, lab.bob, "1", "1000");
  await (await lab.stable.connect(lab.bob).approve(lab.engine.target, units("1000"))).wait();
}

export async function openRwaPosition(lab) {
  const { alice, asset, vault, engine } = lab;
  await (await asset.connect(alice).approve(vault.target, units("1500"))).wait();
  const vaultDepositTx = await vault.connect(alice).deposit(units("1500"), alice.address);
  await vaultDepositTx.wait();
  const shares = await vault.balanceOf(alice.address);
  await (await vault.connect(alice).approve(engine.target, shares)).wait();
  const collateralTx = await engine.connect(alice).depositCollateral(vault.target, shares);
  await collateralTx.wait();
  const mintTx = await engine.connect(alice).mint(units("900"));
  await mintTx.wait();
  return { vaultDepositTx, collateralTx, mintTx, shares };
}

export async function addYield(lab, amount = "75") {
  await (await lab.asset.approve(lab.vault.target, units(amount))).wait();
  return lab.vault.accrueYield(units(amount));
}

export async function position(lab, user = lab.alice.address) {
  const { engine, stable, weth, vault } = lab;
  const [collateralUsd, debt, wallet, hf, wethCollateral, vaultShares] = await Promise.all([
    engine.accountCollateralValue(user),
    engine.userDebt(user),
    stable.balanceOf(user),
    engine.healthFactor(user),
    engine.userCollateral(user, weth.target),
    engine.userCollateral(user, vault.target),
  ]);
  return { collateralUsd, debt, wallet, hf, wethCollateral, vaultShares };
}

/** Round only for terminal presentation; assertions always compare raw bigint values. */
export function fixed(value, places = 2) {
  const factor = 10n ** BigInt(18 - places);
  const rounded = (value + factor / 2n) / factor;
  const base = 10n ** BigInt(places);
  return `${(rounded / base).toLocaleString("en-US")}.${(rounded % base).toString().padStart(places, "0")}`;
}

export function printPosition(title, p) {
  console.log(`\n    ${title}`);
  console.log(`      Collateral value  $${fixed(p.collateralUsd)}`);
  console.log(`      Debt              ${fixed(p.debt)} LABUSD`);
  console.log(`      Wallet            ${fixed(p.wallet)} LABUSD`);
  console.log(`      Health factor     ${p.hf === MaxUint256 ? "N/A (no debt)" : fixed(p.hf, 4)}`);
  if (p.wethCollateral > 0n) console.log(`      Locked WETH       ${fixed(p.wethCollateral, 8)}`);
  if (p.vaultShares > 0n) console.log(`      Locked shares     ${fixed(p.vaultShares, 4)}`);
}

/** Decode actual receipts, rather than printing hard-coded expected event names. */
export function printEvents(lab, receipt) {
  const names = new Map([
    [ZeroAddress.toLowerCase(), "zero address (mint/burn)"],
    [lab.owner.address.toLowerCase(), "Instructor"],
    [lab.alice.address.toLowerCase(), "Alice"],
    [lab.bob.address.toLowerCase(), "Bob"],
    ...["stable", "feed", "weth", "asset", "vault", "engine"].map((key) => [
      lab[key].target.toLowerCase(), key,
    ]),
  ]);
  const contracts = [lab.engine, lab.stable, lab.weth, lab.asset, lab.vault, lab.feed];
  for (const log of receipt.logs) {
    const contract = contracts.find((c) => c.target.toLowerCase() === log.address.toLowerCase());
    if (!contract) continue;
    const event = contract.interface.parseLog(log);
    if (!event) continue;
    const args = event.fragment.inputs.map((input, i) => {
      const value = event.args[i];
      const display = typeof value === "bigint"
        ? fixed(value, 8)
        : names.get(String(value).toLowerCase()) ?? String(value);
      return `${input.name}=${display}`;
    });
    console.log(`      ${event.name}(${args.join(", ")})`);
  }
}
