# ESP32 每日灵感

每天 10 条 ESP32 新项目（5 条硬件改造 + 5 条 AI 玩法），全部来自公开仓库，自动抓取、自动去重。

## 它怎么跑

- **抓取**：`.github/workflows/daily.yml` 每天北京时间 08:00 在 GitHub 的机器上触发，不需要任何个人电脑开机。
- **选题**：`tools/collect.mjs` 用 7 组关键词搜 GitHub 新仓库，过滤掉 fork、awesome 清单、指南类仓库，按关键词自动分成硬件 / AI 两类，各取前 5 条。
- **文案**：调用 GitHub Models（`models: read` 权限，无需密钥）把 README 译成中文卡片文案：标题、80–140 字简介、「上手需要」、「难度」。
- **去重**：跟 `data/db.json` 里所有历史条目比对链接与标题相似度，撞上就丢弃。
- **产出**：写入 `data/db.json`，重建 `site/index.html`，然后提交回仓库。

## 数据

`data/db.json` 是唯一数据源：

- `days[]` —— 每天一组，10 条，`kind` 为 `hw` / `ai`
- `legacy[]` —— 早期整理的历史项目库，只展示、不参与每日配比

## 本地手动跑一次

```bash
GITHUB_TOKEN=你的token node tools/collect.mjs
GITHUB_TOKEN=你的token FORCE_DATE=2026-11-05 node tools/collect.mjs   # 指定日期
node tools/build.mjs                                                   # 只重建页面
```

`GITHUB_TOKEN` 需要 `models: read` 权限才能生成中文文案；没有 token 时会降级成模板文案（保留仓库原文）。
