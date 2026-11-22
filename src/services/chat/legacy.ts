import { openDB } from 'idb'
import * as db from './db.js'
import type { Session } from './types.js'

/**
 * 一次性迁移：旧版把会话与附件存在浏览器 IndexedDB（chat-demo 库）里，升级到服务端存储后，
 * 首次打开时把本浏览器里已有的历史补传到服务器，避免用户升级后看不到以前的对话。
 * 每个浏览器只迁移一次；服务器上已有同一会话且更新时跳过，不会用旧副本覆盖新内容。
 */
const LEGACY_DB_NAME = 'chat-demo'
const MIGRATED_FLAG = 'chat-demo:server-migration-v1'

type LegacyFile = { id: string; blob: Blob }

interface LegacyDB {
  sessions: { key: string; value: Session }
  files: { key: string; value: LegacyFile }
}

const hasMigrated = () => {
  try {
    return localStorage.getItem(MIGRATED_FLAG) === 'done'
  } catch {
    return true
  }
}

const markMigrated = () => {
  try {
    localStorage.setItem(MIGRATED_FLAG, 'done')
  } catch {
    // 存储不可用时下次再试，重复上传按会话 id 覆盖，不会产生重复记录
  }
}

const legacyDbExists = async () => {
  if (typeof indexedDB.databases !== 'function') {
    // 无法枚举时按存在处理；库不存在时下方读取会得到空列表
    return true
  }
  try {
    const databases = await indexedDB.databases()
    return databases.some((info) => info.name === LEGACY_DB_NAME)
  } catch {
    return true
  }
}

/** 返回成功迁移的会话数；发生网络错误时抛出，由调用方决定是否阻断启动 */
export const migrateLegacyBrowserHistory = async (): Promise<number> => {
  if (hasMigrated()) {
    return 0
  }
  if (!(await legacyDbExists())) {
    markMigrated()
    return 0
  }
  let legacy
  try {
    legacy = await openDB<LegacyDB>(LEGACY_DB_NAME)
  } catch {
    markMigrated()
    return 0
  }
  try {
    let sessions: Session[]
    try {
      sessions = await legacy.getAll('sessions')
    } catch {
      sessions = []
    }
    if (sessions.length === 0) {
      markMigrated()
      return 0
    }
    const onServer = new Map(
      (await db.loadSessionSummaries()).map((summary) => [summary.id, summary])
    )
    let migrated = 0
    for (const session of sessions) {
      if (!session || typeof session.id !== 'string' || !Array.isArray(session.messages)) {
        continue
      }
      const existing = onServer.get(session.id)
      if (existing && existing.updatedAt >= (Number(session.updatedAt) || 0)) {
        continue
      }
      const files: db.StoredFile[] = []
      const seen = new Set<string>()
      for (const message of session.messages) {
        if (message.role !== 'user') {
          continue
        }
        for (const attachment of message.files) {
          if (seen.has(attachment.id)) {
            continue
          }
          seen.add(attachment.id)
          const stored = await legacy.get('files', attachment.id).catch(() => undefined)
          if (stored?.blob) {
            files.push({ id: attachment.id, blob: stored.blob })
          }
        }
      }
      await db.saveSession(session, files)
      migrated++
    }
    markMigrated()
    return migrated
  } finally {
    legacy.close()
  }
}
