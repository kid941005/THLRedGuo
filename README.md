# THLRedGuo · Docker 网页版

项目仅维护 Docker 网页版。使用浏览器登录后，可浏览搜索、收藏追剧、观看历史、断点续播、自动连播、批量下载，并通过管理后台维护账号与任务。

## 已实现功能

| 功能 | 使用方式 |
| --- | --- |
| 用户账号 | 首次初始化管理员，管理员创建普通用户或其他管理员；支持改密和退出 |
| 收藏追剧 | 剧集详情设置想看、在看或已看完，在“我的追剧”查看 |
| 观看历史 | 播放后按账号保存剧集、分集和进度，支持单条删除与清空 |
| 断点续播 | 同一账号跨浏览器恢复进度；点“继续观看”回到最近一集 |
| 自动连播 | 播放结束后进入下一集，可按账号关闭 |
| 网页批量下载 | 每批最多选择 200 集，后台排队处理，支持取消、失败重试和重启恢复 |
| 保存文件 | 完成后保存单集，或选择最多 100 集合并 ZIP（单个 ZIP 小于 4GB） |
| 管理后台 | 用户创建、角色调整、停用/启用、密码重置、全站下载任务和操作记录 |

## 快速部署

在仓库根目录执行：

```bash
docker compose pull
docker compose up -d
```

本机打开 [http://127.0.0.1:8080/](http://127.0.0.1:8080/)。首次启动稍等片刻，可通过以下命令检查：

```bash
docker compose ps
docker compose logs --tail=100 gateway
curl -fsS http://127.0.0.1:8080/healthz
```

所有部署配置直接写在 [docker-compose.yml](docker-compose.yml)，不需要 `.env` 文件。默认端口只向宿主机开放；NAS 或局域网中的其他设备访问时，直接修改其中的端口映射：

```yaml
ports:
  - "0.0.0.0:8080:8080"
```

映射格式为“宿主机监听地址:宿主机端口:容器端口”。端口冲突时只修改中间的宿主机端口，例如 `0.0.0.0:18080:8080`，保持容器端口为 8080。保存后执行 `docker compose up -d`，随后打开 http://服务器局域网IP:端口/。

剧库、媒体、个人数据与下载接口均要求登录，普通用户只能查看自己的数据。公网使用 HTTPS 反向代理，将 /、/api/*、/gw/* 转发到同一来源的根路径；在 Compose 的 `environment` 中设置 `PUBLIC_ORIGIN: "https://你的域名"` 和 `COOKIE_SECURE: "1"`。局域网 HTTP 保持 `PUBLIC_ORIGIN: ""`、`COOKIE_SECURE: "0"`。

## 首次创建管理员

服务首次启动会在数据卷生成初始化口令。读取它：

```bash
docker compose exec gateway cat /app/data/setup-token
```

打开网页，填写用户名、至少十位密码和初始化口令，创建管理员后自动登录。口令文件随即删除，后续账号由“管理后台”创建，不开放游客注册。也可以在首次启动前直接填写 Compose 中的 `SETUP_TOKEN` 指定初始化口令；留空则自动生成。它不作为登录密码，也不会覆盖现有管理员。

Cookie 会话默认有效七天。修改密码、管理员重置密码或停用账号后，已有会话失效。账号密码使用带随机盐的 scrypt 散列保存；不要删除数据卷来尝试重置一个账号，否则所有用户和下载也会丢失。

## 从当前源码构建

本地源码修改后使用：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

覆盖文件使用 :dev 镜像标签。普通 docker compose up -d 使用 GHCR 已发布镜像，不包含尚未发布的本地修改。

## 更新与持久化

直接修改 Compose 的 `image` 标签选择版本，例如 `ghcr.io/kid941005/thlredguo-gateway:v1.4.0`；如需跟随最新版本，将标签改为 `latest`。然后执行：

```bash
docker compose pull
docker compose up -d
```

数据卷 thlredguo-gateway-data 挂载到 /app/data，存放 app.sqlite（账号、会话、收藏、历史、进度、下载任务）、downloads/（下载成品）、目录身份、内部密钥、播放注册身份和媒体缓存。升级保留该卷；docker compose down 默认保留数据，添加 -v 会删除数据。

备份时先停止容器，再备份整个数据卷，恢复时也使用整个卷，包含 SQLite 的关联文件。当前应用按单个容器实例设计，不应让多个副本共享同一数据库与任务目录。

两类身份均原子写入数据卷，重建容器后复用。播放身份默认有效期 30 天；过期或存储损坏后重新注册。健康检查分别返回 device_persisted 和 playback_device_persisted，后者在首次成功准备媒体后变为 true。

点击分集后，网页先轮询准备状态，下载、解密和封装完成后才启动播放器。首次准备最长等待四分钟；失败会显示实际错误，可重新点击本集重试。服务端取流仍依赖第三方接口与网络，健康检查正常不代表所有上游内容都可用。

播放后段会提前准备下一集；后台下载和预准备在资源繁忙时让位于当前播放。切集保留倍速与音量，进度保存不会阻塞切集。临时网络中断或持续卡住时最多自动恢复两次并保留已知位置，也可手动重试、切上一集/下一集。浏览器拒绝自动播放时会明确提示点击播放。

正在播放的缓存定期续租，减少缓存清理造成的拖动失效；尾部 moov 的未加密媒体会先封装成 faststart。当前仍采用“先完成本集下载和解密再播放”，冷启动的等待与片源大小、服务器出口和转码速度有关，并非低延迟直播。

## 配置

环境变量都直接填写在 `docker-compose.yml` 的 `services.gateway.environment` 中，使用带引号的字符串值；镜像版本和端口分别修改 `image`、`ports`。文件不含 `${...}` 变量插值，宿主机环境变量不会覆盖这些字面值。

| Compose 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| image | ghcr.io/kid941005/thlredguo-gateway:v1.4.0 | 镜像与版本标签 |
| ports | 127.0.0.1:8080:8080 | 宿主机监听地址、宿主机端口、容器端口 |
| CACHE_TTL_MIN | 180 | 解密缓存保留分钟，0 关闭时间淘汰 |
| CACHE_MAX_MB | 2048 | 解密缓存容量上限，0 不限容量 |
| CACHE_SWEEP_SEC | 300 | 缓存清理间隔，单位秒 |
| HONGGUO_CACHE_MAX_FILES | 0 | 可选成品文件数上限，0 不限数量 |
| MEDIA_CONCURRENCY | 2 | 下载解密并发数，范围 1～8 |
| HG_TRANSCODE | 0 | 设为 1 将媒体转为 H.264/AAC，适合不支持 HEVC 的浏览器 |
| PLAYBACK_IDENTITY_TTL_HOURS | 720 | 播放身份持久化有效期，单位小时 |
| DOWNLOAD_MAX_MB | 10240 | 全站下载成品与正在写入内容的容量上限，独立于播放缓存 |
| DOWNLOAD_CONCURRENCY | 2 | 后台下载任务并发数，范围 1～4 |
| SETUP_TOKEN | 自动生成 | 首次管理员初始化口令 |
| PUBLIC_ORIGIN | 空 | HTTPS 反向代理的完整来源，无路径或尾部斜杠 |
| COOKIE_SECURE | 0 | HTTPS 设 1；启用 Secure 会话 Cookie |
| TZ | Asia/Shanghai | 日志时区 |

缓存由取流进程统一管理。正在处理或播放的文件会受到保护；新成品有一分钟保护时间，因此繁忙时占用可暂时超过上限，后续清扫再回收。失败的半成品不会用于播放；旧版缓存不会被当作新版成品使用。

镜像使用 Node.js 24 和 ffmpeg；ffmpeg 同时支持标准 CENC 子样本解密回退、尾部 moov 封装和可选转码。开启转码后使用独立缓存，增加 CPU 开销。

下载文件不会被播放缓存清理自动删除。到达 DOWNLOAD_MAX_MB 后新任务会明确失败；删除不需要的已完成任务后可以重试。每个账号最多 500 个任务，全站最多 5000 个任务；收藏和观看历史各保留最多 500 部剧。重启后未完成任务重新排队，已完成文件和个人数据保留。下载是先保存到服务器，再由浏览器保存到本机；浏览器连续多文件限制可通过合并 ZIP 避免。

## 开发与验证

Node.js 24+ 和 ffmpeg，运行代码不需要安装 npm 依赖。YAML 静态校验额外需要 Python 与 PyYAML；CI 会安装它。测试中的真实媒体用例需要 ffmpeg，缺失时会明确跳过。

```bash
npm run check
npm test
npm run test:vendor
```

可选启用 Git 提交检查：bash tools/install-hooks.sh。

目录：

```text
server/
  gateway.js       网页入口与生命周期
  web/index.html   网页界面
  lib/             账号权限、SQLite、个人数据、下载队列、反代与进程守护
  vendor/          取址、设备注册、签名与解密实现
tests/             账号隔离、进度、下载恢复、媒体、网页竞争与真实 ffmpeg 回归测试
tools/             静态检查、自检与容器冒烟检查
.github/workflows/ 容器验证和 GHCR 发布
docker-compose.yml
docker-compose.build.yml
```

仅保留 checks.yml 和 docker.yml 两个工作流。v* 或 gw-* 标签以及手动运行可以发布 linux/amd64、linux/arm64 镜像，镜像名称继续使用 ghcr.io/kid941005/thlredguo-gateway。

[服务端维护说明](server/README.md)提供请求链路、运行参数与排障信息。第三方代码保留原许可证及来源信息，见 [vendor LICENSE](server/vendor/hongguo-web/LICENSE)。本项目用于技术学习；请遵守内容来源的使用规则和版权要求。
