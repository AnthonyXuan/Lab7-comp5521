// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Mock Treasury vault. Yield is an actual transfer of mock underlying assets.
contract MockRwaVault is ERC4626, Ownable {
    using SafeERC20 for IERC20;

    error ZeroAmount();

    event YieldAccrued(uint256 assetsAdded, uint256 totalAssetsAfter);

    constructor(IERC20 asset_, address initialOwner)
        ERC20("Mock Treasury Vault Share", "mTBILL")
        ERC4626(asset_)
        Ownable(initialOwner)
    {}

    /// @dev The owner needs assets and must approve the vault before calling.
    ///      No time-based interest, external custody, or real Treasury investment.
    function accrueYield(uint256 assets) external onlyOwner {
        if (assets == 0) revert ZeroAmount();
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);
        emit YieldAccrued(assets, totalAssets());
    }
}
