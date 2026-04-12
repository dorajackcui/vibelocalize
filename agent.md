# Repo Agent Entry

这个仓库是一个通过 ChatGPT 页面批量处理 Excel/WPS 工作簿的自动化工具。给新 agent 的最快心智模型是：UI 负责配置和调度，真正的批处理执行发生在 loop 脚本里，Excel 读写由 Python helper 负责。

## 主执行链路

- `npm start`
- `scripts/app-launcher.mjs`
- `scripts/ui-server.mjs`
- `scripts/chatgpt-wps-loop.mjs`
- `scripts/workbook_helper.py`

补充说明：

- `npm run bootstrap` 用来首次绑定 ChatGPT project；没完成前不要直接跑正式任务。
- UI 只是把配置写进 `automation.config.json` 并启动 runner，不保存实际运行进度。
- 任务日志是 `ui-server.mjs` 里的内存态缓存，不是持久化状态。

## 核心文件导航

- `automation.config.json`
  当前运行配置。UI 会读写它，loop 也直接消费它。
- `scripts/app-launcher.mjs`
  启动 UI 服务，并在本机尝试打开浏览器。
- `scripts/ui-server.mjs`
  轻量 HTTP 服务，负责配置接口、文件选择、运行/停止任务和状态查询。
- `scripts/chatgpt-wps-loop.mjs`
  主批处理入口。负责 bootstrap 检查、批量读行、向 ChatGPT 发送 prompt、解析响应、写回工作簿、生成 review report。
- `scripts/lib/automation-config.mjs`
  配置默认值、merge、normalize 和派生统计逻辑都在这里。改配置结构时先看它。
- `scripts/workbook_helper.py`
  工作簿信息读取、批量读写、写入前检查都在这里完成。

## 运行与验证命令

- `npm install`
  安装 Node 依赖。
- `npm run bootstrap`
  首次绑定 ChatGPT project。
- `npm start`
  启动 UI；日常入口。
- `npm run run`
  直接运行 loop，前提是配置和 bootstrap 已准备好。
- `npm run ui`
  只启动 UI 服务。
- `node --test tests/review-report.test.mjs`
  当前仓库里比较可信的 Node 测试入口之一。
- `py -3 -m unittest tests.test_workbook_helper`
  现有 Python 测试入口，但先核对测试是否仍匹配实现。

## 修改约定

- 保持文本文件为 UTF-8。不要因为 PowerShell `Get-Content` 看起来乱码，就整文件重写。
- 在 Windows 下怀疑中文乱码时，用第二信源确认，比如 `rg`、`git diff`、`git show`，不要只信终端显示。
- 对必须精准匹配中文按钮文案的 UI 选择器，优先考虑 Unicode escape，尤其是会被 Windows shell 反复编辑的文件。
- 改 `automation.config.json` 的字段或默认值时，要同步检查：
  - `scripts/lib/automation-config.mjs`
  - `scripts/ui-server.mjs`
  - `scripts/chatgpt-wps-loop.mjs`
  - UI 表单读取/回填逻辑
- 回写 Excel 前会先做 write-check；如果文件被 Excel/WPS 占用、只读、目录不可写，任务会被拒绝启动。不要绕过这个保护。
- 修改工作簿写入逻辑时，默认假设用户可能正在用 WPS/Excel、同步盘、杀毒或预览程序占用文件。

## Agent 必知约束

- `chatgpt.projectUrl` 是 bootstrap 是否完成的关键标志；缺失时正式任务不应启动。
- `startRow` 只决定本次从哪里开始，不代表系统记住了历史进度。
- UI 现在会在选中文件和切换 sheet 后自动识别第 1 行里的 `source` / `target` 表头，并把 `startRow` 预填为第一条 `source` 有值且 `target` 为空的行；手动输入仍保留在折叠区里。
- loop 每批会校验输入行数和输出行数是否一致；不一致时仍会继续写回，并在结束后输出 review report。
- review report 会写到 `debug/review-report-*.json`，适合排查异常批次。
- 这个项目强依赖 ChatGPT 页面结构和交互细节；涉及页面选择器的修改时，要先确认当前实现依赖的 DOM/文案假设。

## 编码与文本安全

- 如果 PowerShell 里看到中文像“乱码 CJK 混合字符”或尾部出现 `?`，先怀疑显示或编码链路，不要立刻改源码。
- Node 调 Python 做文本交换时，优先显式使用 UTF-8 环境设置，例如 `PYTHONIOENCODING=utf-8` 和 `PYTHONUTF8=1`。
- 如果必须从 PowerShell 输出中文，优先显式设置：
  - `[Console]::InputEncoding`
  - `[Console]::OutputEncoding`
  - `$OutputEncoding`

## 已知风险与现状

- 当前仓库里有一些中文文案在 PowerShell 读取时会显示成乱码，但文件字节本身未必有问题；README 和 UI 都已经出现过这种现象。
- `tests/test_workbook_helper.py` 仍引用当前 `scripts/workbook_helper.py` 里看不到的符号，例如 `persist_workbook_update`、`overwrite_in_place_with_retry`、`copy_file_contents`。先核对真实实现，再决定是修测试还是补实现。
- 仓库可能处于脏工作区。改动前先看 `git status`，不要覆盖用户已经在做的修改。

## 接手建议

- 要理解运行链路，先读：
  - `scripts/chatgpt-wps-loop.mjs`
  - `scripts/ui-server.mjs`
  - `scripts/lib/automation-config.mjs`
- 要改 Excel 读写，直接看 `scripts/workbook_helper.py` 和 `tests/test_workbook_helper.py`，但不要先入为主相信测试一定是最新的。
- 要改用户操作体验，优先看 `ui/index.html` 和 `README.md`。
