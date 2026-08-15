# dsh-mcp

Standalone MCP server management plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a persistent server registry, per-server `mcp-client` mounts, environment injection, connection probing, and a Web settings page with tool control.

**[English](README.en.md) | [简体中文](README.zh.md)**

## Quick install

```sh
dsh plugin --profile web add dsh-mcp
```

Then register the plugin row in `$DSH_HOME/profiles/web/cordis.patch.yml` and restart `dsh web` — see the [installation docs](README.en.md#install) for details.

## Languages

- English: [README.en.md](README.en.md)
- 简体中文: [README.zh.md](README.zh.md)

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
