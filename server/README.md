# 红果网关（Docker）

把「红果短剧」的数据与取流能力放到服务端，客户端通过一个 JS 数据源脚本消费。
这样 iOS / tvOS 不再需要导入 APK，也能拿到服务端解密后的直链。

## 组成

```
server/
├── gateway.js               # 入口：只装路由与启停生命周期
├── lib/
│   ├── config.js            # 路径与环境变量（唯一取值处）
│   ├── http.js              # JSON 响应、对外基址推导
│   ├── upstream.js          # 内置服务守护、密钥托管、设备身份备份
│   ├── proxy.js             # /gw/* 反向代理（含 401 重取密钥后重放）
│   └── cache.js             # 解密流缓存清理（TTL + 容量）
├── web/index.html           # 内置网页界面（单文件，零外链）
├── Dockerfile
└── vendor/hongguo-web/      # 第三方 MIT 组件（见 LICENSE），提供签名/解密/取流
    └── server/src/main.js   # 内置服务，容器内监听 127.0.0.1:8000
assets/sources/hongguo_gw.js # 下发给客户端的数据源脚本（占位符由网关注入）
```

## 起服务

镜像由 GitHub Actions 构建并推送到 GHCR（`linux/amd64` + `linux/arm64`）。
`docker-compose.yml` **只引用镜像，不含 build**，所以拉取与构建互不干扰。

```bash
docker compose pull
docker compose up -d
curl http://127.0.0.1:8080/healthz
```

> 首次启动要等内置服务就绪（通常 5–10 秒），在此之前 `/healthz` 返回 **503**（`ok:false`），属正常现象。
> 就绪后返回 200 且 `ok:true`、`has_key:true`、`device_persisted:true`。

固定版本，避免 `latest` 漂移：

```bash
GW_TAG=v1.1.1 docker compose up -d
```

**从源码构建**时叠加覆盖文件（base 文件保持干净）：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

覆盖文件把镜像打成 `:dev` 标签，不会覆盖 ghcr 上的 `:latest` / `:v1.1.1`，
避免之后 `pull` 被本地产物遮蔽（这是把 `build` 与 `image` 写在同一文件里的常见坑）。

端口冲突时改宿主机端口：`GW_PORT=18080 docker compose up -d`。

### 浏览器验证

起服务后直接打开 `http://<服务器IP>:8080/`（端口映射到别处就换成你的端口，例如 NAS 上的 `31080`），
会看到内置的剧库页面：顶部是榜单/分类标签，点卡片可看简介与分集，选一集直接在页面里播放。

页面完全本地化（无 CDN、无外链脚本），断网也能打开界面；封面图来自上游 CDN，取不到时留白不报错。
如果列表是空的，页面会明确区分「上游风控返回空」和「请求失败」——前者等一会儿再试就行。

### 网络暴露（重要）

网关**没有鉴权**：`/gw/*` 谁都能调，调用方借的是容器里的设备身份。
所以默认只绑定回环地址（`GW_BIND` 默认 `127.0.0.1`），此时只有宿主机自己能访问。

| 场景 | 做法 |
| :--- | :--- |
| 只有本机用（例如同机转码/调试） | 保持默认，不动 |
| 电视/手机在同一局域网 | `GW_BIND=0.0.0.0 docker compose up -d`，并确保该端口不暴露到公网 |
| 需要公网访问 | 保持回环，前面挂一层带鉴权（Basic Auth / IP 白名单）的反向代理，把 `/sources/*` 与 `/gw/*` 转发进来 |

导入脚本时地址要跟着改：局域网场景填 `http://<局域网IP>:8080/sources/hongguo_gw.js`；
反向代理场景填对外域名，并给网关设 `PUBLIC_BASE=https://你的域名`（否则脚本里注入的是内网地址）。

> 包可见性继承仓库：当前仓库公开，镜像同样**公开**，无需登录即可拉取。
> 若日后仓库转为私有，需先 `docker login ghcr.io -u <用户名> -p <PAT>`。
> 已验证镜像包含 `linux/amd64` 与 `linux/arm64` 两个架构。

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
   —— 注意：默认只监听 `127.0.0.1`，手机/电视要访问必须先用
   `GW_BIND=0.0.0.0 docker compose up -d` 放开（见「网络暴露」）。
   若此时仍连不上，说明是网络层问题（防火墙 / 安全组 / 不在同一网段），不是脚本问题。
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
| `GET /` | 内置网页界面（浏览器直接打开，可浏览/搜索/播放） |
| `GET /api` | 端点自述 JSON（脚本用；原 `/` 的返回） |

`/gw/` 下可用：`rank` `browse` `latest` `search` `episodes` `play` `stream` `video_url` `img`。
密钥由网关进程启动时自动向内置服务申请，客户端不需要也不应该知道。

### 标签策略

- `v*`（如 `v1.1.1`）：会同时触发仓库已有的 App 打包工作流（macOS runner，耗时且计费）。
- `gw-*`（如 `gw-v1.2.0`）：**只构建网关镜像**，不触发 App 打包，仅调整网关时推荐用这个前缀。

## 环境变量

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `8080` | 对外端口 |
| `HK_PORT` | `8000` | 内置服务端口（仅容器内） |
| `PUBLIC_BASE` | 空 | 对外基址覆盖，反向代理场景使用 |
| `HK_QUALITY` | `best` | 注入脚本的默认清晰度 |
| `HONGGUO_DATA_DIR` | `/app/data` | 解密缓存根目录 + 设备身份备份目录，**必须挂卷** |
| `HONGGUO_STREAM_CACHE` | `/app/data/stream-cache` | 解密成品缓存目录 |
| `CACHE_TTL_MIN` | `180` | 缓存保留分钟数，`0` 表示不按时间淘汰 |
| `CACHE_MAX_MB` | `2048` | 缓存总量上限，`0` 表示不限 |
| `CACHE_SWEEP_SEC` | `300` | 清理扫描间隔（秒） |
| `HG_TRANSCODE` | `0` | 是否开启转码；取流是纯解密，默认关闭 |

`/healthz` 会回报 `cache`（目录、文件数、占用 MB）与 `device_persisted`（设备身份备份是否就位）。
内置服务未就绪时返回 **503**，因此 Docker 健康检查能真实反映故障，而不是永远“通过”。

### 设备身份是怎么持久化的

内置服务把 `device_id`、api key、管理口令写在 `server/config/apikeys.json`（相对 vendor 根目录，
**不受 `HONGGUO_DATA_DIR` 影响**）。这个位置在镜像层里，容器重建就会丢，于是网关做了两层：

1. 启动前：若镜像内的 `apikeys.json` 缺失而卷里有 `$HONGGUO_DATA_DIR/apikeys.json`，先还原；
2. 拿到密钥后：把 `apikeys.json` 备份到 `$HONGGUO_DATA_DIR/apikeys.json`（临时文件 + 改名）。

所以 **只要卷还在，重建容器、升级镜像都不会换 `device_id`**。删卷则会换。

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
1. 确认 `/app/data` 已挂卷，且 `curl /healthz` 里 `device_persisted` 为 `true`
   （卷里应有 `/app/data/apikeys.json`，容器重建后网关会自动还原同一个 device_id）；
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

### 5. 校验报 `services.gateway additional properties 'name' not allowed`

`name` 是**项目级键**（顶层、缩进 0），不是服务键。服务里指定容器名要用 `container_name`。

```yaml
name: thlredguo          # ✅ 顶格：项目名（可选，决定默认卷名前缀）
services:
  gateway:
    container_name: thlredguo-gateway   # ✅ 服务内：容器名
```

出现这个报错，基本是编辑时把 `name:` 那行多缩进了两个空格，或者手写时写进了 `services.gateway`。
用编辑器打开对齐一下即可；`grep -n "^\s*name:" docker-compose.yml` 能直接看到它在第几列。

顺带提醒：**默认只监听 `127.0.0.1`**，NAS 上部署给电视用时要么写 `"8080:8080"`，
要么 `GW_BIND=0.0.0.0`，否则容器正常但电视连不上。

### 6. `docker build` 失败

先确认构建上下文正确（必须在**仓库根目录**执行，因为 Dockerfile 要 COPY 两处路径）：

```bash
docker build -f server/Dockerfile -t thlredguo-gateway:dev .
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
- **运行期生成、不入库**：`server/vendor/hongguo-web/server/config/apikeys.json`（api key / admin token / device_id）
  与 `server/stream-cache`、`download/`。已同时写进 `.gitignore` 与 `.dockerignore`——
  镜像要推到公开的 GHCR，这些文件一旦被 COPY 进去就等于泄露设备身份。
  容器内运行时对应 `/app/data` 卷（`apikeys.json` 备份 + `stream-cache`）。
