# Workbook + ChatGPT Automation

## 操作指引

1. 安装依赖：
   `npm install`
2. 用可调试模式启动你自己的 Chrome：
   `mkdir -p "$HOME/.codex-chrome-debug-profile"`
   `open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.codex-chrome-debug-profile"`
3. 在这个 Chrome 里登录 ChatGPT，完成人类验证，并打开目标 project。
4. 首次运行前做一次绑定：
   `npm run bootstrap`
5. 启动界面：
   `npm run ui`
6. 打开：
   `http://127.0.0.1:4312`
7. 选择 `.xlsx` 或 `.xlsm` 文件，选好 sheet。
8. 设置参数后点 `确认参数`，看概览区是否同步显示。
9. 点 `开始任务`。

## 说明

- 默认是从 `A` 列读取，从 `B` 列开始回写。
- 每次运行都严格从当前 `startRow` 开始，不记忆上次进度。
- 运行时不要同时用 WPS 打开同一个文件，避免保存冲突。
- ChatGPT 返回内容会按“一次粘贴块”写入目标起始单元格。
- 如果回复里有 Markdown code block，脚本会优先提取 code block 内容。

## 常用命令

- `npm run bootstrap`
- `npm run ui`
- `npm run run`
- `node scripts/chatgpt-wps-loop.mjs --max-loops=1`
