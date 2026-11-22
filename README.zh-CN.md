# chat-demo（自托管版）

[English](README.md) | 简体中文

基于 DeepSeek API 的聊天界面，外加一个零第三方依赖的自托管后端。后端负责：

- 托管构建后的前端页面；
- 在服务器上保管 API Key，浏览器永远拿不到 Key 原文；
- 把聊天、文件上传、语音等请求代理到 DeepSeek；
- 把对话历史和附件原件保存在服务器上，换浏览器、换设备打开同一个地址即可共用；
- 查询并展示账户余额。

一个 Key 输入一次，所有浏览器通用；历史记录不再按浏览器隔离。

## 快速开始

构建前端需要 Node.js 22.12+ 和 pnpm；运行后端只需要 Node.js 18.17+。

```sh
pnpm install
pnpm build
pnpm start
```

打开 `http://<服务器IP>:8090`。首次进入时按提示填写一次 API Key，之后会保存在服务器上。

如果只想让本机访问：

```sh
HOST=127.0.0.1 pnpm start
```

## 环境变量

| 变量               | 默认值                     | 说明                                               |
| ------------------ | -------------------------- | -------------------------------------------------- |
| `PORT`             | `8090`                     | 监听端口                                           |
| `HOST`             | `0.0.0.0`                  | 监听地址；只本机访问时设为 `127.0.0.1`             |
| `DATA_DIR`         | `<项目>/data`              | 数据目录；配置、会话与附件都写在这里               |
| `DEEPSEEK_ORIGIN`  | `https://api.deepseek.com` | DeepSeek API 地址，可指向兼容网关                  |
| `DEEPSEEK_API_KEY` | 空                         | 可选；设置后优先于页面里保存的 Key，页面中不能修改 |

例如把数据放到独立磁盘，并在后台常驻：

```sh
DATA_DIR=/var/lib/chat-demo HOST=0.0.0.0 PORT=8090 pnpm start
# 或使用 systemd / pm2 / tmux / nohup 自行托管
```

## 开发

后端和前端分开跑（前端 8090，后端 8787，`/api` 由开发服务器代理到后端）：

```sh
# 终端 1
PORT=8787 pnpm server

# 终端 2
pnpm dev
```

打开 http://localhost:8090 。Windows PowerShell 中设置环境变量用 `$env:PORT=8787`。

## 数据与备份

```text
data/
  config.json          服务器保存的 API Key（权限 0600，不会被前端访问）
  sessions/<id>.json   每个对话一份 JSON
  files/<id>.bin       附件原件；<id>.type 记录 MIME
  staging/             历史导入的临时区，导入成功后整体替换正式数据
```

- 备份：停止服务后直接复制整个 `data/` 目录；恢复时放回原处再启动。
- 升级：替换代码 → `pnpm install && pnpm build` → 重启服务，`data/` 不受影响。
- `data/` 已加入 `.gitignore`，不要提交或放进静态目录。

## API Key、余额与多端共享

- 首次填写 Key 时，服务器会调用 `GET /models` 校验，通过后写入 `data/config.json`；浏览器只保留掩码（如 `sk-********abcd`）。
- 使用 `DEEPSEEK_API_KEY` 环境变量时，页面中的 Key 为只读，页面保存的值不会覆盖环境变量。
- 旧版把 Key 存在浏览器 localStorage；升级后首次打开会自动把它迁移到服务器并从浏览器删除，无需重新输入。
- 余额显示在侧边栏底部：点击可手动刷新；每轮回答结束、页面重新获得焦点时会自动刷新。悬停可看到赠送余额与充值余额。
- 多浏览器同时使用：打开或切回页面时会从服务器刷新对话列表，因此其他设备新建的对话会出现。同一对话同时在两处编辑时以最后一次保存为准（单用户场景，未做冲突合并）。

## 安全说明（重要）

这个版本按「服务器只有你自己用」设计，**没有登录密码**。这意味着任何能访问该端口的人都能用你的 Key 发消息、消耗余额，并读取或删除全部历史。

建议至少做到其中一项：

- 云服务器安全组只放行你自己的 IP；
- 只监听 `127.0.0.1`，通过 SSH 隧道访问：`ssh -L 8090:127.0.0.1:8090 user@server`；
- 在前面加一层带 Basic Auth 和 HTTPS 的 nginx / Caddy。

不要把公网地址发给别人。使用 nginx 反向代理时，注意关闭响应缓冲，否则流式回答会被整段缓存：

```nginx
location / {
    proxy_pass http://127.0.0.1:8090;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    client_max_body_size 100m;
}
```

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- API Key 与历史记录由服务器统一保存，多浏览器 / 多设备共享，并显示账户余额。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 历史导入导出

设置中的数据管理使用 ZIP 格式。

- 导入：先检查格式与版本，通过后写入服务器暂存区，全部成功才一次性替换服务器上的全部会话和附件；失败保留原数据。
- 导出：包含全部会话与服务器上可用的图片原件；其他附件只保留文件信息；不包含 API Key 和设置。
- 删除所有对话：清空服务器上的全部会话、附件原件和未发送的草稿，API Key 与其他设置保留；已上传到 DeepSeek 服务端的文件不受影响。

格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

## 目录结构

```text
server/
  index.mjs            零依赖后端：静态托管 + API 代理 + 会话/附件存储 + 余额
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               DeepSeek 请求、SSE 与协议类型（统一走 /api/deepseek 代理）
    chat/              会话、消息分支、服务端存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
