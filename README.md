# opencli-plugin-fishaudio

[Fish Audio](https://fish.audio) 文字转语音的 [OpenCLI](https://github.com/jackwener/opencli) 插件。**无需 API Key**：在 Chrome 中登录 fish.audio 后，通过 OpenCLI 浏览器桥读取会话 token 并调用官方 REST API。

## 安装

需要已安装 OpenCLI（>= 1.5.9）。插件不依赖 `@jackwener/opencli/registry` 中的 `CliError` 导出，可与 1.6.x 等版本正常使用。

```bash
opencli plugin install github:fuyin/opencli-plugin-fishaudio
```

开发时可本地链接（修改 `fishaudio.ts` 后执行 `npm install && npm run build` 更新 `fishaudio.js`，或确保全局已有 `esbuild` 以便安装时自动转译）：

```bash
cd opencli-plugin-fishaudio && npm install && npm run build
opencli plugin install file:///绝对路径/opencli-plugin-fishaudio
```

安装后新开终端，执行 `opencli list | grep fishaudio` 确认命令已注册。

## 命令

| 命令 | 说明 |
|------|------|
| `opencli fishaudio auth-check` | 诊断是否已从页面读到登录 token |
| `opencli fishaudio voices` | 浏览公开声音（可 `--language zh`、`--limit` 等） |
| `opencli fishaudio my-voices` | 我的声音模型（自己创建/上传的） |
| `opencli fishaudio my-recent` | 我最近使用过的声音（TTS 生成历史，按时间倒序） |
| `opencli fishaudio my-favorites` | 我收藏的声音（在搜索结果中扫描已收藏项） |
| `opencli fishaudio tts <text>` | 生成语音；`--voice <id>`、`--model s1\|s2-pro`（默认 s1）、`--encoding mp3\|wav\|opus`、`--output path` |

注意：全局已有 `-f/--format` 表示**表格输出格式**，音频格式请用 **`--encoding`**。

### my-favorites 说明

fish.audio 公开 REST API 没有专用的"我的收藏列表"端点。`my-favorites` 通过扫描公开模型列表，筛选出当前用户已标记（收藏）的条目。建议配合 `--query <关键词>` 缩小范围以提高命中率：

```bash
opencli fishaudio my-favorites --query "Sarah" --limit 50
```

## 示例

```bash
opencli fishaudio auth-check
opencli fishaudio voices --language zh --limit 10
opencli fishaudio my-voices
opencli fishaudio my-recent --limit 10
opencli fishaudio my-recent --unique          # 去重，每个声音只显示一次
opencli fishaudio my-favorites                # 扫描前 20 条公开声音里的收藏
opencli fishaudio my-favorites --query "Sarah" --limit 50
opencli fishaudio tts "你好，世界" --voice <声音ID> --output hello.mp3
```

## 许可

Apache License 2.0（见 [LICENSE](./LICENSE)）。
