/** Trading primitives: approvals, market and limit orders, fill detection and cancellation. */
import { setTimeout as sleep } from 'node:timers/promises'
import { OrderKind, type TradeParameters } from '@cowprotocol/cow-sdk'
import {
  domainSeparator,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  maxUint256,
  parseAbi,
  parseSignature,
  zeroHash,
  type Address,
  type Hex,
} from 'viem'
import { describe, type Context, type Token } from './context.js'

// CoW only auto-refunds expired native-sell orders whose slippage is at least this
export const ETH_FLOW_AUTO_REFUND_BPS = 200
const PLACEHOLDER_PERMIT_GAS = 80_000n
const POLL_INTERVAL_MS = 5_000
// Keep checking a little past expiry, in case the fill landed in the last block
const EXPIRY_GRACE_MS = 30_000

const PERMIT_ABI = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
])
const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const
const SETTLEMENT_ABI = parseAbi([
  'function filledAmount(bytes orderUid) view returns (uint256)',
  'event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)',
])

const ETH_FLOW_ABI = parseAbi([
  'struct EthFlowOrder { address buyToken; address receiver; uint256 sellAmount; uint256 buyAmount; bytes32 appData; uint256 feeAmount; uint32 validTo; bool partiallyFillable; int64 quoteId; }',
  'function invalidateOrder(EthFlowOrder order)',
])

export interface Trade {
  sell: Token
  buy: Token
  /** Amount of the sell token, in its smallest unit. */
  amount: bigint
  /** Order lifetime in seconds. */
  validFor: number
}

export interface Approval {
  allowance: bigint
  needed: boolean
  usePermit: boolean
}

export interface PlacedOrder {
  orderId: string
  /** A block from before the order existed; fills are searched for from here. */
  startBlock: bigint
  minBuy: bigint
  /** Expiry as a millisecond timestamp. */
  expiresAt: number
}

/** The fields that identify a native-sell order inside CoW's EthFlow contract. */
export interface EthFlowOrder {
  buyToken: Address
  receiver: Address
  sellAmount: bigint
  buyAmount: bigint
  appData: Hex
  feeAmount: bigint
  validTo: number
}

export interface Fill {
  /** Amount actually received; unknown if the RPC could not return the Trade event. */
  buyAmount?: bigint
  txHash?: Hex
}

export const fmt = (value: bigint, token: Token) => `${formatUnits(value, token.decimals)} ${token.symbol}`

export function balanceOf(ctx: Context, token: Token): Promise<bigint> {
  return token.isNative
    ? ctx.client.getBalance({ address: ctx.owner })
    : ctx.client.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.owner] })
}

// An order UID is the order digest (32 bytes) + owner (20 bytes) + validTo (4 bytes)
const orderOwner = (orderId: string) => getAddress(`0x${orderId.slice(66, 106)}`)

// ---------- Approvals ----------

export async function checkApproval(ctx: Context, sell: Token, amount: bigint): Promise<Approval> {
  // Native sells go through CoW's EthFlow contract and need no token approval
  if (sell.isNative) return { allowance: amount, needed: false, usePermit: false }
  const allowance = await ctx.sdk.getCowProtocolAllowance({ tokenAddress: sell.address, owner: ctx.owner })
  const needed = allowance < amount
  return { allowance, needed, usePermit: needed && ctx.approvalMode === 'permit' }
}

export function describeApproval(ctx: Context, sell: Token, approval: Approval): string {
  if (sell.isNative) {
    return `not needed; each order is an on-chain transaction (needs gas) that moves the ${sell.symbol} into CoW's EthFlow contract`
  }
  if (!approval.needed) return 'already sufficient'
  return approval.usePermit ? 'off-chain permit signature (gasless)' : `on-chain approve transaction (${ctx.owner} pays gas)`
}

// Approve via an EIP-2612 permit attached to the order as a pre-hook, instead of an on-chain approve.
// With sign=false this builds a placeholder hook for fee estimation only and signs nothing.
async function buildPermitHook(ctx: Context, trade: Trade, sign: boolean) {
  const { sell, amount } = trade
  const { client, owner, relayer } = ctx
  const token = { address: sell.address, abi: PERMIT_ABI } as const
  const [name, version, nonce, onchainSeparator] = await Promise.all([
    client.readContract({ ...token, functionName: 'name' }),
    client.readContract({ ...token, functionName: 'version' }).catch(() => '1'),
    client.readContract({ ...token, functionName: 'nonces', args: [owner] }),
    client.readContract({ ...token, functionName: 'DOMAIN_SEPARATOR' }),
  ]).catch(() => {
    throw new Error(`Could not read permit data for ${sell.symbol}; it probably does not support EIP-2612. Set APPROVAL_MODE=approve`)
  })

  const domain = { name, version, chainId: ctx.chainId, verifyingContract: sell.address }
  if (domainSeparator({ domain }) !== onchainSeparator) {
    throw new Error(`${sell.symbol} uses a non-standard permit domain. Set APPROVAL_MODE=approve`)
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + trade.validFor + 600)
  let v = 27
  let r: Hex = zeroHash
  let s: Hex = zeroHash
  if (sign) {
    const signature = await ctx.account.signTypedData({
      domain,
      types: PERMIT_TYPES,
      primaryType: 'Permit',
      message: { owner, spender: relayer, value: amount, nonce, deadline },
    })
    const parsed = parseSignature(signature)
    v = 27 + parsed.yParity
    r = parsed.r
    s = parsed.s
  }
  const callData = encodeFunctionData({
    abi: PERMIT_ABI,
    functionName: 'permit',
    args: [owner, relayer, amount, deadline, v, r, s],
  })
  // Simulate the signed permit now, so a bad signature fails here rather than leaving an order that never fills
  const gasLimit = sign
    ? await client.estimateGas({ to: sell.address, data: callData }).catch(() => {
        throw new Error(`Permit simulation failed for ${sell.symbol}. Set APPROVAL_MODE=approve`)
      })
    : PLACEHOLDER_PERMIT_GAS
  return { target: sell.address, callData, gasLimit: gasLimit.toString() }
}

async function sendApproval(ctx: Context, sell: Token, value: bigint) {
  console.log(`\nSending approval transaction (${fmt(value, sell)} to the CoW Vault Relayer)...`)
  const hash = (await ctx.sdk.approveCowProtocol({ tokenAddress: sell.address, amount: value })) as Hex
  console.log(`  ${ctx.txUrl(hash)}`)
  // Wait one extra confirmation so CoW's nodes have seen the approval before the order arrives
  const receipt = await ctx.client.waitForTransactionReceipt({ hash, confirmations: 2 })
  if (receipt.status !== 'success') throw new Error('Approval transaction failed; no order was placed')
  console.log('  Approval confirmed')
}

/** Raises the Vault Relayer's allowance to exactly `amount` with an on-chain transaction. */
export async function approveOnChain(ctx: Context, sell: Token, amount: bigint, allowance: bigint) {
  // Tokens like USDT reject changing a non-zero allowance to another non-zero value; reset to zero first if so
  const approveCall = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ctx.relayer, amount] })
  const mustResetFirst =
    allowance > 0n &&
    (await ctx.client.call({ account: ctx.owner, to: sell.address, data: approveCall }).then(
      () => false,
      () => true,
    ))
  if (mustResetFirst) await sendApproval(ctx, sell, 0n)
  await sendApproval(ctx, sell, amount)
}

const withPermitHook = (hook?: Awaited<ReturnType<typeof buildPermitHook>>) =>
  hook ? { appData: { metadata: { hooks: { pre: [hook] } } } } : undefined

// ---------- Orders ----------

/**
 * Quotes a market order. Nothing is signed for the order itself until `place()` is called;
 * with sign=true and permit approval, the permit is signed here so the quote can include it.
 */
export async function prepareMarketOrder(ctx: Context, trade: Trade, sign: boolean) {
  const { sell, buy, amount, validFor } = trade
  const approval = await checkApproval(ctx, sell, amount)
  const permitHook = approval.usePermit ? await buildPermitHook(ctx, trade, sign) : undefined
  const params: TradeParameters = {
    kind: OrderKind.SELL,
    sellToken: sell.address,
    sellTokenDecimals: sell.decimals,
    buyToken: buy.address,
    buyTokenDecimals: buy.decimals,
    amount: amount.toString(),
    receiver: ctx.recipient,
    slippageBps: ctx.slippageBps,
    validFor,
  }
  const { quoteResults, postSwapOrderFromQuote } = await ctx.sdk.getQuote(params, withPermitHook(permitHook)).catch((error) => {
    throw new Error(`Quote failed: ${describe(error)}`)
  })
  const { afterPartnerFees, afterSlippage, costs } = quoteResults.amountsAndCosts

  return {
    approval,
    expected: afterPartnerFees.buyAmount,
    minimum: afterSlippage.buyAmount,
    networkFee: costs.networkFee.amountInSellCurrency,
    async place(): Promise<PlacedOrder> {
      if (approval.needed && !approval.usePermit) await approveOnChain(ctx, sell, amount, approval.allowance)
      const startBlock = await ctx.client.getBlockNumber()
      console.log(sell.isNative ? '\nSending order transaction...' : '\nSigning and submitting order...')
      const { orderId, orderToSign, txHash } = await postSwapOrderFromQuote().catch((error) => {
        throw new Error(`Order failed: ${describe(error)}`)
      })
      if (txHash) {
        console.log(`  ${ctx.txUrl(txHash)}`)
        const receipt = await ctx.client.waitForTransactionReceipt({ hash: txHash as Hex })
        if (receipt.status !== 'success') {
          throw new Error(`Order transaction reverted; no ${sell.symbol} left the wallet (only gas was spent)`)
        }
      }
      return { orderId, startBlock, minBuy: BigInt(orderToSign.buyAmount), expiresAt: Number(orderToSign.validTo) * 1000 }
    },
  }
}

/** Places a limit order: sell `trade.amount` for at least `buyAmount`, exactly as given. */
export async function placeLimitOrder(ctx: Context, trade: Trade, buyAmount: bigint, approval: Approval): Promise<PlacedOrder> {
  const { sell, buy, amount, validFor } = trade
  const permitHook = approval.usePermit ? await buildPermitHook(ctx, trade, true) : undefined
  if (approval.needed && !approval.usePermit) await approveOnChain(ctx, sell, amount, approval.allowance)
  const startBlock = await ctx.client.getBlockNumber()
  console.log('\nSigning and submitting order...')
  const { orderId, orderToSign } = await ctx.sdk
    .postLimitOrder(
      {
        kind: OrderKind.SELL,
        sellToken: sell.address,
        sellTokenDecimals: sell.decimals,
        buyToken: buy.address,
        buyTokenDecimals: buy.decimals,
        sellAmount: amount.toString(),
        buyAmount: buyAmount.toString(),
        receiver: ctx.recipient,
        validFor,
      },
      withPermitHook(permitHook),
    )
    .catch((error) => {
      throw new Error(`Order failed: ${describe(error)}`)
    })
  return { orderId, startBlock, minBuy: BigInt(orderToSign.buyAmount), expiresAt: Number(orderToSign.validTo) * 1000 }
}

/**
 * Waits until the order is filled, cancelled or expired.
 *
 * The fill is read from the settlement contract, not the CoW API: the API rate-limits status
 * polling (HTTP 429), and the chain is the source of truth anyway.
 */
export async function waitForFill(ctx: Context, order: PlacedOrder): Promise<Fill | 'cancelled' | 'expired'> {
  const settlement = { address: ctx.settlement, abi: SETTLEMENT_ABI } as const
  let lastError = ''
  while (Date.now() < order.expiresAt + EXPIRY_GRACE_MS) {
    await sleep(POLL_INTERVAL_MS)
    const filled = await ctx.client
      .readContract({ ...settlement, functionName: 'filledAmount', args: [order.orderId as Hex] })
      .catch((error) => {
        const message = describe(error)
        if (message !== lastError) console.log(`  status check failed (${message}), retrying`)
        lastError = message
        return 0n
      })
    if (filled === 0n) continue
    // The settlement contract marks a cancelled order by setting its filled amount to the maximum
    if (filled === maxUint256) return 'cancelled'

    // The Trade event carries the amount actually received
    const trades = await ctx.client
      .getContractEvents({
        ...settlement,
        eventName: 'Trade',
        args: { owner: orderOwner(order.orderId) },
        fromBlock: order.startBlock,
      })
      .catch(() => [])
    const trade = trades.find((log) => log.args.orderUid?.toLowerCase() === order.orderId.toLowerCase())
    return { buyAmount: trade?.args.buyAmount, txHash: trade?.transactionHash }
  }
  return 'expired'
}

/**
 * Cancels a native-sell order in the EthFlow contract, which also sends the unsold native currency
 * back to whoever placed it. The order's creator can do this at any time, anyone once it has expired.
 */
export async function invalidateEthFlowOrder(ctx: Context, order: EthFlowOrder): Promise<Hex> {
  // Sent with viem directly: the SDK's own on-chain cancel encodes a zero value that nodes reject
  const hash = await ctx.wallet.writeContract({
    address: ctx.ethFlow,
    abi: ETH_FLOW_ABI,
    functionName: 'invalidateOrder',
    // quoteId is not part of the order's identity, and this tool only places fill-or-kill orders
    args: [{ ...order, partiallyFillable: false, quoteId: 0n }],
  })
  console.log(`  ${ctx.txUrl(hash)}`)
  const receipt = await ctx.client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('Cancellation transaction reverted')
  return hash
}

/** Cancels an open order and returns a sentence describing what happened. */
export async function cancelOrder(ctx: Context, orderId: string): Promise<string> {
  const filled = await ctx.client.readContract({
    address: ctx.settlement,
    abi: SETTLEMENT_ABI,
    functionName: 'filledAmount',
    args: [orderId as Hex],
  })
  if (filled === maxUint256) throw new Error('This order is already cancelled')
  if (filled > 0n) throw new Error('This order is already filled; there is nothing to cancel')

  const owner = orderOwner(orderId)
  if (!isAddressEqual(owner, ctx.ethFlow)) {
    if (!isAddressEqual(owner, ctx.owner)) throw new Error(`This order belongs to ${owner}, not OWNER_ADDRESS (${ctx.owner})`)
    await ctx.sdk.offChainCancelOrder({ orderUid: orderId })
    return 'Order cancelled (off-chain, no gas). A fill already in progress can still go through'
  }

  // Native-sell orders are owned by the EthFlow contract and can only be cancelled on-chain
  const order = await ctx.sdk.getOrder({ orderUid: orderId }).catch((error) => {
    throw new Error(`Could not load the order from the CoW API (${describe(error)}); try again in a minute`)
  })
  console.log('Sending cancellation transaction...')
  await invalidateEthFlowOrder(ctx, {
    buyToken: getAddress(order.buyToken),
    receiver: getAddress(order.receiver ?? order.owner),
    sellAmount: BigInt(order.sellAmount),
    buyAmount: BigInt(order.buyAmount),
    appData: order.appData as Hex,
    feeAmount: BigInt(order.feeAmount),
    validTo: order.validTo,
  })
  return `Order cancelled; the unsold ${ctx.nativeSymbol} was returned to the address that placed it`
}
