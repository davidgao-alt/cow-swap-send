/** Configuration, clients and token lookup shared by every command. */
import {
  COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS,
  COW_PROTOCOL_VAULT_RELAYER_ADDRESS,
  ETH_FLOW_ADDRESSES,
  OrderBookApi,
  SupportedChainId,
  TradingSdk,
} from '@cowprotocol/cow-sdk'
import { ViemAdapter } from '@cowprotocol/sdk-viem-adapter'
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, avalanche, base, bsc, gnosis, ink, linea, mainnet, plasma, polygon, sepolia } from 'viem/chains'

// CoW's marker address for a chain's native currency (ETH, xDAI, BNB, ...)
export const NATIVE_TOKEN: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const CHAINS = [mainnet, bsc, gnosis, polygon, base, plasma, arbitrum, avalanche, ink, linea, sepolia]
const EXPLORER_PREFIX: Record<number, string> = { 1: '', 100: 'gc/', 8453: 'base/', 42161: 'arb1/', 11155111: 'sepolia/' }
// CoW Swap's default token list, used to resolve token symbols to addresses
const TOKEN_LIST_URL = 'https://files.cow.fi/tokens/CowSwap.json'

export interface Token {
  address: Address
  symbol: string
  decimals: number
  isNative: boolean
}

export type Context = ReturnType<typeof createContext>

/** Message of an SDK, API or RPC error, preferring the most specific text available. */
export function describe(error: any): string {
  return error?.body?.description ?? error?.shortMessage ?? error?.message ?? String(error)
}

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim()
  if (value) return value
  if (fallback !== undefined) return fallback
  throw new Error(`Missing ${name}. Set it in .env (see .env.example).`)
}

function envAddress(name: string): Address {
  const value = env(name)
  if (!isAddress(value)) throw new Error(`${name} is not a valid address (or its checksum is wrong): ${value}`)
  return getAddress(value)
}

function envInt(name: string, fallback: string): number {
  const value = Number(env(name, fallback))
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

export function createContext() {
  try {
    process.loadEnvFile()
  } catch {
    // No .env file: fall back to the process environment and let env() report what is missing
  }

  const chainId = envInt('CHAIN_ID', '1')
  const chain = CHAINS.find((c) => c.id === chainId)
  if (!chain) throw new Error(`Unsupported CHAIN_ID: ${chainId}`)

  const owner = envAddress('OWNER_ADDRESS')
  const recipient = envAddress('RECIPIENT')
  const approvalMode = env('APPROVAL_MODE', 'approve').toLowerCase()
  if (approvalMode !== 'approve' && approvalMode !== 'permit') throw new Error('APPROVAL_MODE must be "approve" or "permit"')

  const privateKey = env('PRIVATE_KEY')
  const account = (() => {
    try {
      return privateKeyToAccount((privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex)
    } catch {
      throw new Error('PRIVATE_KEY is malformed; expected 64 hex characters')
    }
  })()
  if (!isAddressEqual(account.address, owner)) {
    throw new Error(`PRIVATE_KEY belongs to ${account.address}, which does not match OWNER_ADDRESS (${owner})`)
  }

  const transport = http(process.env.RPC_URL?.trim() || undefined)
  const client = createPublicClient({ chain, transport })
  const wallet = createWalletClient({ account, chain, transport })
  const orderBookApi = new OrderBookApi({ chainId })
  const adapter = new ViemAdapter({ provider: client as PublicClient, signer: account })
  const sdk = new TradingSdk({ chainId, appCode: 'cow-swap-send' }, { orderBookApi }, adapter)
  const supportedChainId = chainId as SupportedChainId

  return {
    chain,
    chainId,
    nativeSymbol: chain.nativeCurrency.symbol,
    owner,
    recipient,
    account,
    client,
    wallet,
    sdk,
    approvalMode: approvalMode as 'approve' | 'permit',
    slippageBps: envInt('SLIPPAGE_BPS', '50'),
    validFor: envInt('VALID_FOR_SECONDS', '1800'),
    relayer: getAddress(COW_PROTOCOL_VAULT_RELAYER_ADDRESS[supportedChainId]),
    settlement: getAddress(COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[supportedChainId]),
    ethFlow: getAddress(ETH_FLOW_ADDRESSES[supportedChainId]),
    txUrl: (hash: string) => `${chain.blockExplorers?.default.url}/tx/${hash}`,
    orderUrl: (orderId: string) =>
      chainId in EXPLORER_PREFIX ? `https://explorer.cow.fi/${EXPLORER_PREFIX[chainId]}orders/${orderId}` : undefined,
  }
}

let tokenList: Promise<{ chainId: number; symbol: string; address: string }[]> | undefined

async function resolveAddress(ctx: Context, input: string): Promise<Address> {
  if (isAddress(input)) return getAddress(input)
  if (input.startsWith('0x')) throw new Error(`Not a valid token address (or its checksum is wrong): ${input}`)

  const symbol = input.toUpperCase()
  if (symbol === ctx.nativeSymbol.toUpperCase() || symbol === 'NATIVE') return NATIVE_TOKEN

  tokenList ??= fetch(TOKEN_LIST_URL)
    .then((response) => response.json())
    .then((list) => list.tokens)
  const tokens = await tokenList.catch(() => {
    throw new Error(`Could not download the CoW token list; use the contract address instead of ${input}`)
  })
  const matches = tokens.filter((token) => token.chainId === ctx.chainId && token.symbol.toUpperCase() === symbol)
  if (matches.length === 1) return getAddress(matches[0].address)
  throw new Error(
    matches.length > 1
      ? `${input} matches several tokens in the CoW token list; use the contract address`
      : `${input} is not in the CoW token list for ${ctx.chain.name}; use the contract address`,
  )
}

/** Resolves a symbol or address given on the command line and reads the token's on-chain details. */
export async function resolveToken(ctx: Context, input: string): Promise<Token> {
  const address = await resolveAddress(ctx, input)
  if (isAddressEqual(address, NATIVE_TOKEN)) {
    return { address, symbol: ctx.nativeSymbol, decimals: ctx.chain.nativeCurrency.decimals, isNative: true }
  }
  const erc20 = { address, abi: erc20Abi } as const
  const [decimals, symbol] = await Promise.all([
    ctx.client.readContract({ ...erc20, functionName: 'decimals' }),
    // A few old tokens (e.g. MKR) return a bytes32 symbol; show a short address instead
    ctx.client.readContract({ ...erc20, functionName: 'symbol' }).catch(() => `${address.slice(0, 8)}…`),
  ]).catch((error) => {
    throw new Error(`Could not read token ${address}. Check RPC_URL, CHAIN_ID and the address: ${describe(error)}`)
  })
  return { address, symbol, decimals, isNative: false }
}
