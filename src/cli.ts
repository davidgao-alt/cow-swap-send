/**
 * cow-swap-send: trade any token for any token on CoW Protocol and deliver the proceeds
 * to another address. Run with --help for usage.
 */
import { createInterface } from 'node:readline/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { formatUnits, isAddressEqual, parseUnits } from 'viem'
import { createContext, describe, resolveToken, type Context, type Token } from './context.js'
import {
  ETH_FLOW_AUTO_REFUND_BPS,
  approveOnChain,
  balanceOf,
  cancelOrder,
  checkApproval,
  describeApproval,
  fmt,
  placeLimitOrder,
  prepareMarketOrder,
  waitForFill,
  type Approval,
  type Fill,
  type PlacedOrder,
} from './orders.js'

const DEFAULT_LIMIT_VALIDITY = '7d'
const MIN_TWAP_INTERVAL = 120
const MAX_TWAP_PARTS = 100
const FLAGS = ['--yes', '--help', '-h']

const USAGE = `Usage:
  npm run quote  -- <amount> <sell> <buy>                       market quote only, nothing is signed
  npm run swap   -- <amount> <sell> <buy>                       market order
  npm run limit  -- <amount> <sell> <buy> <minBuy>              limit order: sell <amount> for at least <minBuy>
  npm run twap   -- <amount> <sell> <buy> <parts> <interval>    <parts> market orders, one every <interval>
  npm run cancel -- <orderId>                                   cancel an open order

  <amount>     amount of the sell token to sell in total, or "max" for the whole balance
  <sell> <buy> token symbol or contract address
  <minBuy>     least amount of the buy token to accept for the whole order
  <interval>   time between TWAP parts, e.g. 10m or 2h (at least ${MIN_TWAP_INTERVAL / 60}m)

Symbols are looked up in the CoW Swap token list. Use the chain's native symbol
(e.g. ETH) for the native currency, and a contract address for unlisted tokens.

Options:
  --valid <duration>  limit order lifetime, e.g. 12h or 7d (default ${DEFAULT_LIMIT_VALIDITY})
  --yes               skip the confirmation prompt
  --help              show this message`

interface LoadedTrade {
  sell: Token
  buy: Token
  amount: bigint
  balance: bigint
  nativeBalance: bigint
  recipientIsContract: boolean
}

// ---------- Helpers ----------

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const flags = new Set<string>()
  let valid: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--valid') valid = argv[++i] ?? ''
    else if (!arg.startsWith('-')) positional.push(arg)
    else if (FLAGS.includes(arg)) flags.add(arg)
    else throw new Error(`Unknown option: ${arg}\n\n${USAGE}`)
  }
  const [command, ...rest] = positional
  return { command, args: rest, valid, yes: flags.has('--yes'), help: flags.has('--help') || flags.has('-h') }
}

function requireArgs(args: string[], count: number) {
  if (args.length !== count) throw new Error(USAGE)
}

function parseDuration(text: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(text.toLowerCase())
  if (!match) throw new Error(`Not a duration: "${text}". Use e.g. 90s, 10m, 2h or 7d`)
  return Number(match[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]]!
}

function formatDuration(seconds: number): string {
  const units: [string, number][] = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]
  const parts: string[] = []
  for (const [unit, size] of units) {
    const count = Math.floor(seconds / size)
    if (count) parts.push(`${count}${unit}`)
    seconds -= count * size
  }
  return parts.join(' ') || '0s'
}

function parseAmount(text: string, token: Token, name: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`${name} must be a number (e.g. 100 or 12.5), got: ${text}`)
  return parseUnits(text, token.decimals)
}

/** "1 WETH = 2,480.5 USDC" for a trade of `sellAmount` into `buyAmount`. */
function price(sellAmount: bigint, sell: Token, buyAmount: bigint, buy: Token): string {
  const rate = Number(formatUnits(buyAmount, buy.decimals)) / Number(formatUnits(sellAmount, sell.decimals))
  const show = (value: number) => value.toLocaleString('en-US', { maximumSignificantDigits: 6 })
  return `1 ${sell.symbol} = ${show(rate)} ${buy.symbol}  (1 ${buy.symbol} = ${show(1 / rate)} ${sell.symbol})`
}

const tokenLabel = (token: Token) => (token.isNative ? 'native' : token.address)

function printRows(rows: [string, string][]) {
  console.log(`\n${rows.map(([label, value]) => label.padEnd(14) + value).join('\n')}`)
}

async function confirm(question: string, skip: boolean) {
  if (skip) return
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`\n${question} Type "yes" to continue: `)
  rl.close()
  if (answer.trim().toLowerCase() !== 'yes') throw new Error('Cancelled; nothing was placed')
}

async function loadTrade(ctx: Context, amountArg: string, sellArg: string, buyArg: string): Promise<LoadedTrade> {
  const sell = await resolveToken(ctx, sellArg)
  const buy = await resolveToken(ctx, buyArg)
  if (isAddressEqual(sell.address, buy.address)) throw new Error('Sell and buy tokens must be different')

  const [balance, nativeBalance, recipientCode] = await Promise.all([
    balanceOf(ctx, sell),
    ctx.client.getBalance({ address: ctx.owner }),
    ctx.client.getCode({ address: ctx.recipient }),
  ]).catch((error) => {
    throw new Error(`Could not read on-chain data. Check RPC_URL and CHAIN_ID: ${describe(error)}`)
  })

  const sellAll = amountArg.toLowerCase() === 'max'
  if (sellAll && sell.isNative) {
    throw new Error(`"max" is not supported when selling ${sell.symbol} (some must be left for gas); give an exact amount`)
  }
  const amount = sellAll ? balance : parseAmount(amountArg, sell, 'Amount')
  if (amount <= 0n) throw new Error(`Sell amount is zero (balance of ${ctx.owner}: ${fmt(balance, sell)})`)
  return { sell, buy, amount, balance, nativeBalance, recipientIsContract: !!recipientCode && recipientCode !== '0x' }
}

function assertFunds(ctx: Context, t: LoadedTrade, approval: Approval) {
  if (t.sell.isNative ? t.balance <= t.amount : t.balance < t.amount) {
    throw new Error(
      `Insufficient ${t.sell.symbol}: balance ${fmt(t.balance, t.sell)}, selling ${fmt(t.amount, t.sell)}${t.sell.isNative ? ' plus gas' : ''}`,
    )
  }
  if (approval.needed && !approval.usePermit && t.nativeBalance === 0n) {
    throw new Error(
      `${ctx.owner} has no ${ctx.nativeSymbol} to pay gas for the approval. Set APPROVAL_MODE=permit (gasless) or fund the address`,
    )
  }
}

function tradeRows(ctx: Context, t: LoadedTrade): [string, string][] {
  return [
    ['Network', `${ctx.chain.name} (${ctx.chainId})`],
    ['Sell', `${fmt(t.amount, t.sell)}  [${tokenLabel(t.sell)}]`],
    ['', `from ${ctx.owner}, balance ${fmt(t.balance, t.sell)}`],
    ['Buy', `${t.buy.symbol}  [${tokenLabel(t.buy)}]`],
  ]
}

function printWarnings(ctx: Context, t: LoadedTrade) {
  if (isAddressEqual(ctx.recipient, ctx.owner)) {
    console.log('\n⚠ RECIPIENT equals OWNER_ADDRESS: the proceeds go back to the selling address.')
  }
  if (t.buy.isNative && t.recipientIsContract) {
    console.log(
      `\n⚠ The recipient is a contract. CoW sends ${t.buy.symbol} with a 2300 gas stipend, so the order can never fill ` +
        `if the contract needs more gas to receive it. If unsure, buy W${t.buy.symbol} instead.`,
    )
  }
  if (t.sell.isNative && ctx.slippageBps < ETH_FLOW_AUTO_REFUND_BPS) {
    console.log(
      `\n⚠ CoW only refunds an unfilled ${t.sell.symbol} order automatically when slippage is at least ` +
        `${ETH_FLOW_AUTO_REFUND_BPS / 100}%. Below that you reclaim it with "npm run cancel -- <orderId>", which costs gas. ` +
        `Set SLIPPAGE_BPS=${ETH_FLOW_AUTO_REFUND_BPS} for automatic refunds.`,
    )
  }
  if (t.balance < t.amount) console.log(`\n⚠ Insufficient ${t.sell.symbol} balance; this cannot be placed right now.`)
}

/** What happens to the sell token when an order ends without filling. */
function unfilledOutcome(ctx: Context, sell: Token, orderId: string): string {
  if (!sell.isNative) return 'no tokens were spent'
  return ctx.slippageBps >= ETH_FLOW_AUTO_REFUND_BPS
    ? `CoW refunds the ${sell.symbol} to ${ctx.owner} automatically`
    : `reclaim the ${sell.symbol} with: npm run cancel -- ${orderId}`
}

function describeFill(ctx: Context, buy: Token, order: PlacedOrder, fill: Fill): string {
  const received = fill.buyAmount !== undefined ? fmt(fill.buyAmount, buy) : `at least ${fmt(order.minBuy, buy)}`
  return `${ctx.recipient} received ${received}`
}

// ---------- Commands ----------

async function swapCommand(ctx: Context, args: string[], execute: boolean, skipConfirm: boolean) {
  requireArgs(args, 3)
  const t = await loadTrade(ctx, args[0], args[1], args[2])
  const order = await prepareMarketOrder(ctx, { sell: t.sell, buy: t.buy, amount: t.amount, validFor: ctx.validFor }, execute)
  if (execute) assertFunds(ctx, t, order.approval)

  printRows([
    ...tradeRows(ctx, t),
    ['Expected', fmt(order.expected, t.buy)],
    ['Minimum', `${fmt(order.minimum, t.buy)}  (slippage ${ctx.slippageBps / 100}%)`],
    ['Recipient', ctx.recipient],
    ['Network fee', `~${fmt(order.networkFee, t.sell)} (already deducted from the amounts above)`],
    ['Approval', describeApproval(ctx, t.sell, order.approval)],
    ['Valid for', formatDuration(ctx.validFor)],
  ])
  printWarnings(ctx, t)
  if (!execute) {
    console.log(`\nQuote only; no order was placed. To place it, run: npm run swap -- ${args.join(' ')}`)
    return
  }

  await confirm('Place this order?', skipConfirm)
  const placed = await order.place()
  console.log(`Order submitted: ${placed.orderId}`)
  console.log(`Minimum received: ${fmt(placed.minBuy, t.buy)}`)
  if (ctx.orderUrl(placed.orderId)) console.log(`Track it: ${ctx.orderUrl(placed.orderId)}`)

  console.log('\nWaiting for the order to fill (Ctrl+C is safe; the order stays open)...')
  const result = await waitForFill(ctx, placed)
  if (result === 'cancelled') throw new Error('Order was cancelled; nothing was bought')
  if (result === 'expired') throw new Error(`Order expired unfilled: ${unfilledOutcome(ctx, t.sell, placed.orderId)}`)
  console.log(`✓ Filled: ${describeFill(ctx, t.buy, placed, result)}`)
  if (result.txHash) console.log(`  ${ctx.txUrl(result.txHash)}`)
}

async function limitCommand(ctx: Context, args: string[], valid: string | undefined, skipConfirm: boolean) {
  requireArgs(args, 4)
  const t = await loadTrade(ctx, args[0], args[1], args[2])
  if (t.sell.isNative) {
    throw new Error(`Limit orders cannot sell native ${t.sell.symbol}. Sell W${t.sell.symbol} instead`)
  }
  const minBuy = parseAmount(args[3], t.buy, 'Minimum buy amount')
  if (minBuy <= 0n) throw new Error('Minimum buy amount must be greater than zero')
  const validFor = parseDuration(valid ?? DEFAULT_LIMIT_VALIDITY)
  const trade = { sell: t.sell, buy: t.buy, amount: t.amount, validFor }

  const approval = await checkApproval(ctx, t.sell, t.amount)
  assertFunds(ctx, t, approval)
  // A market quote for the same amount, only to show how far the limit is from the current price
  const market = await prepareMarketOrder(ctx, { ...trade, validFor: ctx.validFor }, false).catch(() => undefined)
  const marketRow: [string, string][] = []
  if (market) {
    const gap = (Number(minBuy - market.expected) / Number(market.expected)) * 100
    const comparison =
      gap > 0 ? `your limit is ${gap.toFixed(2)}% above it` : 'your limit is at or below it, so it should fill right away'
    marketRow.push(['Market now', `${fmt(market.expected, t.buy)} after costs; ${comparison}`])
  }

  printRows([
    ['Order type', 'limit (fill-or-kill)'],
    ...tradeRows(ctx, t),
    ['At least', fmt(minBuy, t.buy)],
    ['Limit price', price(t.amount, t.sell, minBuy, t.buy)],
    ...marketRow,
    ['Recipient', ctx.recipient],
    ['Network fee', 'taken from the surplus, so it fills once the market beats your limit by enough to cover it'],
    ['Approval', describeApproval(ctx, t.sell, approval)],
    ['Valid for', formatDuration(validFor)],
  ])
  printWarnings(ctx, t)

  await confirm('Place this limit order?', skipConfirm)
  const placed = await placeLimitOrder(ctx, trade, minBuy, approval)
  console.log(`Order submitted: ${placed.orderId}`)
  if (ctx.orderUrl(placed.orderId)) console.log(`Track it: ${ctx.orderUrl(placed.orderId)}`)
  console.log(`\nThe order stays open until it fills or expires. To cancel it: npm run cancel -- ${placed.orderId}`)
}

// A TWAP driven by this script: CoW's own TWAP orders need a Safe wallet, so for a plain
// private-key wallet the total is split into market orders placed one interval apart.
async function twapCommand(ctx: Context, args: string[], skipConfirm: boolean) {
  requireArgs(args, 5)
  const t = await loadTrade(ctx, args[0], args[1], args[2])
  const parts = Number(args[3])
  if (!Number.isInteger(parts) || parts < 2 || parts > MAX_TWAP_PARTS) {
    throw new Error(`Parts must be a whole number from 2 to ${MAX_TWAP_PARTS}, got: ${args[3]}`)
  }
  const interval = parseDuration(args[4])
  if (interval < MIN_TWAP_INTERVAL) throw new Error(`Interval must be at least ${formatDuration(MIN_TWAP_INTERVAL)}`)

  const partAmount = t.amount / BigInt(parts)
  if (partAmount === 0n) throw new Error('The amount is too small to split into that many parts')
  // The last part also takes whatever the division left over
  const amountOf = (index: number) => (index === parts - 1 ? t.amount - partAmount * BigInt(parts - 1) : partAmount)
  // Each part expires before the next one is due, so parts never overlap
  const validFor = Math.min(interval, ctx.validFor)

  const approval = await checkApproval(ctx, t.sell, t.amount)
  assertFunds(ctx, t, approval)
  const sample = await prepareMarketOrder(ctx, { sell: t.sell, buy: t.buy, amount: partAmount, validFor }, false)

  printRows([
    ['Order type', `TWAP: ${parts} market orders, one every ${formatDuration(interval)} (${formatDuration(interval * (parts - 1))} in total)`],
    ...tradeRows(ctx, t),
    ['Per part', `${fmt(partAmount, t.sell)} → about ${fmt(sample.expected, t.buy)} at the current price`],
    ['In total', `about ${fmt(sample.expected * BigInt(parts), t.buy)} at the current price`],
    ['Slippage', `${ctx.slippageBps / 100}% per part, against a fresh quote each time`],
    ['Recipient', ctx.recipient],
    ['Network fee', `~${fmt(sample.networkFee, t.sell)} per part`],
    ['Approval', approval.needed && !approval.usePermit ? `one ${describeApproval(ctx, t.sell, approval)} for the full amount` : describeApproval(ctx, t.sell, approval)],
  ])
  printWarnings(ctx, t)
  console.log(
    '\nThis TWAP is run by this script, not by CoW: keep it running until the last part is placed.' +
      '\nCtrl+C stops any further parts; an order already placed stays open until it fills or expires.',
  )

  await confirm('Start this TWAP?', skipConfirm)
  // One approval for the whole amount up front, instead of one transaction per part
  if (approval.needed && !approval.usePermit) await approveOnChain(ctx, t.sell, t.amount, approval.allowance)

  const startedAt = Date.now()
  let filledParts = 0
  let sold = 0n
  let bought = 0n
  for (let index = 0; index < parts; index++) {
    const dueIn = startedAt + index * interval * 1000 - Date.now()
    if (dueIn > 0) {
      console.log(`\nNext part in ${formatDuration(Math.ceil(dueIn / 1000))}...`)
      await sleep(dueIn)
    }
    const amount = amountOf(index)
    console.log(`\nPart ${index + 1}/${parts}: selling ${fmt(amount, t.sell)}`)
    try {
      const order = await prepareMarketOrder(ctx, { sell: t.sell, buy: t.buy, amount, validFor }, true)
      const placed = await order.place()
      console.log(`  order ${placed.orderId}`)
      console.log(`  expected ${fmt(order.expected, t.buy)}, minimum ${fmt(placed.minBuy, t.buy)}; waiting for the fill...`)
      const result = await waitForFill(ctx, placed)
      if (result === 'cancelled' || result === 'expired') {
        console.log(`  ✗ ${result} unfilled: ${unfilledOutcome(ctx, t.sell, placed.orderId)}`)
        continue
      }
      console.log(`  ✓ filled: ${describeFill(ctx, t.buy, placed, result)}`)
      filledParts++
      sold += amount
      bought += result.buyAmount ?? placed.minBuy
    } catch (error) {
      console.log(`  ✗ part failed: ${describe(error)}`)
    }
  }

  console.log(`\nTWAP finished: ${filledParts} of ${parts} parts filled.`)
  if (filledParts > 0) {
    console.log(`Sold ${fmt(sold, t.sell)} for ${fmt(bought, t.buy)}, delivered to ${ctx.recipient}`)
    console.log(`Average price: ${price(sold, t.sell, bought, t.buy)}`)
  }
  if (filledParts < parts) throw new Error(`${parts - filledParts} part(s) did not fill; see the log above`)
}

async function cancelCommand(ctx: Context, args: string[], skipConfirm: boolean) {
  requireArgs(args, 1)
  const orderId = args[0]
  if (!/^0x[0-9a-fA-F]{112}$/.test(orderId)) throw new Error(`Not an order id (expected 0x followed by 112 hex characters): ${orderId}`)
  await confirm(`Cancel order ${orderId}?`, skipConfirm)
  console.log(`✓ ${await cancelOrder(ctx, orderId)}`)
}

async function main() {
  const { command, args, valid, yes, help } = parseArgs(process.argv.slice(2))
  if (help || !command) {
    console.log(USAGE)
    return
  }
  if (!['quote', 'swap', 'limit', 'twap', 'cancel'].includes(command)) throw new Error(`Unknown command: ${command}\n\n${USAGE}`)

  const ctx = createContext()
  if (command === 'quote') await swapCommand(ctx, args, false, yes)
  if (command === 'swap') await swapCommand(ctx, args, true, yes)
  if (command === 'limit') await limitCommand(ctx, args, valid, yes)
  if (command === 'twap') await twapCommand(ctx, args, yes)
  if (command === 'cancel') await cancelCommand(ctx, args, yes)
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`\n✗ ${describe(error)}`)
    process.exit(1)
  },
)
