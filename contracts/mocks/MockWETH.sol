// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Local ETH wrapper. Every minted WETH is backed by deposited test ETH.
contract MockWETH is ERC20, ReentrancyGuard {
    error EtherTransferFailed();

    constructor() ERC20("Mock Wrapped Ether", "WETH") {}

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external nonReentrant {
        _burn(msg.sender, amount);
        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert EtherTransferFailed();
    }

    receive() external payable {
        deposit();
    }
}
