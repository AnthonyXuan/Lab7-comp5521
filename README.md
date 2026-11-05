## Before class

From the repository directory:

```sh
npm ci
npx hardhat compile
```

Check `node --version` if setup fails; use Node 24. All funds are local test assets.

## 1. Normal borrowing

```sh
npm run test:core -- --grep test_normal_stablecoin_minting
```

## 2. Excessive borrowing

```sh
npm run test:core -- --grep test_reject_excessive_borrowing
```

## 3. Crash and liquidation

```sh
npm run test:core -- --grep test_market_crash_and_liquidation
```

Optional discussion command:

```sh
npm run test:guards -- --grep test_insufficient_collateral_after_30_percent_crash
```

## 4. Yield-bearing collateral

```sh
npm run test:rwa
```