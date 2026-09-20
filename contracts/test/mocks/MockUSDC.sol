// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockUSDC
 * @notice 最小 USDC 替身,**带 Circle FiatTokenV2 的 blocklist / pause 语义**。
 *
 * 为什么不是普通 ERC-20:普通 ERC-20 的 `transfer` 只是改余额,
 * **不调用收款方的任何代码** —— 所以"收款方是拒收合约"这种说法对 ERC-20 根本不成立,
 * 收款方合约无法拒收。USDC 真实会失败的原因是 **Circle 拉黑**和**暂停**。
 *
 * 要真实地测到 `CreatorSplitter` 的 escrow 分支,就必须让替身具备这两种能力。
 */
contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;
    bool public paused;

    /// @dev 置真后,**下一次 `transferFrom` 成功扣款的瞬间**代币进入暂停。
    ///      用于模拟"钱刚拉进合约、Circle 就暂停了"这个夹缝时刻。
    bool public pauseAfterPull;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBlacklisted(address who, bool value) external {
        blacklisted[who] = value;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setPauseAfterPull(bool value) external {
        pauseAfterPull = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _check(msg.sender, to);
        require(balanceOf[msg.sender] >= amount, "USDC: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _check(from, to);
        require(balanceOf[from] >= amount, "USDC: insufficient balance");
        require(allowance[from][msg.sender] >= amount, "USDC: insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        if (pauseAfterPull) {
            pauseAfterPull = false;
            paused = true;
        }
        return true;
    }

    function _check(address from, address to) private view {
        require(!paused, "USDC: paused");
        require(!blacklisted[from] && !blacklisted[to], "USDC: blacklisted");
    }
}
