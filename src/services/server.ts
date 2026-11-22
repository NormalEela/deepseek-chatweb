import { request } from './api/client.js'
import {
  discardLegacyApiKey,
  setApiKeyStatus,
  takeLegacyApiKey,
  type ApiKeySource,
} from './settings.js'

/** 服务端状态：是否已配置 Key、掩码与来源；Key 本身永远不会下发到浏览器 */
export type ServerStatus = {
  hasApiKey: boolean
  apiKeyHint: string | null
  apiKeySource: ApiKeySource | null
  deepseekOrigin: string
}

const applyStatus = (status: ServerStatus) => {
  setApiKeyStatus(status.hasApiKey, status.apiKeyHint, status.apiKeySource)
}

export const fetchServerStatus = async (): Promise<ServerStatus> => {
  const response = await request('/api/status', { cache: 'no-store' })
  return (await response.json()) as ServerStatus
}

/** 保存到服务器前会先用 GET /models 校验，校验失败抛出带状态码的 ApiError */
export const saveApiKey = async (apiKey: string): Promise<ServerStatus> => {
  const response = await request('/api/settings/api-key', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  })
  const status = (await response.json()) as ServerStatus
  applyStatus(status)
  return status
}

export const deleteApiKey = async (): Promise<ServerStatus> => {
  const response = await request('/api/settings/api-key', { method: 'DELETE' })
  const status = (await response.json()) as ServerStatus
  applyStatus(status)
  return status
}

/**
 * 启动时同步服务端状态。
 * 旧版把 Key 存在浏览器 localStorage：这里读取一次并自动保存到服务器，然后从浏览器删除，
 * 用户升级后无需重新输入。服务器已有 Key 或迁移失败时直接丢弃旧值。
 */
export const loadServerSettings = async (): Promise<ServerStatus> => {
  const status = await fetchServerStatus()
  applyStatus(status)
  if (status.hasApiKey) {
    discardLegacyApiKey()
    return status
  }
  const legacy = takeLegacyApiKey()
  if (!legacy) {
    return status
  }
  try {
    return await saveApiKey(legacy)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[settings] failed to migrate the browser API key to the server', error)
    return status
  }
}
