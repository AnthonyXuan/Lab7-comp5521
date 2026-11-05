// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {StableToken} from "./StableToken.sol";
import {MockPriceFeed} from "./MockPriceFeed.sol";

/// @notice Teaching CDP with two fixed collateral types: WETH and ERC-4626 shares.
/// @dev All tokens and USD prices have 18 decimals. Each LABUSD debt unit is valued at $1.
contract StableEngine is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MIN_COLLATERAL_RATIO = 1.5e18;
    uint256 public constant MIN_HEALTH_FACTOR = 1e18;
    uint256 public constant LIQUIDATION_BONUS_BPS = 1_000; // 10%
    uint256 private constant BPS = 10_000;

    StableToken public immutable stableToken;
    MockPriceFeed public immutable priceFeed;
    address public immutable weth;
    IERC4626 public immutable rwaVault;
    address public immutable rwaAsset;

    mapping(address user => mapping(address token => uint256 amount)) public userCollateral;
    mapping(address user => uint256 amount) public userDebt;
    uint256 public totalDebt;

    error ZeroAmount();
    error InvalidConfiguration();
    error UnsupportedCollateral(address token);
    error BreachesLiquidationThreshold();
    error InsufficientCollateral();
    error RepaymentExceedsDebt();
    error PositionIsHealthy();
    error CannotLiquidateSelf();
    error LiquidationDoesNotImproveHealth();

    event CollateralDeposited(address indexed user, address indexed token, uint256 amount);
    event CollateralWithdrawn(address indexed user, address indexed token, uint256 amount);
    event TokensMinted(address indexed user, uint256 amount);
    event DebtRepaid(address indexed user, address indexed payer, uint256 amount);
    event Liquidated(
        address indexed liquidator,
        address indexed user,
        address indexed token,
        uint256 debtRepaid,
        uint256 collateralSeized
    );

    constructor(address stableToken_, address priceFeed_, address weth_, address rwaVault_) {
        if (
            stableToken_.code.length == 0 || priceFeed_.code.length == 0
                || weth_.code.length == 0 || rwaVault_.code.length == 0
                || weth_ == rwaVault_
        ) revert InvalidConfiguration();

        stableToken = StableToken(stableToken_);
        priceFeed = MockPriceFeed(priceFeed_);
        weth = weth_;
        rwaVault = IERC4626(rwaVault_);
        rwaAsset = IERC4626(rwaVault_).asset();
        if (
            IERC20Metadata(weth_).decimals() != 18 || IERC20Metadata(rwaVault_).decimals() != 18
                || IERC20Metadata(rwaAsset).decimals() != 18
        ) revert InvalidConfiguration();
    }

    function depositCollateral(address token, uint256 amount) external nonReentrant {
        _requireSupported(token);
        _requireNonZero(amount);
        userCollateral[msg.sender][token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralDeposited(msg.sender, token, amount);
    }

    function mint(uint256 amount) external nonReentrant {
        _requireNonZero(amount);
        // Reverts roll back this debt update as well as any later token operations.
        userDebt[msg.sender] += amount;
        totalDebt += amount;
        _requireHealthy(msg.sender);
        stableToken.mint(msg.sender, amount);
        emit TokensMinted(msg.sender, amount);
    }

    function repay(uint256 amount) external nonReentrant {
        _requireNonZero(amount);
        _repay(msg.sender, msg.sender, amount);
    }

    function withdrawCollateral(address token, uint256 amount) external nonReentrant {
        _requireSupported(token);
        _requireNonZero(amount);
        if (amount > userCollateral[msg.sender][token]) revert InsufficientCollateral();
        userCollateral[msg.sender][token] -= amount;
        _requireHealthy(msg.sender);
        IERC20(token).safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, token, amount);
    }

    /// @notice The liquidator pays their own LABUSD and receives the selected collateral.
    /// @dev Requires full bonus coverage. This lab has no bad-debt resolution mechanism.
    function liquidate(address user, address token, uint256 debtToCover) external nonReentrant {
        _requireSupported(token);
        _requireNonZero(debtToCover);
        if (msg.sender == user) revert CannotLiquidateSelf();
        uint256 healthBefore = healthFactor(user);
        if (healthBefore >= MIN_HEALTH_FACTOR) revert PositionIsHealthy();
        if (debtToCover > userDebt[user]) revert RepaymentExceedsDebt();

        uint256 collateralToSeize = quoteLiquidation(token, debtToCover);
        if (collateralToSeize > userCollateral[user][token]) revert InsufficientCollateral();

        userCollateral[user][token] -= collateralToSeize;
        _repay(user, msg.sender, debtToCover);
        // Partial liquidation must improve HF; it need not restore HF all the way to 1.
        if (userDebt[user] != 0 && healthFactor(user) <= healthBefore) {
            revert LiquidationDoesNotImproveHealth();
        }
        IERC20(token).safeTransfer(msg.sender, collateralToSeize);
        emit Liquidated(msg.sender, user, token, debtToCover, collateralToSeize);
    }

    /// @return USD value, scaled by 1e18. Vault shares use the underlying asset's price.
    function collateralValue(address token, uint256 amount) public view returns (uint256) {
        _requireSupported(token);
        if (amount == 0) return 0;
        if (token == weth) return Math.mulDiv(amount, priceFeed.getPrice(weth), PRECISION);
        uint256 assets = rwaVault.convertToAssets(amount);
        return Math.mulDiv(assets, priceFeed.getPrice(rwaAsset), PRECISION);
    }

    function accountCollateralValue(address user) public view returns (uint256) {
        return collateralValue(weth, userCollateral[user][weth])
            + collateralValue(address(rwaVault), userCollateral[user][address(rwaVault)]);
    }

    /// @dev Zero debt uses uint256.max as a no-debt sentinel, displayed as N/A in the lab.
    function healthFactor(address user) public view returns (uint256) {
        uint256 debt = userDebt[user];
        if (debt == 0) return type(uint256).max;
        // Round required collateral UP so tiny debt amounts cannot bypass the 150% rule.
        uint256 requiredCollateral = Math.mulDiv(debt, MIN_COLLATERAL_RATIO, PRECISION, Math.Rounding.Ceil);
        return Math.mulDiv(accountCollateralValue(user), PRECISION, requiredCollateral);
    }

    /// @notice Collateral required to cover debt plus the 10% bonus, rounded upward.
    function quoteLiquidation(address token, uint256 debtToCover) public view returns (uint256) {
        _requireSupported(token);
        uint256 usdToSeize = Math.mulDiv(debtToCover, BPS + LIQUIDATION_BONUS_BPS, BPS, Math.Rounding.Ceil);
        if (token == weth) {
            return Math.mulDiv(usdToSeize, PRECISION, priceFeed.getPrice(weth), Math.Rounding.Ceil);
        }
        uint256 assets = Math.mulDiv(usdToSeize, PRECISION, priceFeed.getPrice(rwaAsset), Math.Rounding.Ceil);
        // previewWithdraw rounds shares upward; convertToShares would round downward.
        return rwaVault.previewWithdraw(assets);
    }

    function _repay(address user, address payer, uint256 amount) private {
        if (amount > userDebt[user]) revert RepaymentExceedsDebt();
        userDebt[user] -= amount;
        totalDebt -= amount;
        IERC20(address(stableToken)).safeTransferFrom(payer, address(this), amount);
        stableToken.burn(amount);
        emit DebtRepaid(user, payer, amount);
    }

    function _requireHealthy(address user) private view {
        if (healthFactor(user) < MIN_HEALTH_FACTOR) revert BreachesLiquidationThreshold();
    }

    function _requireSupported(address token) private view {
        if (token != weth && token != address(rwaVault)) revert UnsupportedCollateral(token);
    }

    function _requireNonZero(uint256 amount) private pure {
        if (amount == 0) revert ZeroAmount();
    }
}
