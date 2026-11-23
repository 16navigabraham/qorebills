// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Spending limits for one token (address(0) is native QOR).
struct TokenConfig {
    address token;
    uint128 autoPayLimit; // the agent pays up to this alone; above it needs the owner's approval
    uint128 maxPerPayment; // hard cap for one payment, even with approval
    uint128 dailyCap; // hard cap per UTC day, approved payments included
}

struct BillerConfig {
    address biller;
    string name;
}

/// @notice Everything an account starts with.
struct AccountConfig {
    address agent;
    uint64 agentExpiry;
    uint32 maxPaymentsPerDay;
    TokenConfig[] tokens;
    BillerConfig[] billers;
}

enum ActionKind {
    SetBiller, // target = biller, name
    RemoveBiller, // target = biller
    SetLimits, // token, a = auto-pay limit, b = max per payment, c = daily cap
    DisableToken, // token
    SetAgent, // target = agent (zero revokes), a = expiry (unix seconds)
    SetMaxPaymentsPerDay, // a = payments per UTC day
    Pause,
    Unpause,
    Withdraw // token, a = amount, target = recipient
}

/// @notice One change to an account, made by the owner directly or by their signed message.
struct OwnerAction {
    ActionKind kind;
    address target;
    address token;
    uint128 a;
    uint128 b;
    uint128 c;
    string name;
}
