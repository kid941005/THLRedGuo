/**
 * 红果网关数据源 (hongguo_gw.js)
 * 适配 CatPawOpen / CatVodOpen 标准规范 v1.0.4
 *
 * 与 hongguo.js / hongguo_web.js 的区别：
 *  - 取流与签名不在设备端完成，而是由自建 Docker 网关（server/gateway.js）代理；
 *  - 因此 iOS/tvOS 无需导入 APK，也能拿到服务端解密后的高清直链；
 *  - 代价：必须能访问网关地址，网关必须能连通红果上游。
 *
 * 本文件由网关动态下发（/sources/hongguo_gw.js），
 * 文件顶部的地址与清晰度占位符会在下发时被替换为实际值。
 * 直接当作本地插件导入会因地址为空而报 GATEWAY_NOT_CONFIGURED。
 */

const meta = {
  id: "hongguo-gw",
  name: "红果网关（自建）",
  version: "1.0.0",
  description: "自建 Docker 网关供流，服务端签名与解密，无需导入 APK",
  author: "THL gateway",
  type: "video",
  icon: "",
  features: ["categories", "search"]
};

const GATEWAY = "__GATEWAY_BASE__";
const QUALITY = "__GATEWAY_QUALITY__";
const PAGE_SIZE = 18;

// ---------------------------------------------------------------- 工具

function asString(value) {
  return value === null || value === undefined ? "" : String(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(text) {
  if (!text) return "";
  return String(text).replace(/<[^>]+>/g, "").trim();
}

function gatewayRoot() {
  const base = asString(GATEWAY).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("GATEWAY_NOT_CONFIGURED");
  return base;
}

async function api(pathname) {
  const url = gatewayRoot() + "/gw" + pathname;
  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    timeoutMs: 20000
  });
  const status = resp && typeof resp.status === "number" ? resp.status : 0;
  let body = resp && resp.body;
  if (resp && typeof resp.text === "function") body = await resp.text();
  if (status !== 200) {
    let detail = "";
    try {
      const parsed = JSON.parse(body);
      detail = parsed && (parsed.error || parsed.detail) ? String(parsed.error || parsed.detail) : "";
    } catch (_) {}
    throw new Error("GW_HTTP_" + status + (detail ? ":" + detail : ""));
  }
  let data = null;
  try {
    data = JSON.parse(body);
  } catch (_) {}
  if (!isObject(data)) throw new Error("GW_INVALID_JSON");
  return data;
}

/** 网关条目 → 标准 vod 结构 */
function toVod(item) {
  const seriesId = asString(item.series_id || item.seriesId || item.id);
  const episodes = Number(item.episode_cnt || item.episodeCount || 0);
  const tags = Array.isArray(item.tags) ? item.tags.filter(function (t) { return !!t; }) : [];
  return {
    vod_id: seriesId,
    vod_name: cleanText(item.title || item.name) || ("短剧 " + seriesId),
    vod_pic: asString(item.cover || item.pic),
    vod_content: cleanText(item.abstract || item.description || ""),
    vod_remarks: episodes > 0 ? "全" + episodes + "集" : "",
    vod_actor: "",
    vod_year: "",
    vod_area: "内地",
    type_name: tags.slice(0, 2).join("/"),
    vod_tag: tags.join(",")
  };
}

function pageResult(items, page, pageCount, hasMore) {
  return {
    page: page,
    pagecount: pageCount,
    limit: PAGE_SIZE,
    total: items.length,
    hasMore: !!hasMore,
    list: items
  };
}

// ---------------------------------------------------------------- 标准接口

async function init(ext) {
  return true;
}

async function home(filter) {
  return {
    class: [
      { type_id: "board-recommend", type_name: "推荐榜" },
      { type_id: "board-hot", type_name: "热播榜" },
      { type_id: "board-new", type_name: "新剧榜" },
      { type_id: "genre-short_play", type_name: "短剧" },
      { type_id: "genre-comic_series", type_name: "漫剧" },
      { type_id: "genre-ai_series", type_name: "AI短剧" }
    ],
    filters: {}
  };
}

async function category(tid, pg, filter, extend) {
  const page = Math.max(1, Number(pg) || 1);
  const key = asString(tid) || "board-recommend";
  const limit = 30;

  if (key.indexOf("board-") === 0) {
    const board = key.slice(6) || "recommend";
    const data = await api("/rank?board=" + encodeURIComponent(board) + "&limit=" + limit);
    const items = (Array.isArray(data.items) ? data.items : []).map(toVod);
    // 榜单接口不支持分页，固定单页
    return pageResult(items, 1, 1, false);
  }

  if (key.indexOf("genre-") === 0) {
    const genre = key.slice(6) || "short_play";
    const offset = (page - 1) * PAGE_SIZE;
    const data = await api(
      "/browse?genre=" + encodeURIComponent(genre) +
        "&limit=" + PAGE_SIZE + "&offset=" + offset
    );
    const items = (Array.isArray(data.items) ? data.items : []).map(toVod);
    const hasMore = data.has_more === true;
    const pageCount = hasMore ? page + 1 : page;
    return pageResult(items, page, pageCount, hasMore);
  }

  return pageResult([], 1, 1, false);
}

async function detail(id) {
  const seriesId = asString(id).split("|")[0].trim();
  if (!seriesId) throw new Error("MISSING_ID");

  const data = await api("/episodes?series_id=" + encodeURIComponent(seriesId));
  const metaInfo = isObject(data.meta) ? data.meta : {};
  const episodes = Array.isArray(data.episodes) ? data.episodes : [];

  const parts = [];
  for (let i = 0; i < episodes.length; i++) {
    const vid = asString(episodes[i] && episodes[i].vid);
    if (!vid) continue;
    const index = Number(episodes[i].index) || i + 1;
    parts.push("第" + index + "集$" + seriesId + "|" + vid);
  }

  const vod = toVod(metaInfo);
  vod.vod_id = seriesId;
  vod.vod_play_from = "红果网关";
  vod.vod_play_url = parts.join("#");
  if (parts.length > 0) {
    vod.vod_remarks = "全" + parts.length + "集";
  }
  if (asString(metaInfo.status)) vod.vod_remarks += " · " + cleanText(metaInfo.status);
  return { vod: vod };
}

// 取流可用性探测：网关的 /stream 会边解密边输出，HEAD 不可靠，
// 因此用 Range 请求探一个字节。成功结果按 URL 缓存，失败不缓存以便重试。
const streamProbe = {};
const PROBE_CACHE_MAX = 200;

async function probeStream(url) {
  if (streamProbe[url] === true) {
    // 命中缓存时刷新一次写入顺序，实现朴素的 LRU
    delete streamProbe[url];
    streamProbe[url] = true;
    return true;
  }
  try {
    const resp = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      timeoutMs: 20000
    });
    const status = resp && typeof resp.status === "number" ? resp.status : 0;
    const ok = status === 200 || status === 206;
    if (ok) {
      const keys = Object.keys(streamProbe);
      if (keys.length >= PROBE_CACHE_MAX) delete streamProbe[keys[0]];
      streamProbe[url] = true;
    }
    return ok;
  } catch (_) {
    return false;
  }
}

async function play(flag, id, flags) {
  const raw = asString(id);
  const parts = raw.split("|");
  // 分集 id 形如 seriesId|vid；只有 vid 时也允许播放
  const vid = parts.length > 1 ? parts[1] : parts[0];
  if (!vid) return { parse: 0, url: "", error: "MISSING_EPISODE" };

  const quality = asString(QUALITY) && QUALITY.indexOf("__") !== 0 ? QUALITY : "best";
  const url =
    gatewayRoot() + "/gw/stream?vid=" + encodeURIComponent(vid) +
    "&quality=" + encodeURIComponent(quality);

  // 网关取流失败（上游风控 / 服务未就绪）时返回错误码，
  // 由客户端按集回退到网页源，而不是让播放器黑屏。
  const ok = await probeStream(url);
  if (!ok) {
    return { parse: 0, url: "", error: "GATEWAY_STREAM_UNAVAILABLE" };
  }

  return {
    parse: 0,
    url: url,
    header: {},
    quality: 0,
    qualities: []
  };
}

async function search(word, quick, page) {
  const keyword = asString(word).trim();
  const current = Math.max(1, Number(page) || 1);
  if (!keyword) return pageResult([], 1, 1, false);
  const offset = (current - 1) * PAGE_SIZE;
  const data = await api(
    "/search?q=" + encodeURIComponent(keyword) +
      "&limit=" + PAGE_SIZE + "&offset=" + offset
  );
  const rows = Array.isArray(data.results) ? data.results : [];
  const items = rows.map(toVod);
  const hasMore = data.has_more === true;
  return pageResult(items, current, hasMore ? current + 1 : current, hasMore);
}

// ---------------------------------------------------------------- 导出

var spider = {
  meta: meta,
  init: init,
  home: home,
  category: category,
  detail: detail,
  play: play,
  search: search
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = spider;
}
