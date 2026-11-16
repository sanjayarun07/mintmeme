// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Platform-fee wrapper around a Uniswap-V2-style router. UNAUDITED reference implementation, written for this repo's engine; do not deploy with real funds without an independent audit.
/// Fee model (matches the engine's quote): the fee is a fixed share of the INPUT asset, taken before the swap and sent to the treasury in the same transaction (atomic).
///   buy:  ETH in. fee = msg.value * feeBps / 10000 is sent to the treasury, the rest is swapped; the tokens go to `to`.
///   sell: tokens in. The caller approves THIS contract; fee tokens go to the treasury, the rest is swapped to ETH sent to `to`.
/// The contract never holds user funds between transactions and keeps no allowance after a sell (it approves the router for exactly the swapped amount).
interface IV2Router {
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable returns (uint256[] memory);
    function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory);
}

contract FeeRouter {
    address public immutable router;
    address public immutable treasury;
    uint16 public immutable feeBps;
    event Fee(address indexed user, address indexed token, uint256 fee);

    constructor(address router_, address treasury_, uint16 feeBps_) {
        require(feeBps_ <= 500, "fee above 5%");
        require(router_ != address(0) && treasury_ != address(0), "zero address");
        router = router_; treasury = treasury_; feeBps = feeBps_;
    }

    function buy(uint256 minOut, address[] calldata path, address to, uint256 deadline) external payable {
        uint256 fee = msg.value * feeBps / 10000;
        if (fee > 0) { (bool ok,) = treasury.call{value: fee}(""); require(ok, "fee transfer failed"); }
        IV2Router(router).swapExactETHForTokens{value: msg.value - fee}(minOut, path, to, deadline);
        emit Fee(msg.sender, address(0), fee);
    }

    function sell(uint256 amountIn, uint256 minOut, address[] calldata path, address to, uint256 deadline) external {
        address token = path[0];
        uint256 fee = amountIn * feeBps / 10000;
        _call(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amountIn));        // transferFrom (tolerates tokens that return nothing)
        if (fee > 0) _call(token, abi.encodeWithSelector(0xa9059cbb, treasury, fee));                // transfer
        uint256 net = amountIn - fee;
        _call(token, abi.encodeWithSelector(0x095ea7b3, router, net));                               // approve exactly what the router will pull
        IV2Router(router).swapExactTokensForETH(net, minOut, path, to, deadline);
        emit Fee(msg.sender, token, fee);
    }

    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "token call failed");
    }
}
