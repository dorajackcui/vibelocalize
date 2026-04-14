# Workbook + ChatGPT Automation

## 操作指引

1. 安装依赖：
   `npm install`
2. 首次运行前做一次绑定：
   `npm run bootstrap`
3. 如果脚本发现没有可调试的 Chrome，会自动帮你拉起一个；在这个 Chrome 里登录 ChatGPT，完成人类验证，并打开目标 project。
4. 绑定完成后，日常直接启动：
   `npm start`
5. 页面会自动打开到：
   `http://127.0.0.1:4312`
6. 选择 `.xlsx` 或 `.xlsm` 文件，选好 sheet。
7. 上传后会自动识别第 1 行里的 `source` / `target` 表头，并默认把开始行定位到“`source` 有值且 `target` 为空”的第一行。
8. 如需覆盖自动识别结果，可展开“手动调整”修改 `startRow / sourceColumn / targetColumn`。
9. 设置参数后点 `确认参数`，看概览区是否同步显示。
10. 点 `开始任务`。

## 更省事的使用方式

- 首次初始化：`npm install` -> `npm run bootstrap` -> `npm start`
- 日常启动：`npm start`

## 说明

- 默认会自动识别 `source` / `target` 列；识别失败时可手动指定，未手动指定时仍会回退到配置里的当前值。
- 每次运行都严格从当前 `startRow` 开始，不记忆上次进度；默认 `startRow` 会按当前 sheet 的待处理首行自动预填。
- 运行时不要同时用 WPS 打开同一个文件，避免保存冲突。
- ChatGPT 返回内容会按“一次粘贴块”写入目标起始单元格。
- 如果回复里有 Markdown code block，脚本会优先提取 code block 内容。
- 每一批都会校验“输入行数”和“输出行数”是否一致；如果不一致，脚本仍会继续写回并跑完整个任务，但会在结束后把所有异常批次汇总到 `debug/review-report-*.json` 里，供人工复核。

## 常用命令

- `npm run bootstrap`
- `npm start`
- `npm run ui`
- `npm run run`
- `node scripts/chatgpt-wps-loop.mjs --max-loops=1`

## Tips Prompt

- `workflow.tipsPrompt` is optional and can be edited in the UI.
- When it is non-empty, every fresh conversation sends this prompt first, waits for ChatGPT to finish, and only then sends the first batch prompt for that conversation.
- The tips reply is not parsed and is never written back to Excel.
