/**
 * Fish Audio — OpenCLI plugin
 *
 * 无需 API Key：复用 Chrome 中已登录的 https://fish.audio 会话。
 *
 * 网络架构（参考 yollomi 工具函数模式）：
 *
 * GET 接口（voices / my-voices / my-recent / my-favorites）：
 *   停留在 fish.audio 页面上下文，跨域 fetch 到 api.fish.audio；
 *   这些接口有 CORS 允许头，正常工作。
 *
 * POST /v1/tts（TTS 接口）：
 *   该接口为 server-side REST，无 CORS 头（fish.audio 前端走 WebSocket）。
 *   仿照 yollomi 的 ensureOnYollomi + 同域 fetch 模式：
 *   先通过 ensureOnApiDomain 确保页面在 api.fish.audio，
 *   再发同源 POST（无 preflight），完全走 Chrome 网络栈。
 *   二进制响应用分块 btoa 转 base64 经 CDP 桥返回 Node.js 写文件。
 *
 * @see https://github.com/jackwener/opencli-plugin-fishaudio
 */

import { cli, Strategy, type IPage } from '@jackwener/opencli/registry';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname, basename, extname, resolve as resolvePath } from 'path';

const FISH_DOMAIN   = 'https://fish.audio';
const API_DOMAIN    = 'https://api.fish.audio';

/**
 * 统一报错：不依赖 @jackwener/opencli/registry 中的 CliError，
 * 兼容该导出在某些版本中缺失的情况。
 */
function fail(message: string, hint?: string): never {
  throw new Error(hint ? `${message}\n→ ${hint}` : message);
}

/**
 * 从 fish.audio localStorage / cookie 中提取 Bearer token。
 *
 * 优化：用轮询代替死等 2 秒——localStorage 在页面 hydrate 后才写入，
 * 最多轮询 3 次（每次 500 ms），已登录用户通常第 1 次就能拿到。
 */
async function getToken(page: IPage): Promise<string> {
  const currentUrl = await page.evaluate(`(() => location.href)()`) as string;
  if (!currentUrl?.includes('fish.audio') || currentUrl.includes('api.fish.audio')) {
    await page.goto(FISH_DOMAIN, { waitUntil: 'none', settleMs: 0 });
    await page.wait(1);
  }

  // 轮询提取 token（最多 3 次，间隔 500 ms），避免死等 2 秒
  let result: { token: string | null; keys: string[]; cookieKeys: string[] } | null = null;
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
    })()`) as { token: string | null; keys: string[]; cookieKeys: string[] };

    if (result?.token) break;
    if (attempt < 2) await page.wait(0.5);
  }

  if (!result?.token) {
    const lsInfo = result?.keys?.length  ? `localStorage keys: [${result.keys.join(', ')}]` : 'localStorage is empty';
    const ckInfo = result?.cookieKeys?.length ? `cookies: [${result.cookieKeys.join(', ')}]` : 'no cookies';
    fail(
      'Fish Audio 未登录（未找到 token）',
      `请在 Chrome 中打开 https://fish.audio 完成登录后重试。\n诊断信息：${lsInfo}；${ckInfo}`,
    );
  }

  return result.token!;
}

/**
 * 确保当前页面在 api.fish.audio 域（参考 yollomi 的 ensureOnYollomi 模式）。
 * 若已在该域则跳过导航，节省 1-2 秒。
 */
async function ensureOnApiDomain(page: IPage): Promise<void> {
  const currentUrl = await page.evaluate(`(() => location.href)()`) as string;
  if (currentUrl?.includes('api.fish.audio')) return;
  // waitUntil: 'none' 不等待页面加载完成，settleMs: 0 不额外等待；
  // CDP 执行 JS 不需要 DOM 就绪，只需建立正确的 origin 上下文即可。
  await page.goto(API_DOMAIN, { waitUntil: 'none', settleMs: 0 });
  await page.wait(0.5);
}

/**
 * 通过浏览器执行跨域 GET 请求（从 fish.audio 页上下文请求 api.fish.audio）。
 * 返回已解析的 JSON；失败时 fail()。
 */
async function apiGet(page: IPage, token: string, path: string): Promise<unknown> {
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

  const r = result as { ok: boolean; status: number; body?: unknown; error?: string };

  if (!r.ok) {
    if (r.error) fail(`网络请求失败: ${r.error}`, '请检查网络连接或代理设置');
    const msg = (r.body as Record<string, unknown>)?.message as string | undefined;
    fail(
      msg || `Fish Audio API 错误 ${r.status}`,
      r.status === 401 ? '登录态已过期，请在 Chrome 中重新登录 fish.audio' : undefined,
    );
  }

  return r.body;
}

/**
 * 在 api.fish.audio 同源上下文中发 POST，返回二进制音频 base64。
 *
 * 仿 yollomi yollomiPost：先 ensureOnApiDomain，再 page.evaluate fetch。
 * 同源请求无 CORS preflight；Chrome 网络栈在 macOS/企业网络下均正常。
 * 二进制响应通过分块 btoa 编码后经 CDP 桥转回 Node.js。
 */
async function apiTtsPost(
  page: IPage,
  token: string,
  ttsModel: string,
  body: Record<string, unknown>,
): Promise<{ base64: string; size: number }> {
  await ensureOnApiDomain(page);

  const result = await page.evaluate(`(async () => {
    try {
      if (!location.origin.includes('api.fish.audio')) {
        return { ok: false, status: 0, message: '导航至 api.fish.audio 失败（当前在 ' + location.origin + '）' };
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
          hint:    res.status === 401 ? '登录态已过期，请在 Chrome 重新登录 fish.audio' :
                   res.status === 402 ? '账号额度不足，请前往 https://fish.audio/go-api/ 充值' :
                   undefined,
        };
      }
      const buf   = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // 分块 btoa：避免超大音频 String.fromCharCode 栈溢出（参考 yollomi downloadOutput）
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

  const r = result as {
    ok: boolean; status?: number; base64?: string; size?: number; message?: string; hint?: string;
  };

  if (!r.ok) fail(r.message || `TTS 请求失败 (${r.status})`, r.hint);
  return { base64: r.base64!, size: r.size! };
}


/** 将 Fish API 错误体整理为可读字符串（兼容 message / FastAPI detail 等） */
function formatFishApiError(body: Record<string, unknown>, status: number): string {
  const m = body?.message;
  if (typeof m === 'string' && m.trim()) return m.trim();

  const d = body?.detail;
  if (typeof d === 'string' && d.trim()) return d.trim();
  if (Array.isArray(d)) {
    const parts = d.map((item: unknown) => {
      if (item && typeof item === 'object' && 'msg' in (item as object)) {
        const o = item as { loc?: unknown[]; msg?: string; type?: string };
        const where = Array.isArray(o.loc) ? o.loc.join('.') : '';
        return [where, o.msg, o.type].filter(Boolean).join(': ');
      }
      return typeof item === 'string' ? item : JSON.stringify(item);
    });
    return parts.length ? parts.join('；') : `API 错误 ${status}`;
  }
  if (d && typeof d === 'object') return JSON.stringify(d);

  const keys = Object.keys(body);
  if (keys.length) return `API 错误 ${status}: ${JSON.stringify(body)}`;
  return `API 错误 ${status}`;
}

/**
 * 声音克隆：上传音频文件创建自定义声音模型。
 *
 * 网络架构说明：
 *   page.evaluate 的 JS 代码字符串通过 JSON body 发送到本地 daemon（POST http://127.0.0.1:port/command）。
 *   daemon 硬性限制 body ≤ 1 MB（防 OOM）。若把音频 base64 内嵌在 evaluate 字符串里，
 *   文件 > ~750 KB 时 daemon 会调用 req.destroy()，Node.js undici 捕获到 ECONNRESET 报 "fetch failed"。
 *
 * 修复方案（优先）：page.setFileInput
 *   IPage.setFileInput 通过 CDP DOM.setFileInputFiles 让 Chrome 直接从磁盘读取文件，
 *   完全绕开 daemon 的 1 MB body 限制，适用于任意大小的音频文件。
 *
 * 备用方案：base64-in-evaluate（仅小文件 < 700 KB）
 *   当 setFileInput 不可用（旧版扩展）且文件足够小时使用原始方案，
 *   超过限制时提前报错并提示用户更新扩展。
 *
 * Fish Audio Model Create API：POST /model（multipart/form-data）
 *   - title / description / enhance_audio_quality / type / train_mode / visibility / languages
 *   - voices（音频文件，可多个）/ voices_texts（对应转录，可选）
 */
async function apiCreateModel(
  page: IPage,
  token: string,
  title: string,
  audioFiles: { path: string; text?: string }[],
  opts: { language?: string; description?: string; enhance?: boolean; type?: string; trainMode?: string; visibility?: string },
): Promise<Record<string, unknown>> {

  // Node.js 侧：仅验证文件存在，不读取内容（由后续步骤决定读取方式）
  for (const file of audioFiles) {
    if (!existsSync(file.path)) {
      fail(`音频文件不存在: ${file.path}`, '请检查文件路径是否正确');
    }
  }

  await ensureOnApiDomain(page);

  const langs = (opts.language || 'zh').split(',').map(s => s.trim()).filter(Boolean);

  // 元数据 payload（仅字符串/数字，不含文件数据，远小于 1 MB 限制）
  const metaPayload = JSON.stringify({
    token,
    title,
    description:  opts.description ?? '',
    enhance:      opts.enhance !== false,
    languages:    langs,
    filesTexts:   audioFiles.map(f => f.text ?? ''),
    type:         opts.type      ?? 'tts',
    trainMode:    opts.trainMode ?? 'fast',
    visibility:   opts.visibility ?? 'private',
  });

  // evaluate 内部的公共 FormData POST 模板（复用于两条路径）
  const FETCH_BLOCK = `
      const p = ${metaPayload};
      const fd = new FormData();
      fd.append('title', p.title);
      if (p.description) fd.append('description', p.description);
      fd.append('enhance_audio_quality', String(p.enhance));
      fd.append('type', p.type);
      fd.append('train_mode', p.trainMode);
      fd.append('visibility', p.visibility);
      for (const l of p.languages) fd.append('languages', l);`;

  let result: unknown;

  if (page.setFileInput) {
    // ── 路径 A：setFileInput（推荐，无大小限制）──────────────────────────────
    // 1. 在 api.fish.audio 页面动态注入隐藏 file input
    await page.evaluate(`(() => {
      let inp = document.getElementById('_oc_voice_input');
      if (!inp) {
        inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.id = '_oc_voice_input';
        inp.style.display = 'none';
        (document.body || document.documentElement).appendChild(inp);
      }
    })()`);

    // 2. 通过 CDP DOM.setFileInputFiles 让 Chrome 直接读本地文件（绕开 daemon 1 MB 限制）
    const absPaths = audioFiles.map(f => resolvePath(f.path));
    await page.setFileInput(absPaths, '#_oc_voice_input');

    // 3. 从 input.files 构建 FormData，在 api.fish.audio 同源发 POST
    result = await page.evaluate(`(async () => {
      try {
        if (!location.origin.includes('api.fish.audio')) {
          return { ok: false, status: 0, message: '导航至 api.fish.audio 失败（当前在 ' + location.origin + '）' };
        }
        const inp = document.getElementById('_oc_voice_input');
        if (!inp || !inp.files || inp.files.length === 0) {
          return { ok: false, status: 0, message: 'setFileInput 未附加文件（扩展版本可能不支持该命令）' };
        }
        ${FETCH_BLOCK}
        for (let i = 0; i < inp.files.length; i++) {
          fd.append('voices', inp.files[i]);
          if (p.filesTexts[i]) fd.append('voices_texts', p.filesTexts[i]);
        }
        const res = await fetch('/model', {
          method: 'POST', headers: { Authorization: 'Bearer ' + p.token }, body: fd,
        });
        const body = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, body };
      } catch (e) {
        return { ok: false, status: 0, message: String(e) };
      }
    })()`);

    // 清理 input 元素（非关键，忽略失败）
    await page.evaluate(`(() => { const el = document.getElementById('_oc_voice_input'); if (el) el.remove(); })()`).catch(() => {});

  } else {
    // ── 路径 B：base64-in-evaluate（旧版扩展降级，仅支持小文件）──────────────
    const MIME: Record<string, string> = {
      wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4',
      ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm',
    };
    const filesPayload = audioFiles.map(file => {
      const buf   = readFileSync(file.path);
      const fname = basename(file.path);
      const ext   = extname(fname).slice(1).toLowerCase();
      return { base64: buf.toString('base64'), mime: MIME[ext] ?? 'audio/mpeg', filename: fname, text: file.text ?? '' };
    });

    // 预检大小：base64 + 模板代码 > 700 KB 时，daemon 的 1 MB 限制必然触发
    const totalB64KB = Math.round(filesPayload.reduce((s, f) => s + f.base64.length, 0) / 1024);
    if (totalB64KB > 700) {
      fail(
        `音频文件过大（base64 约 ${totalB64KB} KB），超出 daemon 1 MB 传输限制`,
        '请更新 OpenCLI Browser Bridge 扩展（新版本支持 setFileInput 大文件上传），或使用较小的音频文件（< 500 KB）',
      );
    }

    const payload = JSON.stringify({
      token, title,
      description:  opts.description ?? '',
      enhance:      opts.enhance !== false,
      languages:    langs,
      files:        filesPayload,
      type:         opts.type      ?? 'tts',
      trainMode:    opts.trainMode ?? 'fast',
      visibility:   opts.visibility ?? 'private',
    });

    result = await page.evaluate(`(async () => {
      try {
        if (!location.origin.includes('api.fish.audio')) {
          return { ok: false, status: 0, message: '导航至 api.fish.audio 失败（当前在 ' + location.origin + '）' };
        }
        ${FETCH_BLOCK.replace('${metaPayload}', '').replace(metaPayload, '')}
        const p2 = ${payload};
        const fd2 = new FormData();
        fd2.append('title', p2.title);
        if (p2.description) fd2.append('description', p2.description);
        fd2.append('enhance_audio_quality', String(p2.enhance));
        fd2.append('type', p2.type);
        fd2.append('train_mode', p2.trainMode);
        fd2.append('visibility', p2.visibility);
        for (const l of p2.languages) fd2.append('languages', l);
        for (const f of p2.files) {
          const bin = atob(f.base64);
          const u8  = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          fd2.append('voices', new Blob([u8], { type: f.mime }), f.filename);
          if (f.text) fd2.append('voices_texts', f.text);
        }
        const res = await fetch('/model', {
          method: 'POST', headers: { Authorization: 'Bearer ' + p2.token }, body: fd2,
        });
        const body = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, body };
      } catch (e) {
        return { ok: false, status: 0, message: String(e) };
      }
    })()`);
  }

  const r = result as { ok: boolean; status: number; body?: Record<string, unknown>; message?: string };

  if (!r.ok) {
    if (r.message && !r.body) fail(r.message);
    const body = r.body ?? {};
    const msg  = formatFishApiError(body, r.status);
    const hint =
      r.status === 401 ? '登录态已过期，请在 Chrome 中重新登录 fish.audio' :
      r.status === 402 ? '账号额度不足，请前往 https://fish.audio/go-api/ 充值' :
      r.status === 422 ? '请检查音频时长（建议 15–300 秒）及格式是否正确' :
      undefined;
    fail(msg, hint);
  }
  return r.body ?? {};
}

/**
 * 删除我的声音模型（克隆/上传）。
 *
 * 说明：Fish Audio 的管理接口在 api.fish.audio 上，按同源模式发起 DELETE，
 * 以避免 CORS 与企业网络下 Node.js 网络栈问题（与 apiTtsPost 同原则）。
 */
async function apiDeleteModel(
  page: IPage,
  token: string,
  modelId: string,
): Promise<Record<string, unknown>> {
  await ensureOnApiDomain(page);

  const safeId = String(modelId || '').trim();
  if (!safeId) fail('缺少 model id');

  const result = await page.evaluate(`(async () => {
    try {
      if (!location.origin.includes('api.fish.audio')) {
        return { ok: false, status: 0, message: '导航至 api.fish.audio 失败（当前在 ' + location.origin + '）' };
      }
      const id = ${JSON.stringify(safeId)};
      const res = await fetch('/model/' + encodeURIComponent(id), {
        method:  'DELETE',
        headers: { Authorization: 'Bearer ' + ${JSON.stringify(token)} },
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body };
    } catch (e) {
      return { ok: false, status: 0, message: String(e) };
    }
  })()`);

  const r = result as { ok: boolean; status: number; body?: Record<string, unknown>; message?: string };
  if (!r.ok) {
    if (r.message && !r.body) fail(r.message);
    const body = r.body ?? {};
    const msg = formatFishApiError(body, r.status);
    const hint =
      r.status === 401 ? '登录态已过期，请在 Chrome 中重新登录 fish.audio' :
      r.status === 403 ? '权限不足（只能删除自己的声音模型）' :
      r.status === 404 ? '未找到该声音模型（可能已被删除，或 id 不正确）' :
      undefined;
    fail(msg, hint);
  }
  return r.body ?? {};
}

cli({
  site: 'fishaudio',
  name: 'clone',
  description: '声音克隆：上传音频文件创建自定义声音模型，需为声音取名',
  domain: 'fish.audio',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    {
      name:     'audio',
      type:     'str',
      required: true,
      positional: true,
      help:     '音频文件路径（WAV/MP3/M4A/FLAC；多个文件用英文逗号分隔，15-300 秒效果最佳）',
    },
    {
      name:     'name',
      type:     'str',
      required: true,
      help:     '声音名称（必填，例如：小明的声音）',
    },
    {
      name:    'text',
      type:    'str',
      default: '',
      help:    '音频对应的文字转录（可选，填写后克隆质量更好）',
    },
    {
      name:    'language',
      type:    'str',
      default: 'zh',
      help:    '语言代码: zh | en | ja | ko | ...（默认: zh；多语言用逗号，如 zh,en）',
    },
    {
      name:    'description',
      type:    'str',
      default: '',
      help:    '声音描述（可选）',
    },
    {
      name:    'enhance',
      type:    'bool',
      default: true,
      help:    '是否增强音频质量（默认: true）',
    },
    {
      name:    'type',
      type:    'str',
      default: 'tts',
      help:    '声音模型类型（默认: tts）',
    },
    {
      name:    'train_mode',
      type:    'str',
      default: 'fast',
      choices: ['fast', 'normal', 'accurate'],
      help:    '训练模式: fast | normal | accurate（默认: fast）',
    },
  ],
  columns: ['id', 'name', 'state', 'languages'],
  func: async (page, kwargs) => {
    if (!page) fail('需要浏览器连接');
    const token = await getToken(page);

    const rawPaths = (kwargs.audio as string).split(',').map(p => p.trim()).filter(Boolean);
    if (!rawPaths.length) fail('请提供至少一个音频文件路径');

    const audioFiles = rawPaths.map(p => ({
      path: p,
      text: (kwargs.text as string) || undefined,
    }));

    const result = await apiCreateModel(page, token, kwargs.name as string, audioFiles, {
      language:    (kwargs.language as string) || 'zh',
      description: (kwargs.description as string) || '',
      enhance:     kwargs.enhance !== false,
      type:        (kwargs.type as string) || 'tts',
      trainMode:   (kwargs.train_mode as string) || 'fast',
    });

    return [{
      id:        result._id ?? result.id ?? '—',
      name:      result.title ?? kwargs.name,
      state:     result.state ?? 'processing',
      languages: ((result.languages as string[]) || []).join(', ') || (kwargs.language as string) || 'zh',
    }];
  },
});

cli({
  site: 'fishaudio',
  name: 'delete',
  description: '删除我的声音模型（克隆/上传）。危险操作，默认需要 --yes 确认',
  domain: 'fish.audio',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    {
      name: 'id',
      type: 'str',
      required: true,
      positional: true,
      help: '声音模型 ID（可用 opencli fishaudio my-voices 查看）',
    },
    {
      name: 'yes',
      type: 'bool',
      default: false,
      help: '确认删除（必须显式传入 --yes 才会执行）',
    },
  ],
  columns: ['id', 'deleted', 'message'],
  func: async (page, kwargs) => {
    if (!page) fail('需要浏览器连接');

    const id = String(kwargs.id || '').trim();
    if (!id) fail('缺少声音模型 ID');

    if (!(kwargs.yes as boolean)) {
      fail(
        '这是危险操作：将永久删除该声音模型',
        `如果确认删除，请执行：opencli fishaudio delete ${id} --yes`,
      );
    }

    const token = await getToken(page);
    const body = await apiDeleteModel(page, token, id);

    return [{
      id,
      deleted: true,
      message: (body?.message as string) || 'ok',
    }];
  },
});

cli({
  site: 'fishaudio',
  name: 'voices',
  description: '搜索和浏览 Fish Audio 公开声音模型，获取 voice ID 供 tts 使用',
  domain: 'fish.audio',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'query', type: 'str', default: '', positional: true, help: '声音名称关键词过滤（可选）' },
    { name: 'language', type: 'str', default: '', help: '按语言过滤，如 zh、en、ja' },
    { name: 'tag', type: 'str', default: '', help: '按标签过滤' },
    {
      name: 'sort_by',
      type: 'str',
      default: 'score',
      choices: ['score', 'task_count', 'created_at'],
      help: '排序方式: score | task_count | created_at（默认: score）',
    },
    { name: 'limit', type: 'int', default: 20, help: '返回数量（默认 20，最多 50）' },
  ],
  columns: ['id', 'title', 'author', 'languages', 'likes', 'tasks'],
  func: async (page, kwargs) => {
    if (!page) fail('需要浏览器连接');
    const token = await getToken(page);

    const params = new URLSearchParams({
      page_size:   String(Math.min(kwargs.limit ?? 20, 50)),
      page_number: '1',
      sort_by:     kwargs.sort_by || 'score',
    });
    if (kwargs.query)    params.set('title', kwargs.query);
    if (kwargs.language) params.set('language', kwargs.language);
    if (kwargs.tag)      params.set('tag', kwargs.tag);

    const data = await apiGet(page, token, `/model?${params}`) as { total: number; items: unknown[] };
    if (!data?.items?.length) {
      fail('未找到声音模型', '换一下过滤条件，或访问 fish.audio/discover 浏览更多');
    }

    return (data.items as Record<string, unknown>[]).map(m => ({
      id:        m._id,
      title:     m.title,
      author:    (m.author as Record<string, unknown>)?.nickname ?? '',
      languages: ((m.languages as string[]) || []).join(', ') || '—',
      likes:     m.like_count ?? 0,
      tasks:     m.task_count ?? 0,
    }));
  },
});

cli({
  site: 'fishaudio',
  name: 'my-voices',
  description: '查看我的 Fish Audio 声音模型列表',
  domain: 'fish.audio',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [{ name: 'limit', type: 'int', default: 20, help: '返回数量（默认 20）' }],
  columns: ['id', 'title', 'languages', 'state', 'tasks'],
  func: async (page, kwargs) => {
    if (!page) fail('需要浏览器连接');
    const token = await getToken(page);

    const params = new URLSearchParams({
      page_size:   String(Math.min(kwargs.limit ?? 20, 50)),
      page_number: '1',
      self:        'true',
    });

    const data = await apiGet(page, token, `/model?${params}`) as { total: number; items: unknown[] };
    if (!data?.items?.length) {
      fail(
        '你还没有声音模型',
        '前往 https://fish.audio/voice-cloning/ 克隆一个声音',
      );
    }

    return (data.items as Record<string, unknown>[]).map(m => ({
      id:        m._id,
      title:     m.title,
      languages: ((m.languages as string[]) || []).join(', ') || '—',
      state:     m.state,
      tasks:     m.task_count ?? 0,
    }));
  },
});

cli({
  site: 'fishaudio',
  name: 'tts',
  description: '使用 Fish Audio 将文字转换为语音，保存到本地文件',
  domain: 'fish.audio',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'text', type: 'str', required: true, positional: true, help: '要转换为语音的文字' },
    { name: 'voice', type: 'str', default: '', help: '声音模型 ID（用 opencli fishaudio voices 查询）' },
    { name: 'model', type: 'str', default: 's1', choices: ['s1', 's2-pro'], help: 'TTS 模型: s1 | s2-pro（默认: s1）' },
    { name: 'output', type: 'str', default: 'output.mp3', help: '输出文件路径（默认: output.mp3）' },
    {
      name: 'encoding',
      type: 'str',
      default: 'mp3',
      choices: ['mp3', 'wav', 'opus'],
      help: '音频格式: mp3 | wav | opus（默认: mp3）',
    },
    { name: 'speed', type: 'float', default: 1.0, help: '语速倍率 0.5–2.0（默认: 1.0）' },
  ],
  columns: ['file', 'size_kb', 'model', 'voice', 'encoding'],
  func: async (page, kwargs) => {
    if (!page) fail('需要浏览器连接');
    const token = await getToken(page);

    const speed    = Math.min(2.0, Math.max(0.5, (kwargs.speed as number) ?? 1.0));
    const encoding = (kwargs.encoding as string) || 'mp3';
    const ttsModel = (kwargs.model as string) || 's1';

    const bodyObj: Record<string, unknown> = {
      text:      kwargs.text,
      format:    encoding,
      normalize: true,
      latency:   'normal',
      prosody:   { speed },
    };
    if (kwargs.voice) bodyObj.reference_id = kwargs.voice;

    const { base64, size } = await apiTtsPost(page, token, ttsModel, bodyObj);

    const outputPath: string = (kwargs.output as string) || 'output.mp3';
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    if (bytes.byteLength !== size) {
      fail(`音频数据损坏（期望 ${size} 字节，实际 ${bytes.byteLength} 字节）`);
    }

    const dir = dirname(outputPath);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, bytes);

    return [{
      file:     outputPath,
      size_kb:  (bytes.byteLength / 1024).toFixed(1),
      model:    ttsModel,
      voice:    (kwargs.voice as string) || '(默认)',
      encoding,
    }];
  },
});

cli({
  site: 'fishaudio',
  name: 'my-recent',
  description: '查看我在 Fish Audio 最近使用过的声音模型（TTS 生成历史）',
  domain: 'fish.audio',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'limit', type: 'int', default: 20, help: '返回数量（默认 20，最多 50）' },
    { name: 'unique', type: 'bool', default: false, help: '只显示不重复的声音（每个声音只出现一次）' },
  ],
  columns: ['date', 'voice_id', 'voice', 'backend', 'text_preview'],
  func: async (page, kwargs) => {
    if (!page) fail('需要浏览器连接');
    const token = await getToken(page);

    const pageSize = Math.min((kwargs.limit as number) ?? 20, 50);
    const params = new URLSearchParams({
      state:       'finished',
      page_size:   String(pageSize),
      page_number: '1',
    });

    const data = await apiGet(page, token, `/task?${params}`) as { total: number; items: unknown[] };
    if (!data?.items?.length) {
      fail(
        '暂无 TTS 生成记录',
        '前往 https://fish.audio/zh-CN/app/text-to-speech/ 生成一段语音后再查询',
      );
    }

    type TaskItem = {
      _id: string;
      backend: string;
      created_at: string;
      model?: { _id: string; title: string };
      parameters?: { text?: string };
    };

    const items = data.items as TaskItem[];
    const seen = new Set<string>();

    return items
      .filter(t => {
        if (!(kwargs.unique as boolean)) return true;
        const key = t.model?._id ?? '';
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(t => ({
        date:         (t.created_at ?? '').slice(0, 10),
        voice_id:     t.model?._id ?? '(无)',
        voice:        t.model?.title ?? '(默认)',
        backend:      t.backend ?? '—',
        text_preview: (t.parameters?.text ?? '').slice(0, 40).replace(/\n/g, ' ') + '…',
      }));
  },
});

cli({
  site: 'fishaudio',
  name: 'my-favorites',
  description: '查看我在 Fish Audio 平台上收藏的声音模型（扫描公开模型中已收藏项）',
  domain: 'fish.audio',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'query', type: 'str', default: '', positional: true, help: '声音名称关键词过滤（可选）' },
    { name: 'language', type: 'str', default: '', help: '按语言过滤，如 zh、en、ja' },
    {
      name: 'sort_by',
      type: 'str',
      default: 'score',
      choices: ['score', 'task_count', 'created_at'],
      help: '排序方式: score | task_count | created_at（默认: score）',
    },
    { name: 'limit', type: 'int', default: 20, help: '扫描数量（默认 20，最多 100）' },
  ],
  columns: ['id', 'title', 'author', 'languages', 'likes', 'tasks'],
  func: async (page, kwargs) => {
    if (!page) fail('需要浏览器连接');
    const token = await getToken(page);

    // fish.audio 公开 API 无专用"收藏列表"端点；
    // 拉取公开模型并筛选当前用户已标记（marked=true）的条目。
    const scanSize = Math.min((kwargs.limit as number) ?? 20, 100);
    const params = new URLSearchParams({
      page_size:   String(scanSize),
      page_number: '1',
      sort_by:     (kwargs.sort_by as string) || 'score',
    });
    if (kwargs.query)    params.set('title', kwargs.query);
    if (kwargs.language) params.set('language', kwargs.language);

    const data = await apiGet(page, token, `/model?${params}`) as { total: number; items: unknown[] };
    if (!data?.items) {
      fail('获取模型列表失败');
    }

    const favorites = (data.items as Record<string, unknown>[]).filter(m => m.marked === true);

    if (!favorites.length) {
      fail(
        `在前 ${scanSize} 条结果中未找到已收藏模型`,
        '收藏的声音可能排序靠后；请用 --query 关键词缩小范围，或前往 https://fish.audio/discover/ 查看',
      );
    }

    return favorites.map(m => ({
      id:        m._id,
      title:     m.title,
      author:    (m.author as Record<string, unknown>)?.nickname ?? '',
      languages: ((m.languages as string[]) || []).join(', ') || '—',
      likes:     m.like_count ?? 0,
      tasks:     m.task_count ?? 0,
    }));
  },
});

cli({
  site: 'fishaudio',
  name: 'auth-check',
  description: '诊断 Fish Audio 登录状态，显示 localStorage / cookie 信息',
  domain: 'fish.audio',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ['status', 'token_key', 'token_prefix', 'ls_keys', 'cookie_keys'],
  func: async (page) => {
    if (!page) fail('需要浏览器连接');
    await page.goto('https://fish.audio');
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
    })()`) as { token: string | null; tokenKey: string | null; lsKeys: string[]; cookieKeys: string[] };

    return [{
      status:       result.token ? '✅ 已登录' : '❌ 未登录',
      token_key:    result.tokenKey  || '(未找到)',
      token_prefix: result.token     ? result.token.slice(0, 20) + '...' : '—',
      ls_keys:      result.lsKeys.join(', ')    || '(空)',
      cookie_keys:  result.cookieKeys.join(', ') || '(空)',
    }];
  },
});

/** 提取 token 的内联 JS（与 getToken 保持一致，供 login 轮询使用）*/
const EXTRACT_TOKEN_JS = `(async () => {
  const found = { token: null };
  const direct = localStorage.getItem('token');
  if (direct && direct.trim().length > 10) { found.token = direct.trim(); return found; }
  for (const key of Object.keys(localStorage)) {
    try {
      const raw = localStorage.getItem(key) || '';
      if (raw.length < 10) continue;
      if (raw.startsWith('ey') && raw.split('.').length === 3) { found.token = raw; return found; }
      try {
        const obj = JSON.parse(raw);
        const t = obj?.token || obj?.access_token || obj?.api_key;
        if (typeof t === 'string' && t.length > 10) { found.token = t; return found; }
      } catch {}
    } catch {}
  }
  for (const cookie of document.cookie.split(';').map(c => c.trim()).filter(Boolean)) {
    const eq = cookie.indexOf('=');
    const val = decodeURIComponent(cookie.slice(eq + 1) || '');
    if (cookie.slice(0, eq).trim() === 'token' && val.length > 10) { found.token = val; return found; }
    if (val.startsWith('ey') && val.split('.').length === 3) { found.token = val; return found; }
  }
  return found;
})()`;

/**
 * 尝试点击登录页的提交按钮（浏览器已记住账号密码，表单自动填充后直接提交）。
 * 返回是否成功找到并点击了按钮。
 *
 * 按钮选择器优先级：
 *   1. type="submit" 按钮
 *   2. 包含"登录"/"Sign in"/"Log in"/"Continue"文字的按钮
 *   3. form 内第一个 button
 */
const CLICK_SUBMIT_JS = `(() => {
  // 优先找 type=submit
  let btn = document.querySelector('button[type="submit"]');
  if (!btn) {
    // 按文字匹配
    const keywords = ['登录', 'Sign in', 'Log in', 'Login', 'Continue', '继续'];
    btn = Array.from(document.querySelectorAll('button')).find(b =>
      keywords.some(k => b.textContent?.trim().includes(k))
    ) || null;
  }
  if (!btn) {
    // form 内第一个按钮
    btn = document.querySelector('form button');
  }
  if (btn) { btn.click(); return true; }
  return false;
})()`;

cli({
  site: 'fishaudio',
  name: 'login',
  description: '打开 Fish Audio 登录页，自动点击登录按钮（浏览器已记住密码时一键完成）',
  domain: 'fish.audio',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    {
      name:    'timeout',
      type:    'int',
      default: 60,
      help:    '等待登录完成的最长秒数（默认 60 秒）',
    },
    {
      name:    'force',
      type:    'bool',
      default: false,
      help:    '即使已登录也强制重新执行登录流程',
    },
  ],
  columns: ['status', 'token_prefix'],
  func: async (page, kwargs) => {
    if (!page) fail('需要浏览器连接');

    const LOGIN_URL = `${FISH_DOMAIN}/zh-CN/auth/?redirect=%2Fapp%2F`;

    // 非强制模式下：已有 token 则直接返回
    if (!(kwargs.force as boolean)) {
      const currentUrl = await page.evaluate(`(() => location.href)()`) as string;
      if (currentUrl?.includes('fish.audio') && !currentUrl.includes('api.fish.audio')) {
        const pre = await page.evaluate(EXTRACT_TOKEN_JS) as { token: string | null };
        if (pre.token) {
          return [{
            status:       '✅ 已登录（跳过，用 --force 可强制重新登录）',
            token_prefix: pre.token.slice(0, 20) + '...',
          }];
        }
      }
    }

    // 导航到登录页（框架 waitUntil 仅支持 load/none；这里用 load 确保表单已渲染）
    await page.goto(LOGIN_URL, { waitUntil: 'load', settleMs: 500 });

    // 等待浏览器自动填充密码（通常在 DOMContentLoaded 后 0.5-1 秒完成）
    await page.wait(1.5);

    // 尝试自动点击登录按钮
    const clicked = await page.evaluate(CLICK_SUBMIT_JS) as boolean;

    // 无论是否点击成功，轮询等待 token 出现（用户也可能手动点）
    const maxSeconds = Math.max(10, (kwargs.timeout as number) ?? 60);
    let token: string | null = null;

    for (let elapsed = 0; elapsed < maxSeconds; elapsed += 2) {
      await page.wait(2);
      const r = await page.evaluate(EXTRACT_TOKEN_JS) as { token: string | null };
      if (r.token) { token = r.token; break; }

      // 若首次未能点击（按钮还未渲染），每 4 秒重试一次点击
      if (!token && elapsed % 4 === 2) {
        await page.evaluate(CLICK_SUBMIT_JS);
      }
    }

    if (!token) {
      fail(
        `登录超时（${maxSeconds} 秒内未检测到 token）`,
        clicked
          ? '按钮已点击但未跳转，请检查账号密码是否正确，或手动在浏览器窗口完成登录后重试'
          : '未找到登录按钮，请手动在浏览器窗口点击登录，或用 --timeout 延长等待时间',
      );
    }

    return [{
      status:       `✅ 登录成功${clicked ? '（自动点击）' : '（手动完成）'}`,
      token_prefix: token!.slice(0, 20) + '...',
    }];
  },
});
