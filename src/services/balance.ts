import { create } from 'zustand'
import { request } from './api/client.js'

/** DeepSeek /user/balance 的一条余额（按币种），金额是服务端给出的十进制字符串 */
export type BalanceEntry = {
  currency: string
  total: string
  granted: string
  toppedUp: string
}

type BalanceState = {
  /** loading 只表示正在请求，界面上仍展示上一次的金额 */
  status: 'idle' | 'loading' | 'ready' | 'error'
  available: boolean
  entries: BalanceEntry[]
  updatedAt: number | null
}

export const useBalance = create<BalanceState>(() => ({
  status: 'idle',
  available: true,
  entries: [],
  updatedAt: null,
}))

type BalanceResponse = {
  is_available?: boolean
  balance_infos?: {
    currency?: string
    total_balance?: string
    granted_balance?: string
    topped_up_balance?: string
  }[]
}

let pending: Promise<void> | null = null

/** 读取账户余额；并发调用复用同一个请求 */
export const loadBalance = (): Promise<void> => {
  if (pending) {
    return pending
  }
  useBalance.setState({ status: 'loading' })
  pending = (async () => {
    try {
      const response = await request('/api/balance', { cache: 'no-store' })
      const body = (await response.json()) as BalanceResponse
      useBalance.setState({
        status: 'ready',
        available: body.is_available !== false,
        entries: (body.balance_infos ?? []).map((item) => ({
          currency: item.currency ?? '',
          total: item.total_balance ?? '0',
          granted: item.granted_balance ?? '0',
          toppedUp: item.topped_up_balance ?? '0',
        })),
        updatedAt: Date.now(),
      })
    } catch {
      useBalance.setState({ status: 'error' })
    } finally {
      pending = null
    }
  })()
  return pending
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  RMB: '¥',
  USD: '$',
  EUR: '€',
}

/** 币种符号；未知币种直接用代码前缀 */
export const currencySymbol = (currency: string) => {
  const code = currency.toUpperCase()
  return Object.hasOwn(CURRENCY_SYMBOLS, code) ? CURRENCY_SYMBOLS[code] : `${code} `
}

export const formatMoney = (currency: string, amount: string) =>
  `${currencySymbol(currency)}${amount}`

export const formatAmount = (entry: BalanceEntry) => formatMoney(entry.currency, entry.total)

/** 侧边栏的一行文字，多币种时用「 / 」分隔 */
export const formatTotal = (entries: BalanceEntry[]) =>
  entries.length === 0 ? '--' : entries.map(formatAmount).join(' / ')
