import type { Session, SessionSummary } from './types.js'

/**
 * 服务端存储：会话、摘要、附件原件都由自托管后端持久化，换浏览器、换设备打开同一地址即可共用。
 * 这里的接口保持与旧版 IndexedDB 实现一致，上层（会话状态、导入导出）无需感知存储位置。
 */

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

const SESSIONS_URL = '/api/sessions'
const STAGING_URL = '/api/history/staging'
const sessionUrl = (id: string) => `${SESSIONS_URL}/${encodeURIComponent(id)}`
const fileUrl = (id: string) => `/api/files/${encodeURIComponent(id)}`
const stagingFileUrl = (id: string) => `${STAGING_URL}/files/${encodeURIComponent(id)}`
const stagingSessionUrl = (id: string) => `${STAGING_URL}/sessions/${encodeURIComponent(id)}`

const describeFailure = async (response: Response): Promise<Error> => {
  const text = await response.text().catch(() => '')
  let message = text
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } }
    if (typeof body.error?.message === 'string') {
      message = body.error.message
    }
  } catch {
    // 非 JSON 错误体直接使用原文
  }
  return new Error(`Storage request failed (${response.status}): ${message || response.statusText}`)
}

const ensureOk = async (response: Response): Promise<Response> => {
  if (!response.ok) {
    throw await describeFailure(response)
  }
  return response
}

const jsonInit = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * 已成功上传的原件：保存整份会话时会反复带上同一批待保存附件，
 * 不记录的话每次重试都会重传几十 MB。键包含 URL、大小与类型，避免导入复用 id 时误跳过。
 */
const uploadedFiles = new Set<string>()

const putFile = async (file: StoredFile, url: string): Promise<void> => {
  const key = `${url}|${file.id}|${file.blob.size}|${file.blob.type}`
  if (uploadedFiles.has(key)) {
    return
  }
  await ensureOk(
    await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': file.blob.type || 'application/octet-stream' },
      body: file.blob,
    })
  )
  uploadedFiles.add(key)
}

/**
 * 同一会话的写入按顺序串行：保存是整份快照，乱序到达会让旧快照覆盖新内容。
 * 不同会话之间互不阻塞；请求失败只影响对应会话，调用方会保留「未保存」状态供重试。
 */
const writeQueues = new Map<string, Promise<unknown>>()

const serialize = <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  writeQueues.set(key, run)
  void run
    .finally(() => {
      if (writeQueues.get(key) === run) {
        writeQueues.delete(key)
      }
    })
    .catch(() => {})
  return run
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const response = await ensureOk(await fetch(SESSIONS_URL, { cache: 'no-store' }))
  return (await response.json()) as SessionSummary[]
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const response = await fetch(sessionUrl(id), { cache: 'no-store' })
  if (response.status === 404) {
    return undefined
  }
  await ensureOk(response)
  return (await response.json()) as Session
}

export const saveSession = (session: Session, files: StoredFile[] = []): Promise<void> =>
  serialize(session.id, async () => {
    for (const file of files) {
      await putFile(file, fileUrl(file.id))
    }
    await ensureOk(await fetch(sessionUrl(session.id), { method: 'PUT', ...jsonInit(session) }))
  })

/** 未打开的会话也可重命名，只更新标题，不重写整个会话。 */
export const renameSession = (id: string, title: string): Promise<void> =>
  serialize(id, async () => {
    await ensureOk(await fetch(sessionUrl(id), { method: 'PATCH', ...jsonInit({ title }) }))
  })

/** 删除会话；服务端会顺带清理已无会话引用的本地原件。远端文件不删。 */
export const deleteSession = (sessionId: string): Promise<void> =>
  serialize(sessionId, async () => {
    await ensureOk(await fetch(sessionUrl(sessionId), { method: 'DELETE' }))
  })

export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    await putFile(file, fileUrl(file.id))
  }
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const response = await fetch(fileUrl(id))
  if (response.status === 404) {
    return undefined
  }
  await ensureOk(response)
  return response.blob()
}

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  await ensureOk(await fetch(STAGING_URL, { method: 'DELETE' }))
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await ensureOk(
    await fetch(stagingSessionUrl(session.id), { method: 'PUT', ...jsonInit(session) })
  )
}

export const saveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    await putFile(file, stagingFileUrl(file.id))
  }
}

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  await ensureOk(
    await fetch(`${STAGING_URL}/file-types`, {
      method: 'POST',
      ...jsonInit({ types: Object.fromEntries(types) }),
    })
  )
}

/**
 * 导入完成后用暂存替换正式数据：服务端在同一把锁里清空并整体搬移目录，
 * 事务失败时正式数据保持不变。返回替换后的会话列表。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const response = await ensureOk(await fetch('/api/history/commit', { method: 'POST' }))
  return (await response.json()) as SessionSummary[]
}

/** 存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
