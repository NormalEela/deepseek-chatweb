# 部署到云服务器（Linux）

这份文档按最常见的 **Ubuntu 22.04 / 24.04（或 Debian 12）** 编写，CentOS、Alibaba Cloud Linux、Rocky 只需把 `apt` 换成 `dnf`/`yum`。全程命令可以直接复制，按需替换路径和端口。

下面的示例约定：

- 项目目录：`/opt/chat-demo`
- 端口：`8090`
- 运行用户：先用 `root` 跑通，再按文末建议换成普通用户

> 这个项目必须运行 Node 后端，不能再当纯静态站（GitHub Pages、直接双击 `index.html`）使用。

## 最快路径：已经有 `dist/` 且不改代码

后端运行时**不依赖 node_modules**，只需要 Node.js 18.17+。如果项目里的 `dist/index.html` 存在，可以直接：

```sh
cd /opt/chat-demo
node server/index.mjs
```

浏览器打开 `http://服务器IP:8090`，能正常使用后再按第 4 步配置 systemd 常驻。

如果 `dist/` 不存在，或者你改过前端代码，就继续下面的完整流程。

## 0. 先确认环境

```sh
node -v                 # 需要 v18.17+；构建前端建议 v22.12+
pnpm -v                 # 没有的话第 1 步安装
free -h                 # 内存建议 ≥ 1GB，构建时不足会 OOM
ss -lntp | grep -E ':80|:443|:8090'
```

如果项目是从 Windows 直接拷贝到服务器的，**先删掉服务器上的 `node_modules`**（Windows 上装的依赖不能用在 Linux），再重新安装：

```sh
cd /opt/chat-demo
rm -rf node_modules
```

`dist/` 是纯静态文件，可以直接保留；但建议在服务器上重新构建一次。

## 1. 安装 Node.js 和 pnpm

Ubuntu / Debian：

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm
node -v && pnpm -v
```

CentOS / Alibaba Cloud Linux / Rocky：

```sh
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
sudo npm install -g pnpm
node -v && pnpm -v
```

国内服务器如果下载慢，可以换镜像：

```sh
npm config set registry https://registry.npmmirror.com
pnpm config set registry https://registry.npmmirror.com
```

用 `nvm` 安装也可以，但后面 systemd 的 `ExecStart` 必须填 `command -v node` 得到的**绝对路径**（nvm 的 node 通常在 `~/.nvm/...` 下）。

## 2. 安装依赖并构建前端

```sh
cd /opt/chat-demo
pnpm install --frozen-lockfile
pnpm build
```

如果 `--frozen-lockfile` 报锁文件版本不匹配，改用 `pnpm install`。构建产物在 `dist/`。

内存只有 512MB 的机器可能在构建时被 OOM 杀掉，先加 1GB swap：

```sh
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

或者在本机 `pnpm build` 后，把 `dist/` 上传到服务器，服务器只跑后端（`pnpm start`）。

## 3. 先在前台试跑

```sh
cd /opt/chat-demo
pnpm start
```

看到 `chat-demo server listening on http://0.0.0.0:8090` 就成功了。**另开一个 SSH 窗口**检查：

```sh
curl -s http://127.0.0.1:8090/api/status
# 期望类似：{"hasApiKey":false,"apiKeyHint":null,...}
```

浏览器打开 `http://服务器IP:8090`，能出现页面并弹出设置就说明前后端都通了。确认后按 `Ctrl+C` 停掉，进入下一步常驻。

常见问题：

- `503 Frontend is not built yet` → 还没有执行 `pnpm build`，或 `dist/` 不在项目目录。
- `EADDRINUSE` → 8090 被占用，换端口 `PORT=8091 pnpm start`，或停掉旧进程。
- 页面打不开、`curl` 本机能通 → 云厂商安全组/防火墙没放行端口，见第 5 步。

## 4. 常驻运行：systemd（推荐）

```sh
# 查看 node 的绝对路径，填到 service 文件里
command -v node

# 把示例复制到 systemd
sudo cp /opt/chat-demo/deploy/chat-demo.service /etc/systemd/system/chat-demo.service
sudo nano /etc/systemd/system/chat-demo.service
```

示例文件默认假设项目在 `/opt/chat-demo`、用 `root` 运行。**如果路径或用户不同，改这几处**：`WorkingDirectory`、`ExecStart` 里的 node 路径、`DATA_DIR`、`User`/`Group`。

也可以不手工改，在项目目录里用下面的命令按当前路径自动生成（会同时替换 node 路径）：

```sh
cd /opt/chat-demo
sed -e "s#/opt/chat-demo#$(pwd)#g" \
    -e "s#/usr/bin/node#$(command -v node)#g" \
    deploy/chat-demo.service | sudo tee /etc/systemd/system/chat-demo.service >/dev/null
sudo nano /etc/systemd/system/chat-demo.service   # 再确认一下 User 等配置
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now chat-demo
sudo systemctl status chat-demo --no-pager
```

看日志：

```sh
journalctl -u chat-demo -f
```

重启 / 停止：

```sh
sudo systemctl restart chat-demo
sudo systemctl stop chat-demo
```

如果改用普通用户（例如 `www-data`），先把项目和数据目录的属主改掉，否则保存会话会失败：

```sh
sudo chown -R www-data:www-data /opt/chat-demo
sudo nano /etc/systemd/system/chat-demo.service   # User=www-data、Group=www-data
sudo systemctl daemon-reload
sudo systemctl restart chat-demo
```

临时用 `nohup` 也可以，但服务器重启后不会自动拉起，不推荐长期使用：

```sh
cd /opt/chat-demo
nohup pnpm start > chat-demo.log 2>&1 &
```

## 5. 让外网访问（二选一）

### 方案 A：直接访问 8090

1. 云厂商控制台 → 安全组，放行 TCP `8090`（来源填你自己的 IP，不要 `0.0.0.0/0`）。
2. 如果服务器开了 ufw：`sudo ufw allow 8090/tcp`。
3. 浏览器访问 `http://服务器IP:8090`。

### 方案 B：nginx 反向代理 + 域名（推荐）

```sh
sudo apt-get install -y nginx
sudo cp /opt/chat-demo/deploy/nginx.conf.example /etc/nginx/conf.d/chat-demo.conf
sudo nano /etc/nginx/conf.d/chat-demo.conf    # 把 example.com 换成你的域名
sudo nginx -t
sudo systemctl reload nginx
```

然后把 systemd 里的 `HOST` 改成 `127.0.0.1`（只允许 nginx 访问 Node），重新加载：

```sh
sudo systemctl daemon-reload
sudo systemctl restart chat-demo
```

安全组只需要放行 `80`/`443`。有域名时再上 HTTPS：

```sh
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

**流式回答必须关闭 nginx 缓冲**，示例里已经写了 `proxy_buffering off; proxy_read_timeout 3600s; client_max_body_size 100m;`，不要删。

## 6. 第一次使用

1. 打开页面，设置弹窗会自动出现；
2. 粘贴 DeepSeek API Key，点「确定」，Key 会保存到服务器的 `data/config.json`；
3. 侧边栏底部出现余额，直接开始聊天；
4. 换浏览器/手机打开同一地址，直接可用，不用再填 Key。

旧版浏览器里的 Key 和历史，会在**从那个浏览器第一次打开**时自动迁移到服务器并从浏览器删除。

## 7. 数据与备份

所有数据都在项目的 `data/` 目录：

```text
data/config.json       API Key（权限 0600）
data/sessions/*.json   每个对话一份
data/files/*.bin       附件原件
data/staging/          历史导入临时区
```

备份（会短暂停服，最稳妥）：

```sh
sudo systemctl stop chat-demo
sudo tar czf ~/chat-demo-data-$(date +%F).tar.gz -C /opt/chat-demo data
sudo systemctl start chat-demo
```

恢复时把 `data/` 解压回 `/opt/chat-demo/`，注意属主与运行用户一致。

**升级**：覆盖代码时不要覆盖 `data/`，然后：

```sh
cd /opt/chat-demo
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart chat-demo
```

## 8. 常见问题排查

```sh
# 服务状态
sudo systemctl status chat-demo --no-pager
# 最近日志
journalctl -u chat-demo -n 100 --no-pager
# 端口是否在监听
ss -lntp | grep 8090
# 本机接口是否正常
curl -s http://127.0.0.1:8090/api/status
```

| 现象                                 | 原因 / 处理                                                              |
| ------------------------------------ | ------------------------------------------------------------------------ |
| 浏览器打不开，本机 `curl` 正常       | 安全组或 ufw 没放行端口                                                  |
| 页面 502 Bad Gateway                 | Node 没启动，或 nginx `proxy_pass` 端口不对                              |
| 页面提示 `Frontend is not built yet` | 执行 `pnpm build`                                                        |
| 聊天报 401 / 提示未配置 Key          | 设置里填 Key，或配置 `DEEPSEEK_API_KEY` 环境变量后用 `systemctl restart` |
| 回答不是流式、一次性出现             | nginx 没关缓冲，检查 `proxy_buffering off`                               |
| 上传大附件失败                       | nginx `client_max_body_size`；云 WAF 也可能有限制                        |
| 保存失败 / data 目录没权限           | 运行用户与 `data/` 属主不一致，`chown -R` 后重启                         |
| 手机打不开语音输入                   | 麦克风需要 HTTPS（或 localhost）                                         |

## 9. 安全提醒

这个版本按「服务器只有你自己用」设计，**没有登录密码**。任何能访问端口的人都能用你的 Key 聊天、消耗余额、读删历史。

至少做一项：

- 安全组只放行你自己的 IP；
- 或者 `HOST=127.0.0.1` + SSH 隧道：`ssh -L 8090:127.0.0.1:8090 用户@服务器`，然后本机打开 `http://127.0.0.1:8090`；
- 或者 nginx 加 Basic Auth + HTTPS。

不要把公网地址发给别人。
