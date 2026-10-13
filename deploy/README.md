# 自托管完整版部署

- 地址（自托管实例 URL，沿用现网 DNS）：<https://demo.m1ntch0c0.com/algostage>
- 服务器：`root@cpa-direct.m1ntch0c0.com`
- 源码目录：`/opt/algostage`（现网旧路径待 D5 迁移）
- 镜像：`algostage:0.2.0-alpha.2`（无 Demo 模式）
- 容器：`algostage`，仅绑定 `127.0.0.1:3100`
- 数据卷：`algostage-data`，SQLite 位于 `/data/algostage.db`
- DNS：`demo.m1ntch0c0.com` 的 A 记录指向 `43.255.156.149`，DNS only

构建时设定 `/algostage` 子路径，运行完整的本地/自托管产品：讲课、学习进度记录、学习看板以及 AI（BYOK 自带模型密钥）均完整可用。上传源码时排除 `.env*`、本地数据库、`.git`、`node_modules` 和 `.next`。

## 构建与启动

在服务器源码目录执行（`<版本>` 取 `package.json` 的 `version`，例如 `0.2.0-alpha.2`；`compose.yaml` 中 `ALGOSTAGE_IMAGE_TAG` 默认也是该版本）：

```sh
docker buildx build --allow network.host --network host --build-arg BASE_PATH=/algostage -t algostage:<版本> --load .
ALGOSTAGE_IMAGE_TAG=<版本> docker compose -f deploy/compose.yaml up -d --no-build --wait
ALGOSTAGE_IMAGE_TAG=<版本> docker compose -f deploy/compose.yaml ps
```

此服务器 Docker 默认桥接网络不能访问外网，因此使用 `docker buildx build` 并开启 `host` 网络构建（`--allow network.host --network host`）。运行容器仍使用隔离网络和回环端口，数据卷在重建时保留。修改实例子路径需重新构建，并同步修改 nginx 路径和健康检查。

`JUDGE_MAX_CONCURRENCY` 限制的是**单个进程**内同时进行的服务端判题数（默认 4，最大 64）；多实例部署时各进程各自计数。

## 数据卷迁移说明

若从旧卷 `algostage-demo-algostage-data` 迁移至 `algostage-data`，可先创建外部命名卷并用一次性容器拷贝 `/data` 数据（如 `docker volume create algostage-data` 后挂载两卷复制 `algostage.db`）。迁移与维护期间**切勿**运行 `docker compose down -v`，以免误删持久化数据卷。

### 升级至 0.2.1：非 root 运行

镜像改用 `algostage` 用户（UID/GID `1001:1001`）运行。镜像内 `DATA_DIR=/data`，继续使用现有数据卷和 `/data/algostage.db`；入口脚本会先检查数据目录是否可写，失败时输出当前 UID 和修复命令并退出，不在应用容器内执行 `chown`。

旧卷若由 root 拥有，请按顺序升级：

1. 停止旧容器，备份数据库（包括仍存在的 SQLite `-wal` / `-shm` 文件）。
2. 对旧卷执行一次权限修复：

   ```sh
   docker run --rm -v algostage-data:/data alpine chown -R 1001:1001 /data
   ```

3. 切换至新镜像，按「构建与启动」中的 Compose 命令启动。

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

只新增自托管实例的站点与代理片段。证书沿用现有 `certbot.timer` 自动续期，以及 `/etc/letsencrypt/renewal-hooks/deploy/reload-cpa-nginx` 的校验和重载钩子。

讲解流使用 `application/x-ndjson`，响应带 `X-Accel-Buffering: no` 与 `Cache-Control: no-store, no-transform`。`/algostage/api/lecture` 使用独立 location，关闭代理缓冲、缓存及上下游压缩；共享代理片段的读超时为 300 秒，覆盖服务端 240 秒的生成上限并留出错误提示时间。更新时需同时安装 `nginx.conf` 和 `algostage-proxy.conf`；使用其他子路径时同步调整该 location。

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

更新前可记录旧镜像 ID：`docker inspect algostage --format '{{.Image}}'`。需要回滚时把该镜像标记回 `algostage:<版本>`，再执行 `ALGOSTAGE_IMAGE_TAG=<版本> docker compose -f deploy/compose.yaml up -d --no-build --force-recreate --wait`。停止或回滚容器不会删除学习数据；不要运行带 `-v` 的 `down` 命令。

## 环境变量（自托管）

`HINT_TIMEOUT_MS` 控制提示接口上游超时（毫秒，默认 60000）。

`ALGOSTAGE_DISABLE_SERVER_KEY` 默认 `false`，此公网 Compose 明确设为 `true`。打开后，`GET /api/settings` 返回 `serverKeyDisabled: true`、`keySource: "none"`，不返回任何 Key 掩码；`PUT /api/settings` 一律返回 403 `SETTINGS_LOCKED`（「公共实例不支持修改服务器设置」），已有设置保持原样。讲课、提示和显式测试连接必须在 POST 请求体的 `byok.apiKey` 中带上自己的 Key，否则返回 400 `NO_BYOK`，绝不回退到环境变量或数据库 Key。请求 Key 只用于当次上游鉴权，不放入 URL，也不写入数据库、讲课缓存、提示消耗记录或日志（含错误日志）。`byok.baseURL`、`byok.model` 可选。

无论此开关是否打开，服务器 Key 只发送到服务器配置的接口地址。请求中的 `byok.baseURL` 规范化后与服务器地址不同时，必须同时提供 `byok.apiKey`，否则返回 400 `BYOK_KEY_REQUIRED`（「用自定义地址时需要同时填你自己的 Key」），不发起模型请求。关闭开关时，地址相同且未传 Key 的请求可以使用服务器 Key。请求中的新地址在查缓存或调用模型前完成语法、IP 和 DNS 校验；非法或被拦截的地址返回 400 `BASE_URL_NOT_ALLOWED`（「只支持公网 http(s) 地址」），连接失败、重定向和上游错误仍统一返回固定文案的 502。上述新错误码同时提供 `code`、`error` 与友好的 `message`，兼容现有调用方。

`ALGOSTAGE_ALLOW_PRIVATE_BASE_URL` 默认 `true`，允许自托管连接本地模型。此公网 Compose 明确设为 `false`：AI 接口的 IP 或任一 DNS 结果为私网、回环或保留地址时拒绝连接；连接固定到验证过的 IP，所有模式均禁止上游重定向。如需连接内网模型，请仅在可信自托管环境中改为 `true`。

`ALGOSTAGE_EGRESS_ALLOW_HOSTS` 可为 `false` 模式配置私有接口例外，例如 `cpa-direct.m1ntch0c0.com,ai.internal.example`。填写逗号分隔的完整主机名，忽略大小写、两端空格和末尾的一个点；含 `*` 的条目被忽略，不匹配子域名或域名后缀，也不要填写协议、端口或路径。仅按 WHATWG URL 解析出的 hostname 精确匹配，userinfo 不参与判断。白名单只豁免私有/保留 IP 限制：仍只允许 http(s)，DNS 结果仍固定到实际连接，任何重定向均拒绝，上游错误只返回固定文案。Compose 通过同名环境变量传入，修改后需重建容器。

设置保存只做语法、IP 和 DNS 校验，不调用模型、不产生模型费用；非法语法或被禁止的地址返回 400 `BASE_URL_NOT_ALLOWED`（「接口地址只支持公网 http(s) 地址。」），整次更新不落库。模型连接测试仅由显式调用 `POST /api/settings/test-connection` 触发（可能计费），测试本身不保存设置。实际提示/讲课会在每次出站时重新校验并固定 DNS，因而保存后 DNS 变化也不能绕过限制。

出站审计：提示、讲课生成/重试/重新生成/缓存未命中和显式设置连接测试均经共享 provider 与 egress guard；`scripts/verify-live-lectures.ts` 也复用讲课路由。仓库没有模型列表请求、定时模型健康探测或缓存预取请求。Compose 健康检查只访问固定的容器内应用地址，浏览器的数据请求使用站内 API 路径，均不使用用户或环境变量中的模型地址。

## 上线验证

生产构建与 TypeScript 检查通过，容器健康，nginx 配置检查通过。真实 HTTPS 站点的浏览器检查覆盖内置讲课、学习进度记录、学习看板、设置（BYOK）、页面导航、移动端与减少动效模式，浏览器错误数为 0。证书到期日为 2027-01-06，自动续期已启用。
