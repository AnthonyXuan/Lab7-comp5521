// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Lab stablecoin. An administrator connects the engine exactly once.
contract StableToken is ERC20, Ownable {
    address public engine;

    error OnlyEngine();
    error EngineAlreadySet();
    error InvalidEngine();

    event EngineSet(address indexed engine);

    constructor(address initialOwner) ERC20("Lab Stablecoin", "LABUSD") Ownable(initialOwner) {}

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    function setEngine(address engine_) external onlyOwner {
        if (engine != address(0)) revert EngineAlreadySet();
        if (engine_.code.length == 0) revert InvalidEngine();
        engine = engine_;
        emit EngineSet(engine_);
    }

    function mint(address to, uint256 amount) external onlyEngine {
        _mint(to, amount);
    }

    /// @dev The engine first collects the payer's tokens using transferFrom.
    function burn(uint256 amount) external onlyEngine {
        _burn(msg.sender, amount);
    }
}
