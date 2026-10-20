// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract StableCoin is ERC20, Ownable {
    // The owner of this contract will be the lending engine smart contract.
    // The name and the symbol are passed by the deploy script.
    constructor(string memory _name, string memory _symbol, address initialOwner) ERC20(_name, _symbol) Ownable(initialOwner) {}

    function mint(address _to, uint256 _amount) external onlyOwner returns (bool) {
        _mint(_to, _amount);
        return true;
    }

    function burn(address _from, uint256 _amount) external onlyOwner {
        _burn(_from, _amount);
    }
}
