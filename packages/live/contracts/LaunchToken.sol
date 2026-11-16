// SPDX-License-Identifier: MIT
// TEST FIXTURE ONLY (never deploy for real use). A minimal ERC-20 whose trading stays closed until `openAt` for everyone except its owner,
// so the sniper can be tested against a real "trading not enabled" revert on a local fork. No taxes, no blacklist.
pragma solidity ^0.8.20;
contract LaunchToken {
    string public name = "Launch"; string public symbol = "LCH"; uint8 public decimals = 18; uint256 public totalSupply;
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    uint256 public openAt; address public owner;
    event Transfer(address indexed from, address indexed to, uint256 value); event Approval(address indexed o, address indexed s, uint256 v);
    constructor(uint256 s) { totalSupply = s; balanceOf[msg.sender] = s; owner = msg.sender; emit Transfer(address(0), msg.sender, s); }
    function setOpen(uint256 blockNumber) external { require(msg.sender == owner); openAt = blockNumber; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
    function _t(address f, address to, uint256 v) internal {
        require(openAt == 0 || block.number >= openAt || f == owner || to == owner || tx.origin == owner, "trading not enabled");   // tx.origin: lets the owner's own router calls through
        require(balanceOf[f] >= v, "bal"); balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v);
    }
    function transfer(address to, uint256 v) external returns (bool) { _t(msg.sender, to, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender]; if (a != type(uint256).max) { require(a >= v, "allow"); allowance[f][msg.sender] = a - v; }
        _t(f, to, v); return true;
    }
}
