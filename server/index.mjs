#!/usr/bin/env node
/**
 * chat-demo 的自托管后端：静态托管 dist、保管 DeepSeek API Key、代理 API、同步对话历史与附件。
 *
 * 设计目标：单用户、无登录、零第三方依赖。所有数据都在本机 data/ 目录，
 * API Key 只保存在服务器上，浏览器永远拿不到；换浏览器或换设备打开同一个地址即可共用。
 *
 * 环境变量：
 *   PORT                   监听端口，默认 8090
 *   HOST                   监听地址，默认 0.0.0.0（只想本机访问时设为 127.0.0.1）
 *   DATA_DIR               数据目录，默认 <项目>/data
 *   DEEPSEEK_ORIGIN        DeepSeek API 地址，默认 https://api.deepseek.com
 *   DEEPSEEK_API_KEY       可选；设置后优先于页面里保存的 Key（适合只用环境变量管理密钥）
 */
import http from 'node:http'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DIST_DIR = path.join(ROOT, 'dist')

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'))
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const FILES_DIR = path.join(DATA_DIR, 'files')
const STAGING_DIR = path.join(DATA_DIR, 'staging')
const STAGING_SESSIONS_DIR = path.join(STAGING_DIR, 'sessions')
const STAGING_FILES_DIR = path.join(STAGING_DIR, 'files')

const DEEPSEEK_ORIGIN = (process.env.DEEPSEEK_ORIGIN || 'https://api.deepseek.com').replace(
  /\/+$/,
  ''
)
const ENV_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim()
const PORT = Number(process.env.PORT || 8090)
const HOST = process.env.HOST || '0.0.0.0'

/** 单个会话 JSON 的上限；图片以 file_id 引用，只有长文本会变大 */
const MAX_SESSION_BYTES = 32 * 1024 * 1024
/** 附件原件上限，与应用内的 64MB 限制留出余量 */
const MAX_FILE_BYTES = 96 * 1024 * 1024
/** 配置与小 JSON 请求的上限 */
const MAX_JSON_BYTES = 16 * 1024 * 1024

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
}

// eslint-disable-next-line no-console
const log = (...args) => console.log(new Date().toISOString(), ...args)

/** 带 HTTP 状态码、可安全回传给客户端的错误 */
const httpError = (status, message) => {
  const error = new Error(message)
  error.status = status
  error.expose = true
  return error
}

const now = () => Date.now()

const isSafeId = (id) =>
  typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..')

const requireId = (id) => {
  if (!isSafeId(id)) {
    throw httpError(400, 'Invalid id')
  }
  return id
}

const statOrNull = async (target) => {
  try {
    return await fs.stat(target)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

const listDir = async (dir) => {
  try {
    return await fs.readdir(dir)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

/** 先写临时文件再改名，避免进程中断留下半个 JSON */
const atomicWrite = async (file, data) => {
  const tmp = `${file}.${process.pid}.${now()}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** 把请求体流式写入临时文件，超过上限时中止 */
const receiveFile = async (req, destination, limit) => {
  const tmp = `${destination}.${process.pid}.${now()}.${Math.random().toString(36).slice(2)}.tmp`
  let size = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      if (size > limit) {
        callback(httpError(413, 'File too large'))
        return
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(req, limiter, createWriteStream(tmp))
    await fs.rename(tmp, destination)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  return size
}

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) {
        return
      }
      settled = true
      req.pause()
      reject(error)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(httpError(413, 'Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!settled) {
        settled = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (error) => fail(error))
  })

const readJson = async (req, limit = MAX_JSON_BYTES) => {
  const raw = await readBody(req, limit)
  if (raw.length === 0) {
    return undefined
  }
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw httpError(400, 'Invalid JSON body')
  }
}

const sendJson = (res, status, value) => {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

const noContent = (res) => {
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

const sendError = (res, status, message) => {
  sendJson(res, status, { error: { type: 'server_error', message } })
}

// ---------------------------------------------------------------------------
// 配置与 API Key
// ---------------------------------------------------------------------------

let configCache

const readConfig = async () => {
  if (configCache) {
    return configCache
  }
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'))
    configCache = typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log('warn: cannot read config, starting empty:', error.message)
    }
    configCache = {}
  }
  return configCache
}

const writeConfig = async (config) => {
  configCache = config
  await fs.mkdir(DATA_DIR, { recursive: true })
  await atomicWrite(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
  // 内容含密钥，尽量收紧权限（Windows 上 chmod 基本无效，可忽略失败）
  await fs.chmod(CONFIG_PATH, 0o600).catch(() => {})
}

const getApiKey = async () => {
  const config = await readConfig()
  const fromConfig = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  // 环境变量优先，便于只用系统配置管理密钥
  return ENV_API_KEY || fromConfig
}

const maskKey = (key) => {
  if (key.length <= 8) {
    return '*'.repeat(key.length)
  }
  const prefix = key.startsWith('sk-') ? 'sk-' : key.slice(0, 2)
  return `${prefix}${'*'.repeat(8)}${key.slice(-4)}`
}

const upstreamMessage = async (response) => {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text)
    if (typeof body?.error?.message === 'string') {
      return body.error.message
    }
    if (typeof body?.message === 'string') {
      return body.message
    }
  } catch {
    // 非 JSON 响应体直接使用原文
  }
  return text.trim() || `DeepSeek returned HTTP ${response.status}`
}

/** 用 GET /models 校验 Key，不产生费用 */
const verifyApiKey = async (key) => {
  let response
  try {
    response = await fetch(`${DEEPSEEK_ORIGIN}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    throw httpError(502, `Cannot reach DeepSeek: ${error.message}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw httpError(401, 'The API Key is invalid')
  }
  if (!response.ok) {
    throw httpError(502, await upstreamMessage(response))
  }
}

const handleStatus = async (res) => {
  const key = await getApiKey()
  sendJson(res, 200, {
    hasApiKey: Boolean(key),
    apiKeyHint: key ? maskKey(key) : null,
    // env 表示由环境变量提供，页面上修改不会生效
    apiKeySource: key ? (ENV_API_KEY ? 'env' : 'config') : null,
    deepseekOrigin: DEEPSEEK_ORIGIN,
  })
}

const handleSaveApiKey = async (req, res) => {
  if (ENV_API_KEY) {
    throw httpError(409, 'The API Key is provided by the DEEPSEEK_API_KEY environment variable')
  }
  const body = await readJson(req, 64 * 1024)
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!apiKey) {
    throw httpError(400, 'API Key is required')
  }
  await verifyApiKey(apiKey)
  const config = await readConfig()
  await writeConfig({ ...config, apiKey })
  sendJson(res, 200, {
    hasApiKey: true,
    apiKeyHint: maskKey(apiKey),
    apiKeySource: 'config',
  })
}

const handleDeleteApiKey = async (res) => {
  if (ENV_API_KEY) {
    throw httpError(409, 'The API Key is provided by the DEEPSEEK_API_KEY environment variable')
  }
  const config = await readConfig()
  delete config.apiKey
  await writeConfig(config)
  sendJson(res, 200, { hasApiKey: false, apiKeyHint: null, apiKeySource: null })
}

const handleBalance = async (res) => {
  const key = await getApiKey()
  if (!key) {
    throw httpError(401, 'API Key is not configured')
  }
  let response
  try {
    response = await fetch(`${DEEPSEEK_ORIGIN}/user/balance`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    throw httpError(502, `Cannot reach DeepSeek: ${error.message}`)
  }
  if (!response.ok) {
    throw httpError(response.status, await upstreamMessage(response))
  }
  const body = await response.text()
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

// ---------------------------------------------------------------------------
// DeepSeek 反向代理
// ---------------------------------------------------------------------------

const PROXY_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'accept-language',
  'anthropic-beta',
  'anthropic-version',
  'user-agent',
]

const proxyDeepSeek = async (req, res, url) => {
  const key = await getApiKey()
  if (!key) {
    throw httpError(401, 'API Key is not configured')
  }
  const rest = url.pathname.slice('/api/deepseek'.length) || '/'
  if (!rest.startsWith('/') || rest.startsWith('//')) {
    throw httpError(400, 'Invalid proxy path')
  }
  const headers = {}
  for (const name of PROXY_REQUEST_HEADERS) {
    const value = req.headers[name]
    if (value) {
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
  }
  headers.authorization = `Bearer ${key}`
  // Anthropic 兼容接口按官方文档使用 x-api-key；同时带上 Bearer 以兼容不同网关
  if (rest.startsWith('/anthropic/')) {
    headers['x-api-key'] = key
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  res.on('close', abort)
  try {
    const contentLength = req.headers['content-length']
    // 有 Content-Length 或 chunked 传输时才转发请求体；DELETE 等无请求体的方法直接透传
    const hasBody =
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      contentLength !== '0' &&
      (contentLength !== undefined || Boolean(req.headers['transfer-encoding']))
    if (hasBody && contentLength) {
      headers['content-length'] = contentLength
    }
    const upstream = await fetch(`${DEEPSEEK_ORIGIN}${rest}${url.search}`, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
      signal: controller.signal,
    })
    const responseHeaders = {
      'cache-control': 'no-store',
      // 让 nginx 等反代不要缓冲 SSE
      'x-accel-buffering': 'no',
    }
    const contentType = upstream.headers.get('content-type')
    if (contentType) {
      responseHeaders['content-type'] = contentType
    }
    res.writeHead(upstream.status, responseHeaders)
    res.flushHeaders()
    if (!upstream.body) {
      res.end()
      return
    }
    const reader = upstream.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!res.write(value)) {
        await new Promise((resolve) => {
          const onDrain = () => {
            res.off('close', onClose)
            resolve()
          }
          const onClose = () => {
            res.off('drain', onDrain)
            resolve()
          }
          res.once('drain', onDrain)
          res.once('close', onClose)
        })
      }
      if (res.destroyed) {
        controller.abort()
        break
      }
    }
    res.end()
  } finally {
    res.off('close', abort)
  }
}

// ---------------------------------------------------------------------------
// 会话与附件存储
// ---------------------------------------------------------------------------

const sessionFile = (dir, id) => path.join(dir, `${id}.json`)
const fileData = (dir, id) => path.join(dir, `${id}.bin`)
const fileType = (dir, id) => path.join(dir, `${id}.type`)

const validSession = (value, id) =>
  typeof value === 'object' &&
  value !== null &&
  typeof value.id === 'string' &&
  value.id === id &&
  typeof value.title === 'string' &&
  Array.isArray(value.messages)

const toSummary = (session) => ({
  id: session.id,
  title: typeof session.title === 'string' ? session.title : '',
  createdAt: Number(session.createdAt) || 0,
  updatedAt: Number(session.updatedAt) || 0,
})

/** 读取目录下所有会话摘要；单个文件损坏只跳过它，不影响整个列表。 */
const listSummaries = async (dir = SESSIONS_DIR) => {
  const names = (await listDir(dir)).filter((name) => name.endsWith('.json'))
  const summaries = await Promise.all(
    names.map(async (name) => {
      try {
        const session = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))
        return isSafeId(session?.id) ? toSummary(session) : null
      } catch (error) {
        log(`warn: skip unreadable session ${name}:`, error.message)
        return null
      }
    })
  )
  return summaries.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)
}

const handleListSessions = async (res) => {
  sendJson(res, 200, await listSummaries())
}

const handleGetSession = async (res, id) => {
  const file = sessionFile(SESSIONS_DIR, id)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw httpError(404, 'Session not found')
    }
    throw error
  }
  try {
    const session = JSON.parse(text)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(session))
  } catch {
    throw httpError(500, 'Stored session is corrupted')
  }
}

const handlePutSession = async (req, res, id) => {
  const session = await readJson(req, MAX_SESSION_BYTES)
  if (!validSession(session, id)) {
    throw httpError(400, 'Invalid session')
  }
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
  await atomicWrite(sessionFile(SESSIONS_DIR, id), JSON.stringify(session))
  noContent(res)
}

const handleRenameSession = async (req, res, id) => {
  const body = await readJson(req, 64 * 1024)
  const title = typeof body?.title === 'string' ? body.title : ''
  let session
  try {
    session = JSON.parse(await fs.readFile(sessionFile(SESSIONS_DIR, id), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      // 与 IndexedDB 版本一致：会话不存在时静默忽略
      noContent(res)
      return
    }
    throw error
  }
  session.title = title
  await atomicWrite(sessionFile(SESSIONS_DIR, id), JSON.stringify(session))
  noContent(res)
}

/** 汇总仍被会话引用的原件 id；有会话损坏时返回 null，调用方跳过清理以免误删 */
const referencedFileIds = async () => {
  const referenced = new Set()
  for (const name of await listDir(SESSIONS_DIR)) {
    if (!name.endsWith('.json')) {
      continue
    }
    try {
      const session = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, name), 'utf8'))
      for (const message of session.messages ?? []) {
        if (message?.role !== 'user') {
          continue
        }
        for (const file of message.files ?? []) {
          if (isSafeId(file?.id)) {
            referenced.add(file.id)
          }
        }
      }
    } catch {
      return null
    }
  }
  return referenced
}

const removeFiles = async (ids) => {
  for (const id of ids) {
    await fs.rm(fileData(FILES_DIR, id), { force: true })
    await fs.rm(fileType(FILES_DIR, id), { force: true })
  }
}

/** 删除会话后，只清理仅被该会话引用的原件；其他会话刚上传的附件不受影响 */
const cleanupSessionFiles = async (session) => {
  const candidates = new Set()
  for (const message of session.messages ?? []) {
    if (message?.role !== 'user') {
      continue
    }
    for (const file of message.files ?? []) {
      if (isSafeId(file?.id)) {
        candidates.add(file.id)
      }
    }
  }
  if (candidates.size === 0) {
    return
  }
  const referenced = await referencedFileIds()
  if (!referenced) {
    return
  }
  await removeFiles([...candidates].filter((id) => !referenced.has(id)))
}

/** 启动时清理崩溃或中断遗留的孤立附件；宽限期避免误删正在保存的新文件 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000

const collectOrphanFiles = async () => {
  const referenced = await referencedFileIds()
  if (!referenced) {
    return
  }
  const cutoff = Date.now() - ORPHAN_GRACE_MS
  for (const name of await listDir(FILES_DIR)) {
    if (!name.endsWith('.bin')) {
      continue
    }
    const id = name.slice(0, -4)
    if (referenced.has(id)) {
      continue
    }
    const file = fileData(FILES_DIR, id)
    const stat = await statOrNull(file)
    if (stat && stat.mtimeMs < cutoff) {
      await fs.rm(file, { force: true })
      await fs.rm(fileType(FILES_DIR, id), { force: true })
    }
  }
}

const handleDeleteSession = async (res, id) => {
  let session = null
  try {
    session = JSON.parse(await fs.readFile(sessionFile(SESSIONS_DIR, id), 'utf8'))
  } catch {
    // 会话不存在或已损坏：仍然删除文件，附件交给下次启动清理
  }
  await fs.rm(sessionFile(SESSIONS_DIR, id), { force: true })
  if (session) {
    await cleanupSessionFiles(session).catch((error) =>
      log('warn: cleanup unreferenced files failed:', error.message)
    )
  }
  noContent(res)
}

const handleGetFile = async (req, res, id) => {
  const data = fileData(FILES_DIR, id)
  const stat = await statOrNull(data)
  if (!stat) {
    throw httpError(404, 'File not found')
  }
  let type = 'application/octet-stream'
  try {
    type = (await fs.readFile(fileType(FILES_DIR, id), 'utf8')).trim() || type
  } catch {
    // 类型缺失时按二进制返回
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(stat.size),
    // 文件 id 唯一且内容不变，可长期缓存
    'cache-control': 'private, max-age=31536000, immutable',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await pipeline(createReadStream(data), res).catch((error) => {
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      throw error
    }
  })
}

const handlePutFile = async (req, res, id, dir = FILES_DIR) => {
  await fs.mkdir(dir, { recursive: true })
  await receiveFile(req, fileData(dir, id), MAX_FILE_BYTES)
  const type = String(req.headers['content-type'] || 'application/octet-stream')
    .split(';')[0]
    .trim()
  await atomicWrite(fileType(dir, id), type || 'application/octet-stream')
  noContent(res)
}

const handleDeleteFile = async (res, id) => {
  await fs.rm(fileData(FILES_DIR, id), { force: true })
  await fs.rm(fileType(FILES_DIR, id), { force: true })
  noContent(res)
}

// ---------------------------------------------------------------------------
// 历史导入暂存：全部校验通过后一次性替换正式数据
// ---------------------------------------------------------------------------

let historyLock = Promise.resolve()
const withHistoryLock = (task) => {
  const run = historyLock.then(task, task)
  historyLock = run.catch(() => {})
  return run
}

const clearStaging = () => fs.rm(STAGING_DIR, { recursive: true, force: true })

/** 从暂存会话里回填图片 MIME（客户端在图片读取完成后调用） */
const handleStagingFileTypes = async (req, res) => {
  const body = await readJson(req)
  const types = body?.types
  if (typeof types !== 'object' || types === null) {
    throw httpError(400, 'Invalid file types')
  }
  for (const name of await listDir(STAGING_SESSIONS_DIR)) {
    if (!name.endsWith('.json')) {
      continue
    }
    const file = path.join(STAGING_SESSIONS_DIR, name)
    let session
    try {
      session = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      continue
    }
    let changed = false
    for (const message of session.messages ?? []) {
      if (message?.role !== 'user') {
        continue
      }
      for (const attachment of message.files ?? []) {
        if (Object.hasOwn(types, attachment.id) && attachment.mimeType !== types[attachment.id]) {
          attachment.mimeType = String(types[attachment.id])
          changed = true
        }
      }
    }
    if (changed) {
      await atomicWrite(file, JSON.stringify(session))
    }
  }
  noContent(res)
}

/** 用暂存替换正式数据：先把旧目录改名备份，再移入新目录；失败时恢复旧数据。 */
const swapDir = async (from, to) => {
  const backup = `${to}.old`
  await fs.rm(backup, { recursive: true, force: true })
  const hadCurrent = Boolean(await statOrNull(to))
  if (hadCurrent) {
    await fs.rename(to, backup)
  }
  try {
    await fs.rename(from, to)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (hadCurrent) {
        await fs.rm(to, { recursive: true, force: true }).catch(() => {})
        await fs.rename(backup, to).catch(() => {})
      }
      throw error
    }
    await fs.mkdir(to, { recursive: true })
  }
  await fs.rm(backup, { recursive: true, force: true })
}

const commitStaging = () =>
  withHistoryLock(async () => {
    await swapDir(STAGING_SESSIONS_DIR, SESSIONS_DIR)
    await swapDir(STAGING_FILES_DIR, FILES_DIR)
    await fs.rm(STAGING_DIR, { recursive: true, force: true })
    return listSummaries()
  })

/** 进程在替换中途退出时：新目录已就位就丢弃备份，否则用备份恢复 */
const recoverInterruptedCommit = async () => {
  for (const dir of [SESSIONS_DIR, FILES_DIR]) {
    const backup = `${dir}.old`
    if (!(await statOrNull(backup))) {
      continue
    }
    const restored = await statOrNull(dir)
    if (!restored || (await listDir(dir)).length === 0) {
      await fs.rm(dir, { recursive: true, force: true })
      await fs.rename(backup, dir)
      log(`recovered ${path.basename(dir)} from an interrupted history import`)
    } else {
      await fs.rm(backup, { recursive: true, force: true })
    }
  }
}

const handleCommitStaging = async (res) => {
  sendJson(res, 200, await commitStaging())
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------

const sendFile = async (req, res, file, cacheControl) => {
  const stat = await fs.stat(file)
  const type = MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(stat.size),
    'cache-control': cacheControl,
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await pipeline(createReadStream(file), res).catch((error) => {
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      throw error
    }
  })
}

const serveStatic = async (req, res, url) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw httpError(405, 'Method not allowed')
  }
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    throw httpError(400, 'Invalid path')
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const resolved = path.resolve(DIST_DIR, relative)
  if (resolved !== DIST_DIR && !resolved.startsWith(`${DIST_DIR}${path.sep}`)) {
    throw httpError(404, 'Not found')
  }
  const indexFile = path.join(DIST_DIR, 'index.html')
  if (!(await statOrNull(indexFile))) {
    throw httpError(
      503,
      'Frontend is not built yet. Run "pnpm build" and restart the server (see README).'
    )
  }
  const stat = await statOrNull(resolved)
  if (stat?.isFile()) {
    const immutable = relative.startsWith('static/')
    await sendFile(
      req,
      res,
      resolved,
      immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
    )
    return
  }
  // 单页应用：其余路径都返回入口文件，前端自己决定展示哪一页
  if (!path.extname(relative)) {
    await sendFile(req, res, indexFile, 'no-cache')
    return
  }
  throw httpError(404, 'Not found')
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const handleApi = async (req, res, url) => {
  const segments = url.pathname.split('/').filter(Boolean)
  const method = req.method || 'GET'
  // ['api', ...]
  const [, resource, ...rest] = segments

  if (resource === 'deepseek') {
    if (rest.length === 0) {
      throw httpError(404, 'Not found')
    }
    await proxyDeepSeek(req, res, url)
    return
  }

  if (resource === 'status' && rest.length === 0) {
    if (method !== 'GET') {
      throw httpError(405, 'Method not allowed')
    }
    await handleStatus(res)
    return
  }

  if (resource === 'balance' && rest.length === 0) {
    if (method !== 'GET') {
      throw httpError(405, 'Method not allowed')
    }
    await handleBalance(res)
    return
  }

  if (resource === 'settings' && rest[0] === 'api-key' && rest.length === 1) {
    if (method === 'PUT') {
      await handleSaveApiKey(req, res)
      return
    }
    if (method === 'DELETE') {
      await handleDeleteApiKey(res)
      return
    }
    throw httpError(405, 'Method not allowed')
  }

  if (resource === 'sessions') {
    if (rest.length === 0) {
      if (method !== 'GET') {
        throw httpError(405, 'Method not allowed')
      }
      await handleListSessions(res)
      return
    }
    if (rest.length === 1) {
      const id = requireId(rest[0])
      if (method === 'GET') {
        await handleGetSession(res, id)
        return
      }
      if (method === 'PUT') {
        await handlePutSession(req, res, id)
        return
      }
      if (method === 'PATCH') {
        await handleRenameSession(req, res, id)
        return
      }
      if (method === 'DELETE') {
        await handleDeleteSession(res, id)
        return
      }
      throw httpError(405, 'Method not allowed')
    }
    throw httpError(404, 'Not found')
  }

  if (resource === 'files' && rest.length === 1) {
    const id = requireId(rest[0])
    if (method === 'GET' || method === 'HEAD') {
      await handleGetFile(req, res, id)
      return
    }
    if (method === 'PUT') {
      await handlePutFile(req, res, id)
      return
    }
    if (method === 'DELETE') {
      await handleDeleteFile(res, id)
      return
    }
    throw httpError(405, 'Method not allowed')
  }

  if (resource === 'history') {
    if (rest.length === 1 && rest[0] === 'staging' && method === 'DELETE') {
      await clearStaging()
      noContent(res)
      return
    }
    if (rest[0] === 'staging' && rest[1] === 'sessions' && rest.length === 3 && method === 'PUT') {
      const id = requireId(rest[2])
      const session = await readJson(req, MAX_SESSION_BYTES)
      if (!validSession(session, id)) {
        throw httpError(400, 'Invalid session')
      }
      await fs.mkdir(STAGING_SESSIONS_DIR, { recursive: true })
      await atomicWrite(sessionFile(STAGING_SESSIONS_DIR, id), JSON.stringify(session))
      noContent(res)
      return
    }
    if (rest[0] === 'staging' && rest[1] === 'files' && rest.length === 3 && method === 'PUT') {
      const id = requireId(rest[2])
      await handlePutFile(req, res, id, STAGING_FILES_DIR)
      return
    }
    if (
      rest[0] === 'staging' &&
      rest[1] === 'file-types' &&
      rest.length === 2 &&
      method === 'POST'
    ) {
      await handleStagingFileTypes(req, res)
      return
    }
    if (rest.length === 1 && rest[0] === 'commit' && method === 'POST') {
      await handleCommitStaging(res)
      return
    }
    throw httpError(404, 'Not found')
  }

  throw httpError(404, 'Not found')
}

const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }
    await serveStatic(req, res, url)
  } catch (error) {
    const status = Number(error?.status) || 500
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (status >= 500) {
      log('error:', req.method, url?.pathname, error)
    }
    const message = error?.expose && error.message ? error.message : 'Internal server error'
    if (status === 413) {
      res.setHeader('connection', 'close')
    }
    sendError(res, status, message)
  }
})

const ensureDataDirs = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
  await fs.mkdir(FILES_DIR, { recursive: true })
}

await recoverInterruptedCommit()
await ensureDataDirs()
server.listen(PORT, HOST, () => {
  log(`chat-demo server listening on http://${HOST}:${PORT}`)
  log(`data directory: ${DATA_DIR}`)
  log(`deepseek origin: ${DEEPSEEK_ORIGIN}`)
  if (ENV_API_KEY) {
    log('API Key: using DEEPSEEK_API_KEY from environment')
  }
  // 清理上次运行遗留的孤立附件，不阻塞启动
  void collectOrphanFiles().catch((error) =>
    log('warn: startup attachment cleanup failed:', error.message)
  )
})

const shutdown = () => {
  log('shutting down...')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
