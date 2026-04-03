import { cli, Strategy } from "@jackwener/opencli/registry";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const FISH_DOMAIN = "https://fish.audio";
const API_DOMAIN = "https://api.fish.audio";
function fail(message, hint) {
  throw new Error(hint ? `${message}
\u2192 ${hint}` : message);
}
async function getToken(page) {
  const currentUrl = await page.evaluate(`(() => location.href)()`);
  if (!currentUrl?.includes("fish.audio") || currentUrl.includes("api.fish.audio")) {
    await page.goto(FISH_DOMAIN, { waitUntil: "none", settleMs: 0 });
    await page.wait(1);
  }
  let result = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await page.evaluate(`(async () => {
      const found = { token: null, tokenKey: null, keys: [], cookieKeys: [] };
      const directToken = localStorage.getItem('token');
      if (directToken && directToken.trim().length > 10) {
        found.token = directToken.trim();
        found.tokenKey = 'localStorage:token';
      }
      const lsKeys = Object.keys(localStorage);
      found.keys = lsKeys;
      if (!found.token) {
        for (const key of lsKeys) {
          try {
            const raw = localStorage.getItem(key);
            if (!raw || raw.length < 10) continue;
            if (raw.startsWith('ey') && raw.split('.').length === 3) {
              found.token = raw; found.tokenKey = 'localStorage:' + key; break;
            }
            try {
              const obj = JSON.parse(raw);
              const t = obj?.token || obj?.access_token || obj?.api_key;
              if (typeof t === 'string' && t.length > 10) {
                found.token = t; found.tokenKey = 'localStorage:' + key; break;
              }
            } catch {}
          } catch {}
        }
      }
      const cookies = document.cookie.split(';').map(c => c.trim()).filter(Boolean);
      found.cookieKeys = cookies.map(c => c.split('=')[0]);
      if (!found.token) {
        for (const cookie of cookies) {
          const eqIdx = cookie.indexOf('=');
          const k = cookie.slice(0, eqIdx).trim();
          const val = decodeURIComponent(cookie.slice(eqIdx + 1) || '');
          if (k === 'token' && val.trim().length > 10) {
            found.token = val.trim(); found.tokenKey = 'cookie:token'; break;
          }
          if (val.startsWith('ey') && val.split('.').length === 3) {
            found.token = val; found.tokenKey = 'cookie:' + k; break;
          }
        }
      }
      return found;
    })()`);
    if (result?.token) break;
    if (attempt < 2) await page.wait(0.5);
  }
  if (!result?.token) {
    const lsInfo = result?.keys?.length ? `localStorage keys: [${result.keys.join(", ")}]` : "localStorage is empty";
    const ckInfo = result?.cookieKeys?.length ? `cookies: [${result.cookieKeys.join(", ")}]` : "no cookies";
    fail(
      "Fish Audio \u672A\u767B\u5F55\uFF08\u672A\u627E\u5230 token\uFF09",
      `\u8BF7\u5728 Chrome \u4E2D\u6253\u5F00 https://fish.audio \u5B8C\u6210\u767B\u5F55\u540E\u91CD\u8BD5\u3002
\u8BCA\u65AD\u4FE1\u606F\uFF1A${lsInfo}\uFF1B${ckInfo}`
    );
  }
  return result.token;
}
async function ensureOnApiDomain(page) {
  const currentUrl = await page.evaluate(`(() => location.href)()`);
  if (currentUrl?.includes("api.fish.audio")) return;
  await page.goto(API_DOMAIN, { waitUntil: "none", settleMs: 0 });
  await page.wait(0.5);
}
async function apiGet(page, token, path) {
  const url = API_DOMAIN + path;
  const result = await page.evaluate(`(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        headers: { Authorization: 'Bearer ' + ${JSON.stringify(token)} }
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body };
    } catch (e) {
      return { ok: false, status: 0, error: String(e) };
    }
  })()`);
  const r = result;
  if (!r.ok) {
    if (r.error) fail(`\u7F51\u7EDC\u8BF7\u6C42\u5931\u8D25: ${r.error}`, "\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5\u6216\u4EE3\u7406\u8BBE\u7F6E");
    const msg = r.body?.message;
    fail(
      msg || `Fish Audio API \u9519\u8BEF ${r.status}`,
      r.status === 401 ? "\u767B\u5F55\u6001\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u5728 Chrome \u4E2D\u91CD\u65B0\u767B\u5F55 fish.audio" : void 0
    );
  }
  return r.body;
}
async function apiTtsPost(page, token, ttsModel, body) {
  await ensureOnApiDomain(page);
  const result = await page.evaluate(`(async () => {
    try {
      if (!location.origin.includes('api.fish.audio')) {
        return { ok: false, status: 0, message: '\u5BFC\u822A\u81F3 api.fish.audio \u5931\u8D25\uFF08\u5F53\u524D\u5728 ' + location.origin + '\uFF09' };
      }
      const res = await fetch('/v1/tts', {
        method: 'POST',
        headers: {
          Authorization:  'Bearer ' + ${JSON.stringify(token)},
          'Content-Type': 'application/json',
          model:          ${JSON.stringify(ttsModel)},
        },
        body: JSON.stringify(${JSON.stringify(body)}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return {
          ok:      false,
          status:  res.status,
          message: err?.message || ('HTTP ' + res.status),
          hint:    res.status === 401 ? '\u767B\u5F55\u6001\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u5728 Chrome \u91CD\u65B0\u767B\u5F55 fish.audio' :
                   res.status === 402 ? '\u8D26\u53F7\u989D\u5EA6\u4E0D\u8DB3\uFF0C\u8BF7\u524D\u5F80 https://fish.audio/go-api/ \u5145\u503C' :
                   undefined,
        };
      }
      const buf   = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // \u5206\u5757 btoa\uFF1A\u907F\u514D\u8D85\u5927\u97F3\u9891 String.fromCharCode \u6808\u6EA2\u51FA\uFF08\u53C2\u8003 yollomi downloadOutput\uFF09
      const CHUNK = 65536;
      let bin = '';
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
      }
      return { ok: true, base64: btoa(bin), size: bytes.length };
    } catch (e) {
      return { ok: false, status: 0, message: String(e) };
    }
  })()`);
  const r = result;
  if (!r.ok) fail(r.message || `TTS \u8BF7\u6C42\u5931\u8D25 (${r.status})`, r.hint);
  return { base64: r.base64, size: r.size };
}
cli({
  site: "fishaudio",
  name: "voices",
  description: "\u641C\u7D22\u548C\u6D4F\u89C8 Fish Audio \u516C\u5F00\u58F0\u97F3\u6A21\u578B\uFF0C\u83B7\u53D6 voice ID \u4F9B tts \u4F7F\u7528",
  domain: "fish.audio",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: "query", type: "str", default: "", positional: true, help: "\u58F0\u97F3\u540D\u79F0\u5173\u952E\u8BCD\u8FC7\u6EE4\uFF08\u53EF\u9009\uFF09" },
    { name: "language", type: "str", default: "", help: "\u6309\u8BED\u8A00\u8FC7\u6EE4\uFF0C\u5982 zh\u3001en\u3001ja" },
    { name: "tag", type: "str", default: "", help: "\u6309\u6807\u7B7E\u8FC7\u6EE4" },
    {
      name: "sort_by",
      type: "str",
      default: "score",
      choices: ["score", "task_count", "created_at"],
      help: "\u6392\u5E8F\u65B9\u5F0F: score | task_count | created_at\uFF08\u9ED8\u8BA4: score\uFF09"
    },
    { name: "limit", type: "int", default: 20, help: "\u8FD4\u56DE\u6570\u91CF\uFF08\u9ED8\u8BA4 20\uFF0C\u6700\u591A 50\uFF09" }
  ],
  columns: ["id", "title", "author", "languages", "likes", "tasks"],
  func: async (page, kwargs) => {
    if (!page) fail("\u9700\u8981\u6D4F\u89C8\u5668\u8FDE\u63A5");
    const token = await getToken(page);
    const params = new URLSearchParams({
      page_size: String(Math.min(kwargs.limit ?? 20, 50)),
      page_number: "1",
      sort_by: kwargs.sort_by || "score"
    });
    if (kwargs.query) params.set("title", kwargs.query);
    if (kwargs.language) params.set("language", kwargs.language);
    if (kwargs.tag) params.set("tag", kwargs.tag);
    const data = await apiGet(page, token, `/model?${params}`);
    if (!data?.items?.length) {
      fail("\u672A\u627E\u5230\u58F0\u97F3\u6A21\u578B", "\u6362\u4E00\u4E0B\u8FC7\u6EE4\u6761\u4EF6\uFF0C\u6216\u8BBF\u95EE fish.audio/discover \u6D4F\u89C8\u66F4\u591A");
    }
    return data.items.map((m) => ({
      id: m._id,
      title: m.title,
      author: m.author?.nickname ?? "",
      languages: (m.languages || []).join(", ") || "\u2014",
      likes: m.like_count ?? 0,
      tasks: m.task_count ?? 0
    }));
  }
});
cli({
  site: "fishaudio",
  name: "my-voices",
  description: "\u67E5\u770B\u6211\u7684 Fish Audio \u58F0\u97F3\u6A21\u578B\u5217\u8868",
  domain: "fish.audio",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [{ name: "limit", type: "int", default: 20, help: "\u8FD4\u56DE\u6570\u91CF\uFF08\u9ED8\u8BA4 20\uFF09" }],
  columns: ["id", "title", "languages", "state", "tasks"],
  func: async (page, kwargs) => {
    if (!page) fail("\u9700\u8981\u6D4F\u89C8\u5668\u8FDE\u63A5");
    const token = await getToken(page);
    const params = new URLSearchParams({
      page_size: String(Math.min(kwargs.limit ?? 20, 50)),
      page_number: "1",
      self: "true"
    });
    const data = await apiGet(page, token, `/model?${params}`);
    if (!data?.items?.length) {
      fail(
        "\u4F60\u8FD8\u6CA1\u6709\u58F0\u97F3\u6A21\u578B",
        "\u524D\u5F80 https://fish.audio/voice-cloning/ \u514B\u9686\u4E00\u4E2A\u58F0\u97F3"
      );
    }
    return data.items.map((m) => ({
      id: m._id,
      title: m.title,
      languages: (m.languages || []).join(", ") || "\u2014",
      state: m.state,
      tasks: m.task_count ?? 0
    }));
  }
});
cli({
  site: "fishaudio",
  name: "tts",
  description: "\u4F7F\u7528 Fish Audio \u5C06\u6587\u5B57\u8F6C\u6362\u4E3A\u8BED\u97F3\uFF0C\u4FDD\u5B58\u5230\u672C\u5730\u6587\u4EF6",
  domain: "fish.audio",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: "text", type: "str", required: true, positional: true, help: "\u8981\u8F6C\u6362\u4E3A\u8BED\u97F3\u7684\u6587\u5B57" },
    { name: "voice", type: "str", default: "", help: "\u58F0\u97F3\u6A21\u578B ID\uFF08\u7528 opencli fishaudio voices \u67E5\u8BE2\uFF09" },
    { name: "model", type: "str", default: "s1", choices: ["s1", "s2-pro"], help: "TTS \u6A21\u578B: s1 | s2-pro\uFF08\u9ED8\u8BA4: s1\uFF09" },
    { name: "output", type: "str", default: "output.mp3", help: "\u8F93\u51FA\u6587\u4EF6\u8DEF\u5F84\uFF08\u9ED8\u8BA4: output.mp3\uFF09" },
    {
      name: "encoding",
      type: "str",
      default: "mp3",
      choices: ["mp3", "wav", "opus"],
      help: "\u97F3\u9891\u683C\u5F0F: mp3 | wav | opus\uFF08\u9ED8\u8BA4: mp3\uFF09"
    },
    { name: "speed", type: "float", default: 1, help: "\u8BED\u901F\u500D\u7387 0.5\u20132.0\uFF08\u9ED8\u8BA4: 1.0\uFF09" }
  ],
  columns: ["file", "size_kb", "model", "voice", "encoding"],
  func: async (page, kwargs) => {
    if (!page) fail("\u9700\u8981\u6D4F\u89C8\u5668\u8FDE\u63A5");
    const token = await getToken(page);
    const speed = Math.min(2, Math.max(0.5, kwargs.speed ?? 1));
    const encoding = kwargs.encoding || "mp3";
    const ttsModel = kwargs.model || "s1";
    const bodyObj = {
      text: kwargs.text,
      format: encoding,
      normalize: true,
      latency: "normal",
      prosody: { speed }
    };
    if (kwargs.voice) bodyObj.reference_id = kwargs.voice;
    const { base64, size } = await apiTtsPost(page, token, ttsModel, bodyObj);
    const outputPath = kwargs.output || "output.mp3";
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    if (bytes.byteLength !== size) {
      fail(`\u97F3\u9891\u6570\u636E\u635F\u574F\uFF08\u671F\u671B ${size} \u5B57\u8282\uFF0C\u5B9E\u9645 ${bytes.byteLength} \u5B57\u8282\uFF09`);
    }
    const dir = dirname(outputPath);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, bytes);
    return [{
      file: outputPath,
      size_kb: (bytes.byteLength / 1024).toFixed(1),
      model: ttsModel,
      voice: kwargs.voice || "(\u9ED8\u8BA4)",
      encoding
    }];
  }
});
cli({
  site: "fishaudio",
  name: "my-recent",
  description: "\u67E5\u770B\u6211\u5728 Fish Audio \u6700\u8FD1\u4F7F\u7528\u8FC7\u7684\u58F0\u97F3\u6A21\u578B\uFF08TTS \u751F\u6210\u5386\u53F2\uFF09",
  domain: "fish.audio",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: "limit", type: "int", default: 20, help: "\u8FD4\u56DE\u6570\u91CF\uFF08\u9ED8\u8BA4 20\uFF0C\u6700\u591A 50\uFF09" },
    { name: "unique", type: "bool", default: false, help: "\u53EA\u663E\u793A\u4E0D\u91CD\u590D\u7684\u58F0\u97F3\uFF08\u6BCF\u4E2A\u58F0\u97F3\u53EA\u51FA\u73B0\u4E00\u6B21\uFF09" }
  ],
  columns: ["date", "voice_id", "voice", "backend", "text_preview"],
  func: async (page, kwargs) => {
    if (!page) fail("\u9700\u8981\u6D4F\u89C8\u5668\u8FDE\u63A5");
    const token = await getToken(page);
    const pageSize = Math.min(kwargs.limit ?? 20, 50);
    const params = new URLSearchParams({
      state: "finished",
      page_size: String(pageSize),
      page_number: "1"
    });
    const data = await apiGet(page, token, `/task?${params}`);
    if (!data?.items?.length) {
      fail(
        "\u6682\u65E0 TTS \u751F\u6210\u8BB0\u5F55",
        "\u524D\u5F80 https://fish.audio/zh-CN/app/text-to-speech/ \u751F\u6210\u4E00\u6BB5\u8BED\u97F3\u540E\u518D\u67E5\u8BE2"
      );
    }
    const items = data.items;
    const seen = /* @__PURE__ */ new Set();
    return items.filter((t) => {
      if (!kwargs.unique) return true;
      const key = t.model?._id ?? "";
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((t) => ({
      date: (t.created_at ?? "").slice(0, 10),
      voice_id: t.model?._id ?? "(\u65E0)",
      voice: t.model?.title ?? "(\u9ED8\u8BA4)",
      backend: t.backend ?? "\u2014",
      text_preview: (t.parameters?.text ?? "").slice(0, 40).replace(/\n/g, " ") + "\u2026"
    }));
  }
});
cli({
  site: "fishaudio",
  name: "my-favorites",
  description: "\u67E5\u770B\u6211\u5728 Fish Audio \u5E73\u53F0\u4E0A\u6536\u85CF\u7684\u58F0\u97F3\u6A21\u578B\uFF08\u626B\u63CF\u516C\u5F00\u6A21\u578B\u4E2D\u5DF2\u6536\u85CF\u9879\uFF09",
  domain: "fish.audio",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: "query", type: "str", default: "", positional: true, help: "\u58F0\u97F3\u540D\u79F0\u5173\u952E\u8BCD\u8FC7\u6EE4\uFF08\u53EF\u9009\uFF09" },
    { name: "language", type: "str", default: "", help: "\u6309\u8BED\u8A00\u8FC7\u6EE4\uFF0C\u5982 zh\u3001en\u3001ja" },
    {
      name: "sort_by",
      type: "str",
      default: "score",
      choices: ["score", "task_count", "created_at"],
      help: "\u6392\u5E8F\u65B9\u5F0F: score | task_count | created_at\uFF08\u9ED8\u8BA4: score\uFF09"
    },
    { name: "limit", type: "int", default: 20, help: "\u626B\u63CF\u6570\u91CF\uFF08\u9ED8\u8BA4 20\uFF0C\u6700\u591A 100\uFF09" }
  ],
  columns: ["id", "title", "author", "languages", "likes", "tasks"],
  func: async (page, kwargs) => {
    if (!page) fail("\u9700\u8981\u6D4F\u89C8\u5668\u8FDE\u63A5");
    const token = await getToken(page);
    const scanSize = Math.min(kwargs.limit ?? 20, 100);
    const params = new URLSearchParams({
      page_size: String(scanSize),
      page_number: "1",
      sort_by: kwargs.sort_by || "score"
    });
    if (kwargs.query) params.set("title", kwargs.query);
    if (kwargs.language) params.set("language", kwargs.language);
    const data = await apiGet(page, token, `/model?${params}`);
    if (!data?.items) {
      fail("\u83B7\u53D6\u6A21\u578B\u5217\u8868\u5931\u8D25");
    }
    const favorites = data.items.filter((m) => m.marked === true);
    if (!favorites.length) {
      fail(
        `\u5728\u524D ${scanSize} \u6761\u7ED3\u679C\u4E2D\u672A\u627E\u5230\u5DF2\u6536\u85CF\u6A21\u578B`,
        "\u6536\u85CF\u7684\u58F0\u97F3\u53EF\u80FD\u6392\u5E8F\u9760\u540E\uFF1B\u8BF7\u7528 --query \u5173\u952E\u8BCD\u7F29\u5C0F\u8303\u56F4\uFF0C\u6216\u524D\u5F80 https://fish.audio/discover/ \u67E5\u770B"
      );
    }
    return favorites.map((m) => ({
      id: m._id,
      title: m.title,
      author: m.author?.nickname ?? "",
      languages: (m.languages || []).join(", ") || "\u2014",
      likes: m.like_count ?? 0,
      tasks: m.task_count ?? 0
    }));
  }
});
cli({
  site: "fishaudio",
  name: "auth-check",
  description: "\u8BCA\u65AD Fish Audio \u767B\u5F55\u72B6\u6001\uFF0C\u663E\u793A localStorage / cookie \u4FE1\u606F",
  domain: "fish.audio",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ["status", "token_key", "token_prefix", "ls_keys", "cookie_keys"],
  func: async (page) => {
    if (!page) fail("\u9700\u8981\u6D4F\u89C8\u5668\u8FDE\u63A5");
    await page.goto("https://fish.audio");
    await page.wait(2);
    const result = await page.evaluate(`(async () => {
      const out = { token: null, tokenKey: null, lsKeys: [], cookieKeys: [] };

      const directToken = localStorage.getItem('token');
      if (directToken && directToken.trim().length > 10) {
        out.token = directToken.trim(); out.tokenKey = 'localStorage:token';
      }

      const lsKeys = Object.keys(localStorage);
      out.lsKeys = lsKeys;
      if (!out.token) {
        for (const key of lsKeys) {
          try {
            const raw = localStorage.getItem(key) || '';
            if (raw.length < 10) continue;
            if (raw.startsWith('ey') && raw.split('.').length === 3) {
              out.token = raw; out.tokenKey = 'localStorage:' + key; break;
            }
            try {
              const obj = JSON.parse(raw);
              const t = obj?.token || obj?.access_token || obj?.api_key;
              if (typeof t === 'string' && t.length > 10) {
                out.token = t; out.tokenKey = 'localStorage:' + key + '.*'; break;
              }
            } catch {}
          } catch {}
        }
      }

      const cookies = document.cookie.split(';').map(c => c.trim()).filter(Boolean);
      out.cookieKeys = cookies.map(c => c.split('=')[0]);
      if (!out.token) {
        for (const cookie of cookies) {
          const eqIdx = cookie.indexOf('=');
          const k = cookie.slice(0, eqIdx).trim();
          const val = decodeURIComponent(cookie.slice(eqIdx + 1) || '');
          if (k === 'token' && val.trim().length > 10) {
            out.token = val.trim(); out.tokenKey = 'cookie:token'; break;
          }
          if (val.startsWith('ey') && val.split('.').length === 3) {
            out.token = val; out.tokenKey = 'cookie:' + k; break;
          }
        }
      }
      return out;
    })()`);
    return [{
      status: result.token ? "\u2705 \u5DF2\u767B\u5F55" : "\u274C \u672A\u767B\u5F55",
      token_key: result.tokenKey || "(\u672A\u627E\u5230)",
      token_prefix: result.token ? result.token.slice(0, 20) + "..." : "\u2014",
      ls_keys: result.lsKeys.join(", ") || "(\u7A7A)",
      cookie_keys: result.cookieKeys.join(", ") || "(\u7A7A)"
    }];
  }
});
