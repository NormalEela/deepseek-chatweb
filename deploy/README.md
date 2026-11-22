# 服务器部署（Linux）

完整步骤见 [DEPLOY.zh-CN.md](../DEPLOY.zh-CN.md)，包含安装 Node/pnpm、`pnpm build`、systemd 常驻、nginx 反向代理、端口与防火墙、数据备份、升级和排错。

最简流程：

```sh
cd /opt/chat-demo
pnpm install --frozen-lockfile
pnpm build
sudo cp deploy/chat-demo.service /etc/systemd/system/chat-demo.service
# 按实际路径、用户、端口修改 service 文件
sudo systemctl daemon-reload
sudo systemctl enable --now chat-demo
```

然后浏览器打开 `http://服务器IP:8090`，首次进入填写一次 API Key。生产环境建议前面加 nginx + HTTPS，并参考文档关闭 `proxy_buffering`。
