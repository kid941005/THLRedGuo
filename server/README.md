# 红果网关（Docker）

把「红果短剧」的数据与取流能力放到服务端，客户端通过一个 JS 数据源脚本消费。
这样 iOS / tvOS 不再需要导入 APK，也能拿到服务端解密后的直链。

## 组成

```
server/
├── gateway.js               # 本仓库代码：对外 8080，下发 spider、反代 /gw/*、注入 api key
├── Dockerfile
└── vendor/hongguo-web/      # 第三方 MIT 组件（见 LICENSE），提供签名/解密/取流
    └── server/src/main.js   # 内置服务，容器内监听 127.0.0.1:8000
assets/sources/hongguo_gw.js # 下发给客户端的数据源脚本（占位符由网关注入）
```

## 起服务

```bash
docker compose up -d --build
curl http://127.0.0.1:8080/healthz
```

预期返回：

```json
{"ok":true,"uptime_s":9,"upstream":"http://127.0.0.1:8000","has_key":true,
 "source":"/sources/hongguo_gw.js"}
```

`ok` 为 `false` 表示内置服务还没就绪（启动后约 3–10 秒），或签名后端异常。

### 没有 Docker 时：本地直跑

网关本身零依赖，只要有 Node 18+ 就能跑，用于验证逻辑与数据源，不必先做镜像：

```bash
node server/gateway.js
curl http://127.0.0.1:8080/healthz
```

与容器内行为一致的部分：反代与鉴权注入、spider 下发与地址注入、缓存清理、上游进程监管。
**不一致的部分**：Node 版本与镜像基础镜像（alpine/musl）、路径与文件权限、健康检查探针（`wget`）、卷挂载与端口映射。
也就是说——**逻辑问题不用镜像就能查出来，只有"打包/运行环境"问题必须构建镜像**。

## 接到 App

1. App → 设置 → JS 数据源插件管理 → **网络订阅 / URL 导入插件**
2. 填：`http://<服务器IP>:8080/sources/hongguo_gw.js`
3. 导入后切换站源为「红果网关（自建）」

脚本里的网关地址是**按请求 Host 动态注入**的，所以同一份镜像部署到
`192.168.1.10:8080` 或 `drama.example.com` 都能直接用；放在反向代理后面时，
设置 `PUBLIC_BASE=https://drama.example.com` 可强制指定对外地址。

## 接口

| 路径 | 说明 |
| :--- | :--- |
| `GET /healthz` | 健康检查（是否就绪、是否已拿到 api key） |
| `GET /sources/hongguo_gw.js` | 下发数据源脚本（自动注入基址与默认清晰度） |
| `ANY /gw/*` | 反代到内置服务，自动补 `x-api-key` |
| `GET /` | 端点自述 |

`/gw/` 下可用：`rank` `browse` `latest` `search` `episodes` `play` `stream` `video_url` `img`。
密钥由网关进程启动时自动向内置服务申请，客户端不需要也不应该知道。

## 环境变量

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `8080` | 对外端口 |
| `HK_PORT` | `8000` | 内置服务端口（仅容器内） |
| `PUBLIC_BASE` | 空 | 对外基址覆盖，反向代理场景使用 |
| `HK_QUALITY` | `best` | 注入脚本的默认清晰度 |
| `HONGGUO_DATA_DIR` | `/app/data` | 设备身份与缓存根目录，**必须挂卷** |
| `HONGGUO_STREAM_CACHE` | `/app/data/stream-cache` | 解密成品缓存目录 |
| `CACHE_TTL_MIN` | `180` | 缓存保留分钟数，`0` 表示不按时间淘汰 |
| `CACHE_MAX_MB` | `2048` | 缓存总量上限，`0` 表示不限 |
| `CACHE_SWEEP_SEC` | `300` | 清理扫描间隔（秒） |
| `HG_TRANSCODE` | `0` | 是否开启转码；取流是纯解密，默认关闭 |

`/healthz` 会回报 `cache` 字段（目录、文件数、占用 MB），可用来确认清理是否生效。

## 排障

### 1. `/healthz` 一直 `ok:false`

内置服务没起来或端口被占用。看容器日志里 `[gateway]` 之前的报错：

```bash
docker logs -f thlredguo-gateway
```

常见原因：`HK_PORT` 被改成了容器里也被占用的端口；`server/vendor/hongguo-web/server/src/main.js` 没被 COPY 进镜像（构建上下文被 `.dockerignore` 挡了）。

### 2. `/gw/*` 返回 502，body 是「App 接口未返回 data（空响应，疑似设备身份被拒）」

**这是上游风控，不是网关故障。** 触发条件实测包括：出口 IP 不稳定、机房 IP、device_id 频繁变化、短时间请求过多。

对策按收益排序：
1. 确认 `/app/data` 已挂卷（device_id 持久化），重启后 `/app/data` 里应有设备身份文件；
2. 换稳定出口（家宽/固定 IP，或给容器配固定代理出口）；
3. 降低频率（别并发刷详情）；
4. 若长期不可用，改回设备端源 `hongguo-web`（360P 试看，但不受服务端风控影响）。

### 3. 客户端导入脚本失败

先在服务器本机确认：

```bash
curl -s http://127.0.0.1:8080/healthz
curl -s http://127.0.0.1:8080/sources/hongguo_gw.js | head -5
```

再在手机/电视的同一网络里用浏览器打开 `http://<IP>:8080/healthz`。打不开就是网络层问题：容器只监听 8080（已 `0.0.0.0`），检查防火墙、安全组、以及是否误填了 `127.0.0.1`。

### 4. 磁盘一直涨

解密成品会落在 `HONGGUO_STREAM_CACHE`。网关默认每 5 分钟清理一次（TTL 180 分钟 / 上限 2 GB），可用 `CACHE_TTL_MIN`、`CACHE_MAX_MB` 调整；`/healthz` 的 `cache.files` 与 `cache.mb` 能直接看出当前占用。

### 5. `docker build` 失败

先确认构建上下文正确（必须在**仓库根目录**执行，因为 Dockerfile 要 COPY 两处路径）：

```bash
docker build -f server/Dockerfile -t thlredguo-gateway .
```

若报 `COPY failed`，检查 `.dockerignore` 是否把 `server/` 或 `assets/sources/hongguo_gw.js` 排除了。

## 已知限制（实测 2026-10-31）

| 项 | 状态 |
| :--- | :--- |
| `/health`、`/api-key`、`/rank`、`/episodes` | 正常 |
| `/stream` 取流 | **当前网络下上游返回「App 接口未返回 data（空响应，疑似设备身份被拒）」**，属上游风控，非网关问题 |
| `/browse`、`/latest`、`/search` | 结构正常，但当前网络下返回空列表（同上，风控） |
| 部署要求 | 出口 IP 稳定、能连通 `*.fqnovel.com` / `*.snssdk.com`；频繁换 IP 或机房 IP 更易被拒 |

上游风控通过后 `/stream` 即可用；失败时 App 侧的按集回退会把这一集交给
`hongguo-web` 源（360P 试看），不会直接黑屏。

## 许可证

- `server/gateway.js`：随本仓库。
- `server/vendor/hongguo-web/`：MIT，原文见 `server/vendor/hongguo-web/LICENSE`。
  仅引入运行所需部分：`server/src`、`server/config/config.json`（模板）、`package.json`、`LICENSE`、`README.md`；
  已移除上游的 web 前端、`.github` 工作流、截图与打包脚本。逻辑未做修改，升级时整体替换即可。
- **运行期生成、不入库**：`server/config/apikeys.json`（本地 api key / admin token / device_id）、
  `data/`（解密缓存与设备状态）。已在 `.gitignore` 中排除，容器内对应 `/app/data` 卷。
