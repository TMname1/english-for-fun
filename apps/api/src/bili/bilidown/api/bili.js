// B 站核心接口：视频信息 + 取流。复刻渲染层 app.js 里的 view / playurl 调用。
import { biliHeaders, DEFAULT_TIMEOUT_MS, fetchJson, withBuvid3 } from "../lib/http.js";
import { extractWbiKeys, signWbi } from "../lib/wbi.js";

const API = "https://api.bilibili.com";

// nav 在未登录时 code=-101 但 data.wbi_img 仍有效（WBI key 来自这里），
// 因此单独处理，不能用通用 fetchJson 把 -101 当错误抛出。
export async function nav(cookieStr) {
  const res = await fetch(`${API}/x/web-interface/nav`, {
    headers: biliHeaders({ Cookie: await withBuvid3(cookieStr) }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  return res.json();
}

export async function view(bvid, cookieStr = "") {
  const json = await fetchJson(`${API}/x/web-interface/view?bvid=${bvid}`, {
    headers: { Cookie: await withBuvid3(cookieStr) },
  });
  const d = json.data;
  return {
    aid: d.aid,
    bvid: d.bvid,
    title: d.title,
    pic: d.pic,
    pages: (d.pages || []).map((p) => ({
      cid: p.cid,
      page: p.page,
      part: p.part,
      duration: p.duration,
    })),
  };
}

// 取 DASH 直链（音视频分离），走 wbi 签名。
export async function getPlayurl({ bvid, cid, qn = 127 }, wbiKeys, cookieStr) {
  const params = { bvid, cid, fnval: 4048, fourk: 1, fnver: 0, qn };
  const qs = signWbi(params, wbiKeys);
  const json = await fetchJson(`${API}/x/player/wbi/playurl?${qs}`, {
    headers: { Cookie: await withBuvid3(cookieStr) },
  });
  return json.data; // 含 dash{video[],audio[]} 或 durl[]
}

// html5 老接口：DASH 不可用时返回单个 mp4(durl)，无需签名。
export async function getMp4Url({ aid, cid, qn = 64 }, cookieStr) {
  const url = `${API}/x/player/playurl?avid=${aid}&cid=${cid}&qn=${qn}&platform=html5&otype=json&high_quality=1`;
  const json = await fetchJson(url, {
    headers: { Cookie: await withBuvid3(cookieStr) },
  });
  return json.data; // durl:[{url, size}]
}

function streamUrl(s) {
  return (
    s.baseUrl ||
    s.base_url ||
    (s.backupUrl && s.backupUrl[0]) ||
    (s.backup_url && s.backup_url[0]) ||
    (s.baku_url && s.baku_url[0])
  );
}

// 按请求清晰度挑选视频流：取 id<=qn 里的最高档，没有则取最高档。
export function pickVideo(dash, qn) {
  const list = [...dash].sort((a, b) => b.id - a.id);
  return list.find((v) => v.id <= qn) || list[0];
}

export function pickAudio(dash) {
  return [...dash].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

export { streamUrl, extractWbiKeys };
