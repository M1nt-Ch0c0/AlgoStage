# 在线体验版部署

- 地址：<https://demo.m1ntch0c0.com/algostage>
- 服务器：`root@cpa-direct.m1ntch0c0.com`
- 源码目录：`/opt/algostage-demo/algostage`
- 容器：`algostage-demo-algostage`，仅绑定 `127.0.0.1:3100`
- 数据卷：`algostage-demo-algostage-data`，SQLite 位于 `/data/algostage.db`
- DNS：`demo.m1ntch0c0.com` 的 A 记录指向 `43.255.156.149`，DNS only

构建时启用 Demo 模式并设定 `/algostage` 子路径。体验版可完整播放「两数之和」的内置课程，其他题目可读题和练习；AI 接口和设置写入均被禁用。体验版不记进度，没有看板。上传源码时排除 `.env*`、本地数据库、`.git`、`node_modules` 和 `.next`。

当前练习页的「运行」使用模拟通过结果，尚未接入真实判题；此部署不改变这一既有演示行为。

## 构建与启动

在服务器源码目录执行：

```sh
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml up -d --wait
docker compose -f deploy/compose.yaml ps
```

此服务器 Docker 默认桥接网络不能访问外网，构建使用 `network: host`。运行容器仍使用隔离网络和回环端口，数据卷在重建时保留。修改实例子路径需重新构建，并同步修改 nginx 路径和健康检查。

## 首次配置 nginx 与证书

现有 nginx 容器为 `cpa-nginx`，使用 host 网络并挂载宿主机 `/etc/nginx`、`/etc/letsencrypt` 和 `/var/www/html`。

```sh
install -m 644 deploy/nginx-http.conf /etc/nginx/sites-available/demo.m1ntch0c0.com
ln -s /etc/nginx/sites-available/demo.m1ntch0c0.com /etc/nginx/sites-enabled/demo.m1ntch0c0.com
docker exec cpa-nginx nginx -t
docker exec cpa-nginx nginx -s reload
# DNS 生效后，使用现有 Let's Encrypt 账户签发证书。
certbot certonly --webroot -w /var/www/html -d demo.m1ntch0c0.com --non-interactive --agree-tos
install -m 644 deploy/algostage-proxy.conf /etc/nginx/snippets/algostage-proxy.conf
install -m 644 deploy/nginx.conf /etc/nginx/sites-available/demo.m1ntch0c0.com
docker exec cpa-nginx nginx -t
docker exec cpa-nginx nginx -s reload
```

只新增 Demo 的站点与代理片段。证书沿用现有 `certbot.timer` 自动续期，以及 `/etc/letsencrypt/renewal-hooks/deploy/reload-cpa-nginx` 的校验和重载钩子。

讲解流使用 `application/x-ndjson`，响应带 `X-Accel-Buffering: no` 与 `Cache-Control: no-store, no-transform`。`/algostage/api/lecture` 使用独立 location，关闭代理缓冲、缓存及上下游压缩；共享代理片段的读超时为 300 秒，覆盖服务端 240 秒的生成上限并留出错误提示时间。更新时需同时安装 `nginx.conf` 和 `algostage-proxy.conf`；使用其他子路径时同步调整该 location。Demo 的 AI 禁用规则仍由应用执行。

发布前可在本机验证这份代理配置，无需连接线上站点或真实模型：

```sh
NGINX_BINARY=/usr/sbin/nginx npm test -- tests/nginx-streaming.test.ts tests/streaming-proxy.test.ts
```

集成回归启动独立 nginx 临时实例，将上述讲解 location 与共享代理片段原样用于真实讲解路由（仅替换端口和 include 文件路径）。测试使用假模型和临时数据库，检查首段与后续步骤在完成前分批送达、禁止压缩、客户端取消后上游中止且不缓存，以及超时提示能穿过代理送达。测试内缩短生成时限以避免等待四分钟，部署时限保持 240 秒。进程和临时文件会自动清理，不修改已有 nginx 服务。未安装 nginx 的本机可先运行普通单测；CI 安装 nginx 并强制执行这三条代理回归，指定无效的 `NGINX_BINARY` 会直接失败。

## 检查与停止

```sh
curl -I https://demo.m1ntch0c0.com/algostage
docker compose -f deploy/compose.yaml logs --tail=100 web
docker compose -f deploy/compose.yaml stop
```

更新前可记录旧镜像 ID：`docker inspect algostage-demo-algostage --format '{{.Image}}'`。需要回滚时把该镜像标记回 `algostage-demo:0.2.0`，再执行 `up -d --force-recreate --wait`。停止或回滚容器不会删除学习数据；不要运行带 `-v` 的 `down` 命令。

## 本次上线验证（2026-10-08）

生产构建与 TypeScript 检查通过，容器健康，nginx 配置检查通过。真实 HTTPS 站点的浏览器检查验证了内置讲课、访客独立进度、页面导航、移动端与减少动效模式；讲课生成、AI 提示和设置写入接口在 Demo 模式均返回 403，浏览器错误数为 0。首页已使用在线版说明。证书到期日为 2027-01-06，自动续期已启用。
