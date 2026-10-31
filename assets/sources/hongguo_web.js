/**
 * 红果短剧 · 网页版数据源 (hongguo_web.js)
 * 适配 CatPawOpen / CatVodOpen 标准规范 v1.0.4
 *
 * 特点：
 *  - 只依赖官网 SSR 页面（hongguoduanju.com），不需要 App 签名、不需要导入 APK
 *  - 覆盖：真人剧 / 漫剧 / AI 剧 全量目录、详情、全部分集
 *  - 播放：官网公开试看片源 360p（/video/public/{vid}/360p.mp4）
 *  - 限制：官网未开放网页搜索、无榜单接口；部分剧集无公开片源
 *
 * 与 hongguo.js（官方 App 接口源）互补：本源作为无 APK 环境下的降级通道。
 */

const meta = {
  id: "hongguo-web",
  name: "红果短剧·网页版",
  version: "1.0.0",
  description: "官方网页端目录与免费试看，无需导入 APK",
  author: "THL adaptation",
  type: "video",
  icon: "",
  features: ["categories"]
};

const BASE_URL = "https://hongguoduanju.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const PAGE_SIZE = 24;

// ---------------------------------------------------------------- 工具

function cleanText(text) {
  if (!text) return "";
  return String(text)
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 从 HTML 中截取 `_ROUTER_DATA = {...}` 的完整 JSON 文本（大括号配平，忽略字符串内的括号） */
function extractRouterRaw(html) {
  const marker = "_ROUTER_DATA";
  const at = html.indexOf(marker);
  if (at < 0) return "";

  const braceStart = html.indexOf("{", at);
  if (braceStart < 0) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(braceStart, i + 1);
    }
  }
  return "";
}

/** 解析页面内的 _ROUTER_DATA */
function parseRouterData(html) {
  const raw = extractRouterRaw(html);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/** 在 loaderData 中找出第一个满足条件的对象 */
function pickLoader(router, predicate) {
  if (!isObject(router) || !isObject(router.loaderData)) return null;
  const data = router.loaderData;
  const keys = Object.keys(data);
  for (let i = 0; i < keys.length; i++) {
    const value = data[keys[i]];
    if (isObject(value) && predicate(value)) return value;
  }
  return null;
}

/** 统一封面地址：去掉裁剪参数，避免 640 宽限制影响大图 */
function normalizeCover(url) {
  const raw = asString(url).trim();
  if (!raw) return "";
  const picMatch = raw.match(/novel-pic\/([A-Za-z0-9_-]+)/);
  if (picMatch) {
    return "https://p3-novel.byteimg.com/novel-pic/" + picMatch[1] + "~tplv-shrink:720:0.image";
  }
  return raw;
}

async function fetchText(url, referer) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      Referer: referer || BASE_URL + "/"
    },
    timeoutMs: 15000
  });
  const status = resp && typeof resp.status === "number" ? resp.status : 0;
  if (status !== 200) {
    throw new Error("HTTP_" + status);
  }
  let body = resp.body;
  if (typeof resp.text === "function") body = await resp.text();
  if (!body || typeof body !== "string") throw new Error("EMPTY_RESPONSE");
  return body;
}

/**
 * 探测片源是否可取（官网按集授权，未公开的集会 404）。
 * 返回 HTTP 状态码，网络异常返回 0 —— 便于上层区分「没有片源」和「网络失败」。
 *
 * 先用 HEAD（最省流量）；部分 CDN 对 HEAD 返回 403/405，此时退化为 Range GET 再判一次，
 * 否则会把「片源存在但拒绝 HEAD」误报成没有片源。
 */
async function probeMedia(url) {
  const headers = { "User-Agent": USER_AGENT, Referer: BASE_URL + "/" };
  try {
    const head = await fetch(url, { method: "HEAD", headers: headers, timeoutMs: 8000 });
    const status = head && typeof head.status === "number" ? head.status : 0;
    if (status === 200) return status;
    if (status !== 403 && status !== 405) return status;
  } catch (e) {
    return 0;
  }
  try {
    const ranged = await fetch(url, {
      headers: Object.assign({ Range: "bytes=0-0" }, headers),
      timeoutMs: 8000
    });
    return ranged && typeof ranged.status === "number" ? ranged.status : 0;
  } catch (e) {
    return 0;
  }
}

// ---------------------------------------------------------------- 字段映射

/** 剧集条目 → 标准 vod 结构 */
function toVod(item) {
  const seriesId = asString(item.series_id);
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const episodeCnt = Number(item.episode_cnt) || 0;
  const freeCnt = Number(item.accessible_episode_cnt) || 0;
  return {
    vod_id: seriesId,
    vod_name: cleanText(item.series_name) || "短剧 " + seriesId,
    vod_pic: normalizeCover(item.series_cover),
    vod_content: cleanText(item.series_intro),
    vod_remarks:
      (episodeCnt > 0 ? "全" + episodeCnt + "集" : "") +
      (freeCnt > 0 ? " · 免费" + freeCnt + "集" : ""),
    vod_year: "",
    vod_area: "内地",
    type_name: tags.slice(0, 2).join("/"),
    vod_actor: (Array.isArray(item.celebrities) ? item.celebrities : [])
      .map(function (c) {
        return asString(c && c.nickname);
      })
      .filter(function (name) {
        return name;
      })
      .slice(0, 6)
      .join(","),
    vod_tag: tags.join(",")
  };
}

/** 从详情页 seriesDetail 生成分集播放串 */
function buildPlayUrl(seriesId, vidList) {
  const parts = [];
  for (let i = 0; i < vidList.length; i++) {
    const vid = asString(vidList[i]);
    if (!vid) continue;
    parts.push("第" + (i + 1) + "集$" + seriesId + "|" + vid);
  }
  return parts.join("#");
}

// ---------------------------------------------------------------- 标准接口

async function init(ext) {
  return true;
}

async function home(filter) {
  return {
    class: [
      { type_id: "real-drama", type_name: "真人剧" },
      { type_id: "comic-drama", type_name: "漫剧" },
      { type_id: "ai-drama", type_name: "AI剧" }
    ],
    filters: {}
  };
}

async function category(tid, pg, filter, extend) {
  let page = Number(pg) || 1;
  if (page < 1) page = 1;

  let route = asString(tid) || "real-drama";
  if (route === "all" || route === "short_play") route = "real-drama";
  if (route === "comic") route = "comic-drama";

  const url = BASE_URL + "/category/" + route + (page > 1 ? "?page=" + page : "");
  const html = await fetchText(url, BASE_URL + "/category/" + route);
  const router = parseRouterData(html);
  const pageData = pickLoader(router, function (value) {
    return Array.isArray(value.recommendList);
  });
  if (!pageData) throw new Error("INVALID_RESPONSE");

  const list = pageData.recommendList.map(toVod);
  const pagination = isObject(pageData.pagination) ? pageData.pagination : {};
  const current = Number(pagination.pageNum) || page;
  const totalPages = Number(pagination.totalPages) || current;
  const total = Number(pagination.total) || list.length;

  return {
    page: current,
    pagecount: totalPages,
    limit: PAGE_SIZE,
    total: total,
    hasMore: current < totalPages,
    list: list
  };
}

async function detail(id) {
  const raw = asString(id).split("|")[0];
  const seriesId = raw.trim();
  if (!seriesId) throw new Error("MISSING_ID");

  const url = BASE_URL + "/detail?series_id=" + encodeURIComponent(seriesId);
  const html = await fetchText(url, BASE_URL + "/");
  const router = parseRouterData(html);
  const page = pickLoader(router, function (value) {
    return isObject(value.seriesDetail);
  });
  if (!page || !isObject(page.seriesDetail)) throw new Error("INVALID_RESPONSE");

  const sd = page.seriesDetail;
  const vidList = Array.isArray(sd.vid_list) ? sd.vid_list : [];
  const vod = toVod(sd);
  vod.vod_id = seriesId;
  vod.vod_play_from = "红果网页";
  vod.vod_play_url = buildPlayUrl(seriesId, vidList);
  if (vidList.length > 0) {
    vod.vod_remarks = "全" + vidList.length + "集 · 试看";
  }
  return { vod: vod };
}

async function play(flag, id, flags) {
  const parts = asString(id).split("|");
  const vid = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const cleanVid = vid.trim();
  if (!cleanVid) return { parse: 0, url: "", error: "MISSING_EPISODE" };

  const url = BASE_URL + "/video/public/" + cleanVid + "/360p.mp4";
  const status = await probeMedia(url);
  if (status !== 200) {
    if (status === 0) {
      // 网络异常与「没有片源」要区分，否则会把网络问题误报成试看限制
      return { parse: 0, url: "", error: "NETWORK_ERROR" };
    }
    // 官网仅公开部分集数的 360p 片源，其余需要 App 端授权
    return { parse: 0, url: "", error: "PREVIEW_ONLY" };
  }
  return {
    parse: 0,
    url: url,
    header: { "User-Agent": USER_AGENT, Referer: BASE_URL + "/" },
    quality: 360,
    qualities: [360]
  };
}

// ---------------------------------------------------------------- 导出

var spider = {
  meta: meta,
  init: init,
  home: home,
  category: category,
  detail: detail,
  play: play
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = spider;
}
