import clsx from 'clsx'
import { useEffect } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  formatAmount,
  formatMoney,
  formatTotal,
  loadBalance,
  useBalance,
} from '../../services/balance.js'
import { useSettings } from '../../services/settings.js'
import styles from './Balance.module.css'

/**
 * 侧边栏底部的余额：显示 DeepSeek 账户可用余额，点击刷新。
 * 未配置 API Key 时不显示；悬停可看到赠送 / 充值明细。
 */
export const BalanceRow = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const configured = useSettings((state) => state.apiKeyConfigured)
  const hint = useSettings((state) => state.apiKeyHint)
  const status = useBalance((state) => state.status)
  const available = useBalance((state) => state.available)
  const entries = useBalance((state) => state.entries)

  useEffect(() => {
    if (configured) {
      void loadBalance()
    }
  }, [configured, hint])

  if (!configured) {
    return null
  }

  const failed = status === 'error' && entries.length === 0
  const unavailable = status === 'ready' && !available
  const value = failed ? t('balanceLoadFailed') : formatTotal(entries)
  const details = [
    t('balanceRefresh'),
    ...entries.map(
      (entry) =>
        `${formatAmount(entry)} · ${t('balanceGranted', {
          amount: formatMoney(entry.currency, entry.granted),
        })} · ${t('balanceToppedUp', {
          amount: formatMoney(entry.currency, entry.toppedUp),
        })}`
    ),
    ...(unavailable ? [t('balanceUnavailable')] : []),
  ].join('\n')

  return (
    <button
      type="button"
      className={clsx(styles.balance, mobile && styles.mobile)}
      title={details}
      aria-label={`${t('balanceLabel')} ${value}, ${t('balanceRefresh')}`}
      onClick={() => void loadBalance()}
    >
      <span className={styles.label}>{t('balanceLabel')}</span>
      <span
        className={clsx(
          styles.value,
          failed && styles.valueError,
          unavailable && styles.valueError,
          status === 'loading' && styles.valueLoading
        )}
      >
        {value}
      </span>
    </button>
  )
}
