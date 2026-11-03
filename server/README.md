# Docker 网页服务维护说明

部署入口与常用命令见[根目录 README](../README.md)。维护对象为容器内网页和服务端，不再提供 App 数据源脚本下发接口。

## 请求链路

浏览器访问 gateway.js 的 /，网页以同源请求调用 /gw/*。网关注入内部 x-api-key 后反代至 127.0.0.1:8000，内置服务负责列表、搜索、分集与媒体取流。内部密钥不需要配置到浏览器。

gateway 同时通过 lib/application.js 提供账号、个人数据、下载和后台 API。SQLite 使用 Node 24 内置 node:sqlite，WAL、外键和事务开启；业务接口按会话中的 user_id 隔离，客户端提交的 user_id 不作为权限依据。

| 路径 | 行为 |
| --- | --- |
| GET /、/index.html | 网页界面 |
| GET /api | 服务端点清单 |
| GET /healthz | 启动就绪、密钥与缓存摘要 |
| GET /gw/prepare?vid=编号&quality=best | 立即返回 preparing、ready 或 failed；retry=1 显式重试失败任务 |
| GET/HEAD /gw/stream?vid=编号&quality=best | 成品媒体读取，支持 Range |
| /gw/rank、browse、latest、search、episodes、filters、img、health | 网页所需的数据接口 |
| /api/auth/status、setup、login | 首次初始化与登录 |
| /api/auth/me、logout、password | 当前账号、退出、修改密码 |
| /api/favorites、/api/history、/api/library/:series | 个人追剧与观看记录 |
| /api/playback/start、/api/progress、/api/preferences | 播放会话、续播进度与自动连播偏好 |
| /api/downloads、/:id、/:id/file、/archive?ids=... | 创建/查询下载、取消/重试/删除、保存单集与 ZIP |
| /api/admin/summary、users、users/:id、downloads | 管理员概况、用户管理和全站任务 |

除网页、健康检查、端点清单和初始化/登录入口外，其余接口均要求有效会话。修改请求使用 JSON、同源校验与 X-CSRF-Token（由 /api/auth/me 返回）；跨站请求和越权访问会被拒绝。Cookie 为 HttpOnly、SameSite=Strict，HTTPS 部署配置 Secure。密码重置、改密、停用和角色变更会使相关旧会话失效。至少保留一位启用的管理员。

已移除 /sources/*。网页、接口和视频使用同一来源，不需要对外地址占位符或 PUBLIC_BASE。暂不支持把网页部署在反向代理的任意子路径下。

## 文件与运行参数

- gateway.js：装配路由与启停；作为模块导入时不启动进程，createGatewayServer 供接口测试使用。
- lib/upstream.js：子进程守护、持续探活、内部密钥获取与旧身份迁移。
- lib/proxy.js：HTTP 透传与密钥过期后的重试。
- lib/database.js、accounts.js：数据库迁移、账号、scrypt 密码和会话。
- lib/library.js：追剧、历史、逐集进度；使用播放会话和序号忽略迟到的旧进度。
- lib/downloads.js、zip.js：持久任务、有界下载、容量限制、文件权限和流式 ZIP。
- vendor 的 service/cache-store.js：统一管理缓存容量、TTL、文件数量和活动引用。
- vendor 的 service/stream.js：有界下载、独立工作目录、原子发布与准备状态；解密在 Worker 中运行。
- vendor/hongguo-web：保留第三方运行时代码和许可证；本地修改记录见 LOCAL-CHANGES.md。

| 进程环境变量 | 容器默认 | 说明 |
| --- | --- | --- |
| PORT | 8080 | 网页入口端口 |
| HK_PORT | 8000 | 内部服务端口 |
| HONGGUO_DATA_DIR | /app/data | 缓存根目录与设备身份备份 |
| HONGGUO_STREAM_CACHE | /app/data/stream-cache | 解密缓存目录 |
| CACHE_TTL_MIN | 180 | 时间淘汰，单位分钟 |
| CACHE_MAX_MB | 2048 | 容量淘汰，单位 MB |
| CACHE_SWEEP_SEC | 300 | 清扫间隔，单位秒 |
| HONGGUO_CACHE_MAX_FILES | 0 | 可选文件数上限，直接在 Compose 中配置 |
| MEDIA_CONCURRENCY | 2 | 处理并发，范围 1～8，最多排队 64 个请求 |
| HG_TRANSCODE | 0 | 取流默认不转码 |
| PLAYBACK_IDENTITY_TTL_HOURS | 720 | 播放身份持久化有效期 |
| TZ | Asia/Shanghai | 时区 |

部署环境变量直接写在 `docker-compose.yml` 的 `environment` 中，不使用 `.env` 或变量插值。修改后执行 `docker compose up -d` 重建容器。镜像包含 ffmpeg，`HG_TRANSCODE: "1"` 可以启用 H.264/AAC 转码；转码后使用独立缓存。

内部密钥和目录身份通过 HONGGUO_KEY_FILE 直接原子写入 /app/data/apikeys.json；播放身份单独写入 /app/data/playback-device.json。旧版卷中的 apikeys.json 可直接复用；旧镜像层里的身份文件只用于一次迁移。日志不输出完整密钥和管理口令。

## 验证与排障

启动故障先看 docker compose logs --tail=100 gateway。健康检查会实际探测内部 /health 和 /api-key；缺少有效密钥、内部进程无响应时返回 503。后台每五秒探测，状态超过十五秒未更新也不视为就绪；长期不响应会重启内部子进程，停机时不会再次拉起。HTTP 200 只确认本地服务，不代替上游取流验收。

CI 运行静态检查、完整回归测试与 vendor 离线自检，再构建镜像，挂载测试并在 Alpine 容器内执行媒体回归。容器冒烟由 tools/container_smoke.cjs 执行，不依赖真实上游：

```bash
node tools/container_smoke.cjs http://127.0.0.1:8080
```

真实播放验收需额外覆盖：冷/热缓存、首屏到续页、失败重试、清扫期间取流、Range 拖动、容器重建以及目标浏览器媒体兼容性。没有上游错误响应或网络证据时，不应直接把空列表和播放失败归类为风控。

网关不转发 /gw/api-key、/gw/admin/*、/gw/download/task。批量下载走新的 /api/downloads，拥有独立的任务、配额与账号权限；只有任务所有者或管理员可以保存文件和操作任务。文件路径只由服务端生成的 UUID 构成，剧名只用于下载文件名。

任务启动时先从内部 /episodes 验证所选分集，再使用 /prepare 和 /stream 取得服务端成品，写入 downloads/:id.mp4.part，完成后原子更名。启动会恢复排队中的任务并清理未完成的 .part；下载空间统计覆盖已完成文件和活动写入，取消后清理半成品。单任务最多 512MB，执行最长十分钟；下载请求不受网页关闭影响。

首次启动的 /app/data/setup-token 只用于初始化管理员；建好后删除。账号数据库位于 /app/data/app.sqlite，备份和迁移需停机复制完整数据卷。当前只支持单实例任务管理。

首次媒体请求可先调用 /gw/prepare，准备成功后再读取 /gw/stream；Range 读取不会被用于触发一个字节的冷缓存探测。网页对快速切换、关闭详情和重新搜索都使用取消信号与请求代次，旧响应不会覆盖新状态。

### 所有分集报空响应

v1.4.2 同时修复目录请求协议与错误分类。仅“点击分类”失败时可在宿主机执行 `docker exec thlredguo-gateway node /app/server/tools/playback-diagnose.cjs --catalog`，输出分类结果，不下载媒体。

v1.4.1 已将播放请求切换到独立维护的当前签名协议。若旧版显示“App 接口未返回 data（空响应，疑似设备身份被拒）”，先将 Compose 的 image 更新为 v1.4.1，然后 pull/up；无需删除数据卷或设备身份。

持续失败时，v1.4.1 会在网页与容器日志提供 PLAYBACK_EMPTY_RESPONSE 等错误码，以及 HTTP 状态、正文长度、content-type 和上游 log-id；不输出设备 ID、Cookie 或正文。空响应只用原身份补试一次备用域名，连续失败冷却六十秒，避免反复点击刷新请求。

在部署服务器执行以下诊断，仅检测容器的 DNS/TLS/HTTP，不调用注册或取流：

```bash
docker compose exec gateway node /app/server/tools/playback-diagnose.cjs
```

如需实际验证一集，在命令末尾加当前失败分集的 vid：

```bash
docker compose exec gateway node /app/server/tools/playback-diagnose.cjs 分集vid
```

取流诊断会复用已有播放身份（没有身份时正常注册），仅输出是否取得片源及脱敏错误，不下载视频。根路径 HTTP 404/504 只能说明该根路径的响应，不能单独用来判断业务接口风控或播放失败原因。

如果升级后仍有 PLAYBACK_EMPTY_RESPONSE，使用以下对照命令。它先用已有身份测试，再在临时目录注册一个隔离身份测试同一分集，结束后清理临时目录，不替换原身份：

```bash
docker exec thlredguo-gateway node /app/server/tools/playback-diagnose.cjs 7693917197759958040 --compare --catalog
```

若只有临时身份成功，可进一步核对已有身份；如果二者都失败，单独重置身份没有改善证据，应对比出口网络和协议指纹。诊断只显示代理环境变量是否存在，不输出代理地址或凭据。程序不会因空响应自动更换身份。

播放每二十秒刷新成品租约（四十五秒保护窗口），播放后段预准备下一集。后台下载与推测准备使用 background=1，忙时不会抢占前台请求的排队位置；已开始的下载/解密不能被强制抢占。准备响应包含 stage（排队、下载、解密或封装），网页先短间隔探测再退回普通轮询。

网络错误恢复会重建本集媒体地址并回到最后已知位置，保留倍速/音量；最多两次自动恢复。HTTP 失败可能被浏览器报告为“不支持媒体”，此时用一个字节的已准备媒体读取区分登录失效、网络失败与编码不兼容。持续无法解码应开启 H.264 转码。恢复不会绕过权限，也不会对未知编码无限重试。

## 第三方维护

保留 vendor 的原始许可证与来源注释。修改 vendor 时应保留来源说明，并运行 npm run test:vendor；离线算法自检通过不能替代网页与容器的集成测试。
