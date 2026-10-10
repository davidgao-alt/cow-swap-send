# cow-swap-send

Trade any token for any token on [CoW Protocol](https://cow.fi) and have the proceeds delivered straight to a different address.

Address A signs the order and sells; address B receives what was bought. There is no intermediate transfer. Market orders, limit orders and a simple TWAP are supported.

## How it works

A CoW Protocol order has a `receiver` field. Address A signs an order that names address B as the receiver, and CoW's settlement contract pays B directly when the order fills. The receiver is part of the signed order, so nobody can change it afterwards.

Orders are signed off-chain and executed by CoW's solvers. The network fee is taken out of the trade, so placing an order costs no gas. Gas is only needed for a one-time token approval, and that can be avoided too (see [Approval modes](#approval-modes)).

Fills are detected by reading the settlement contract through your RPC, not the CoW API, whose rate limits make status polling unreliable.

## Requirements

Node.js 20.12 or newer.

## Setup

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in the three required values in `.env`:

| Setting | Meaning |
|---|---|
| `OWNER_ADDRESS` | Address A: the wallet that holds the tokens to sell |
| `PRIVATE_KEY` | Private key of address A, used to sign orders locally |
| `RECIPIENT` | Address B: where the bought tokens are delivered |

## Commands

```
npm run quote  -- <amount> <sell> <buy>                       market quote only, nothing is signed
npm run swap   -- <amount> <sell> <buy>                       market order
npm run limit  -- <amount> <sell> <buy> <minBuy>              limit order
npm run twap   -- <amount> <sell> <buy> <parts> <interval>    TWAP
npm run cancel -- <orderId>                                   cancel an open order
```

- **Tokens** are given as a symbol or a contract address. Symbols are looked up in the [CoW Swap token list](https://files.cow.fi/tokens/CowSwap.json); use the contract address for anything not on it. The chain's native symbol (`ETH` on Ethereum) means the native currency.
- **Amount** is how much of the sell token to sell, in token units. `max` sells the whole balance.
- Every command that places something shows a summary first and asks you to type `yes`. `--yes` skips the prompt.

The summary prints the contract address of both tokens. Check them before confirming.

### Market orders

```bash
npm run quote -- 250 DAI WBTC
```

```
Network       Ethereum (1)
Sell          250 DAI  [0x6B175474E89094C44Da98b954EedeAC495271d0F]
              from 0xAAAA…, balance 1200 DAI
Buy           WBTC  [0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599]
Expected      0.00302721 WBTC
Minimum       0.00301208 WBTC  (slippage 0.5%)
Recipient     0xBBBB…
Network fee   ~0.313153 DAI (already deducted from the amounts above)
Approval      on-chain approve transaction (0xAAAA… pays gas)
Valid for     30m

Quote only; no order was placed. To place it, run: npm run swap -- 250 DAI WBTC
```

`swap` shows the same quote, places the order and waits for it to fill.

```bash
npm run swap -- 0.2 ETH USDC
```

### Limit orders

Sell an amount for at least `<minBuy>` of the buy token. The order stays open until the market reaches that price or the order expires.

```bash
npm run limit -- 1000 USDC WETH 0.5
```

```bash
npm run limit -- 0.1 WBTC USDT 12000 --valid 12h
```

- The summary shows your limit price and how far it is from the current market.
- Limit orders are fill-or-kill and valid for 7 days unless you pass `--valid` (for example `12h` or `30d`).
- The network fee comes out of the surplus, so the order fills once the market beats your limit by enough to cover it.
- The command returns as soon as the order is placed. Follow it on CoW Explorer, or cancel it with `npm run cancel`.
- Native ETH cannot be sold with a limit order; sell WETH instead.

### TWAP

Split a sale into equal market orders placed one interval apart.

```bash
npm run twap -- 1000 USDC ETH 5 10m
```

This sells 200 USDC every 10 minutes, five times. Each part gets a fresh quote and its own slippage protection, and the script prints a running log and a final average price.

CoW's own TWAP orders only work from a Safe wallet, so for a plain private-key wallet **this TWAP is run by the script**:

- Keep the script running until the last part is placed. Ctrl+C stops any further parts; an order already placed stays open until it fills or expires.
- A part that fails or expires unfilled is logged and skipped; the remaining parts still run.
- The interval must be at least 2 minutes. Each part expires before the next one is due.
- With `APPROVAL_MODE=approve`, the full amount is approved once up front.

### Cancelling

```bash
npm run cancel -- 0x<orderId>
```

Ordinary orders are cancelled off-chain for free. Orders that sell native ETH are cancelled with an on-chain transaction, which also returns the unsold ETH.

## Configuration

Optional settings in `.env`:

| Setting | Default | Meaning |
|---|---|---|
| `CHAIN_ID` | `1` | Ethereum mainnet. Base, Arbitrum, Gnosis, Polygon, BNB, Avalanche, Linea and Sepolia also work |
| `RPC_URL` | public node | Your own endpoint is recommended; public nodes may be rate limited |
| `SLIPPAGE_BPS` | `50` | Slippage tolerance for market orders, in basis points (50 = 0.5%) |
| `VALID_FOR_SECONDS` | `1800` | Market order lifetime; an unfilled order expires after this |
| `APPROVAL_MODE` | `approve` | See below |

## Approval modes

Before CoW can sell an ERC-20 token, address A must approve CoW's Vault Relayer contract to spend it. The script approves exactly the amount being sold, never an unlimited allowance.

- `approve` sends an on-chain approve transaction. Address A needs native currency for gas. Works with every token.
- `permit` signs an off-chain [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612) permit that is executed together with the order, so address A needs no gas at all. Only works with tokens that support it, such as USDC. USDT and DAI do not; the script tells you to switch back to `approve`.

## Selling the native currency

Selling native ETH needs no approval, but each order is an on-chain transaction paid by address A. The ETH moves into CoW's EthFlow contract and waits there until the order fills.

If the order expires unfilled, CoW refunds the ETH to address A automatically only when the slippage tolerance was at least 2%. Below that, get it back with `npm run cancel -- <orderId>`, which costs gas. When selling ETH, set `SLIPPAGE_BPS=200`, or sell WETH instead.

## Notes

- `.env` holds a private key. Never share it or commit it; it is listed in `.gitignore`.
- Try a small amount first.
- If address B is a contract and you are buying native ETH, the order may never fill: CoW sends ETH with a 2300 gas stipend, which is not enough for contracts with a heavier receive function. The script warns about this; buy WETH instead if unsure.
- An ERC-20 order that expires or is cancelled spends nothing.
- Fee-on-transfer and rebasing tokens are poorly supported by CoW and may not fill.

## Code layout

| File | Contents |
|---|---|
| `src/cli.ts` | Argument parsing, the five commands, summaries and prompts |
| `src/orders.ts` | Approvals, market and limit orders, fill detection, cancellation |
| `src/context.ts` | Configuration, clients and token lookup |

## Disclaimer

This is an unaudited script that signs orders with a raw private key. Use it at your own risk.
