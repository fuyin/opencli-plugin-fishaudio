# opencli-plugin-fishaudio

[Fish Audio](https://fish.audio) 文字转语音的 [OpenCLI](https://github.com/jackwener/opencli) 插件。**无需 API Key**：在 Chrome 中登录 fish.audio 后，通过 OpenCLI 浏览器桥读取会话 token 并调用官方 REST API。

## 安装

需要已安装 OpenCLI（>= 1.5.9，且包含将 `CliError` 导出到 `@jackwener/opencli/registry` 的版本）。

```bash
opencli plugin install github:jackwener/opencli-plugin-fishaudio
```

开发时可本地链接：

```bash
opencli plugin install file:///绝对路径/opencli-plugin-fishaudio
```

安装后新开终端，执行 `opencli list | grep fishaudio` 确认命令已注册。

## 命令

| 命令 | 说明 |
|------|------|
| `opencli fishaudio auth-check` | 诊断是否已从页面读到登录 token |
| `opencli fishaudio voices` | 浏览公开声音（可 `--language zh`、`--limit` 等） |
| `opencli fishaudio my-voices` | 我的声音模型 |
| `opencli fishaudio tts <text>` | 生成语音；`--voice <id>`、`--model s1\|s2-pro`、`--encoding mp3\|wav\|opus`、`--output path` |

注意：全局已有 `-f/--format` 表示**表格输出格式**，音频格式请用 **`--encoding`**。

## 示例

```bash
opencli fishaudio auth-check
opencli fishaudio voices --language zh --limit 10
opencli fishaudio tts "你好，世界" --voice <声音ID> --output hello.mp3
```

## 许可

Apache License 2.0（见 [LICENSE](./LICENSE)）。
