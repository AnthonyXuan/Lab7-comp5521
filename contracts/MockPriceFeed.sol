// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Instructor-controlled USD prices, with 18 decimals. Not a live oracle.
contract MockPriceFeed is Ownable {
    mapping(address token => uint256 price) private prices;

    error InvalidPrice();
    error PriceNotSet(address token);

    event PriceUpdated(address indexed token, uint256 oldPrice, uint256 newPrice);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setPrice(address token, uint256 newPrice) external onlyOwner {
        if (token == address(0) || newPrice == 0) revert InvalidPrice();
        uint256 oldPrice = prices[token];
        prices[token] = newPrice;
        emit PriceUpdated(token, oldPrice, newPrice);
    }

    function getPrice(address token) external view returns (uint256) {
        uint256 price = prices[token];
        if (price == 0) revert PriceNotSet(token);
        return price;
    }
}
