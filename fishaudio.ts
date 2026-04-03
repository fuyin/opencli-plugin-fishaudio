/**
 * Fish Audio — OpenCLI plugin
 *
 * 无需 API Key：复用 Chrome 中已登录的 https://fish.audio 会话。
 *
 * @see https://github.com/jackwener/opencli-plugin-fishaudio
 */

import { cli, Strategy, type IPage } from '@jackwener/opencli/registry';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const BASE_URL = 'https://api.fish.audio';

/**
 * 报告错误并抛出（不依赖 registry 中的 CliError，兼容 @jackwener/opencli 1.5.x–1.6.x
 * 等未从 `@jackwener/opencli/registry` 导出 CliError 的版本；避免插件在加载阶段因
 * 缺失导出而整块注册失败）。
 */
function fail(message: string, hint?: string): never {
  throw new Error(hint ? `${message}\n→ ${hint}` : message);
}

async function getToken(page: IPage): Promise<string> {
  await page.goto('https://fish.audio');
  await page.wait(2);

  const result = await page.evaluate(`(async () => {
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
              found.token = t; found.tokenKey = 'localStorage:' + key + '.' + (obj.token ? 'token' : obj.access_token ? 'access_token' : 'api_key'); break;
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
  })()`) as { token: string | null; tokenKey?: string; keys: string[]; cookieKeys: string[] };

  if (!result?.token) {
    const lsInfo  = result?.keys?.length  ? `localStorage keys: [${result.keys.join(', ')}]`   : 'localStorage is empty';
    const ckInfo  = result?.cookieKeys?.length ? `cookies: [${result.cookieKeys.join(', ')}]` : 'no cookies';
    fail(
      'Fish Audio 未登录（未找到 token）',
      `请在 Chrome 中打开 https://fish.audio 完成登录后重试。\n诊断信息：${lsInfo}；${ckInfo}`,
    );
  }

  return result.token;
}

async function apiGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>;
    fail(
      (err?.message as string) || `Fish Audio API 错误 ${res.status}`,
      res.status === 401 ? '登录态已过期，请在 Chrome 中重新登录 fish.audio' : undefined,
    );
  }
  return res.json();
}

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

    const data = await apiGet(token, `/model?${params}`) as { total: number; items: unknown[] };
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

    const data = await apiGet(token, `/model?${params}`) as { total: number; items: unknown[] };
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
    const body: Record<string, unknown> = {
      text:      kwargs.text,
      format:    encoding,
      normalize: true,
      latency:   'normal',
      prosody:   { speed },
    };
    if (kwargs.voice) body.reference_id = kwargs.voice;

    const res = await fetch(`${BASE_URL}/v1/tts`, {
      method: 'POST',
      headers: {
        Authorization:   `Bearer ${token}`,
        'Content-Type':  'application/json',
        model:           (kwargs.model as string) || 's1',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>;
      const hint =
        res.status === 401 ? '登录态已过期，请在 Chrome 重新登录 fish.audio' :
        res.status === 402 ? '账号额度不足，请前往 https://fish.audio/go-api/ 充值' :
        undefined;
      fail((err?.message as string) || `TTS 请求失败 (${res.status})`, hint);
    }

    const outputPath: string = (kwargs.output as string) || 'output.mp3';
    const buffer = await res.arrayBuffer();
    const bytes  = new Uint8Array(buffer);

    const dir = dirname(outputPath);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });

    writeFileSync(outputPath, bytes);

    return [{
      file:     outputPath,
      size_kb:  (bytes.byteLength / 1024).toFixed(1),
      model:    (kwargs.model as string) || 's1',
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

    const data = await apiGet(token, `/task?${params}`) as { total: number; items: unknown[] };
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

    const rows = items
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

    return rows;
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
    // 通过拉取最多 100 条公开模型，筛选当前用户已标记（marked=true）的条目。
    const scanSize = Math.min((kwargs.limit as number) ?? 20, 100);
    const params = new URLSearchParams({
      page_size:   String(scanSize),
      page_number: '1',
      sort_by:     (kwargs.sort_by as string) || 'score',
    });
    if (kwargs.query)    params.set('title', kwargs.query);
    if (kwargs.language) params.set('language', kwargs.language);

    const data = await apiGet(token, `/model?${params}`) as { total: number; items: unknown[] };
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
