# 版本历史（0.3.0 → 0.3.3 详细说明）

README 只保留「是什么 / 怎么装 / 16 个入口 / 红线」；这里放逐版本的实现细节，供维护与排障时查阅。

## 扩展层（本地 fork：wincu 0.3.0）

这一版在上游 0.2.3 之上加了一层"取各家精华"的扩展，全部通过 `scripts/windows-uia-ext.ps1` 挂在同一个后端进程里，不引入任何新的 npm 依赖。

### 新增工具（16 个）

| 工具 | 作用 |
| --- | --- |
| `capabilities` | 能力体检：UIA 可达性、截图三级链、OCR 后端、显示器/DPI、宿主进程是否提权、虚拟光标、观测预算、录制状态、红线清单，并给出"缺能力会导致哪类操作降级" |
| `target_identity` | 结构化窗口身份：hwnd / pid / 进程名 / 标题 / 类名 / 矩形 / 所在显示器 / 是否提权。多窗口同名时先用它确认打到谁 |
| `clipboard_read` / `clipboard_write` | 剪贴板桥：格式探测、文本长度/预览/全文、文件拖放列表；写入纯文本 |
| `launch_app` | 按 exe / AUMID / URL 启动，并**等窗口出现**，直接返回 pid + 新窗口 |
| `kill_app` | `mode:'close'` 先发 WM_CLOSE（应用可弹保存框否决），`mode:'kill'` 才强杀 |
| `observe` | 有预算的观测：`region` 裁剪、`cropToElement` 裁到元素、`returnMode: inline/file/hash`、`diffOnly`（画面没变就不回图），并附哈希/字节数/是否变化/变化框 |
| `verify_state` | 验证闭环：`window_exists / title_contains / class_equals / process_running / element_present / element_absent / element_value / image_changed`，可 `timeoutMs` 轮询到全部通过 |
| `agent_cursor` / `virtual_move` | **虚拟光标**：独立 helper 进程绘制的点击穿透置顶箭头，**不动真实指针、不抢焦点** |
| `virtual_click` | 虚拟光标动画到位 + 后台 PostMessage 投递点击；如实回报 `verified:false`（Chromium/Electron/UWP 可能吞掉） |
| `describe` | 文本模型的视觉回退：截图 → 自动反色/对比度增强/2× 放大 → Windows OCR 文本 + 逐词框；若配置了 `WCU_VLM_URL` 还会问一次视觉模型 |
| `record_start` / `record_stop` / `record_status` | 把每次工具调用（参数、耗时、结果摘要、目标身份）录成 `wcu-trace/1` JSONL |
| `replay` | 回放轨迹：窗口身份按 hwnd → pid → 标题重定位，元素失效如实报告而不是乱点 |

### 统一结果信封

每个动作的返回都带 `envelope: { schema:"wcu-envelope/1", action, elapsedMs, target:{...} }`，其中 `target` 是**这次动作真正打到的窗口身份**（含进程名、是否提权、所在显示器）。

### 观测预算与证据

- `snapshot` 带 `region / cropToElement / diffOnly / returnMode` 任一参数时自动走 `observe`，语义不变。
- 输入类工具支持 `evidence:true`：动作前后各抓一张降采样图并给 SHA-256，返回 `changed`。**"已投递"不等于"已生效"**，所以还配了 `verify_state`。

### 红线（写进代码，不是提示词）

终端 / 控制台宿主（cmd、powershell、pwsh、WindowsTerminal、OpenConsole、conhost、mintty、bash、wsl）、任务管理器、注册表编辑器、凭据管理器（KeePass/1Password/Bitwarden/…）、UAC 与登录界面：**输入类工具直接拒绝执行**，返回 `{ok:false, refused:"red-line", inputSent:false}`。启动/结束进程与窗口管理不受此限（那不是"操控"它）。需要刻意放行时由操作者在宿主环境设 `WCU_ALLOW_REDLINES=1`。

### 视觉回退（可选 VLM）

设 `WCU_VLM_URL`（OpenAI 兼容的 `/chat/completions`）、`WCU_VLM_KEY`、`WCU_VLM_MODEL` 后，`describe` 会在 OCR 之外再问一次视觉模型。

### 已知边界

- 上游的 `test/backend-lifecycle.mjs` 在本机失败，原因是它硬编码 `WINDOWS_CU_POWERSHELL=pwsh`（本机只装了 Windows PowerShell 5.1），与本次改动无关；其余 8 个套件全绿。
- 浏览器自动化仍不在 wincu 范围内（建议独立插件走 CDP）。

### 安装前置：MCP 桥接包

wincu 的 bundle patch 会往 profile 里插入一行 `@deepseek-ai/dsh-mcp-client`（serverName `wincu`），这行由 **profile 根目录**解析依赖。因此 profile 必须能解析到它，否则 dsh 启动时会直接禁用该行：

```
dsh: disabling profile plugin row "mcp-dsh-computer-use-win":
its declared peer dependencies cannot be validated:
ENOENT ... node_modules/@deepseek-ai/dsh-mcp-client/package.json
```

安装/升级 wincu 后请确认（或直接补装）：

```powershell
dsh plugin --profile web add @deepseek-ai/dsh-mcp-client@0.2.0-rc.1
```

注意它必须是 **profile 的直接依赖**（pnpm 只会把直接依赖软链到 profile 根的 node_modules），作为插件的传递依赖是解析不到的。

## 0.3.1 —— 策略层与体验（第二批）

### 更安全的默认

- **`homing` 默认 `strict`**：目标窗口自观察以来移动过就**拒绝执行**（`window_moved` + 精确 dx/dy），要求重新观察；`auto` 才自动补偿并回显 `homed{dx,dy}`，`off` 完全跳过检查。上游"静默纠偏"的行为改为显式选择。
- **`approve:true` 闸门**：`kill_app{mode:'kill'}`、`close_window`、系统级组合键（Alt+F4 / Ctrl+Shift+Esc / Ctrl+Alt+Del）默认拒绝，返回 `refused:"approval-required"` 与理由。
- **红线可配置**：`%USERPROFILE%\.dsh\wincu-redlines.json` 支持 `{processes, classes, titles}` 追加操作者自己的禁令；另有**改名免疫**启发式——只要目标进程拥有 `ConsoleWindowClass` 窗口，无论可执行文件叫什么都会被拦。

### `space`：坐标空间终于说清楚了

`click / double_click / move / drag / scroll / element_info` 支持 `space: "screen" | "window" | "client"`。窗口局部/客户区坐标在引擎内换算成屏幕像素，结果同时回显 `space / requested / screen / windowLocal / clientLocal`。画布类应用（Mine-imator、画图）不用再手工换算。

### `act()`：意图级动作 + 投递阶梯 + 内置验证

```
act { action, elementId | x,y(+space), expect:[...], delivery:"ladder", allowForeground:false }
```

依次尝试 **semantic（UIA 模式）→ background（PostMessage）→ foreground（真实输入，需 `allowForeground:true`）**，每一级之后都用 `expect` 谓词或像素变化判定成败，返回走过的每一级、方法、耗时与判定依据。实测：Notepad 后台投递成功但像素未变 → `outcome:"unverified"`；放开 foreground 后第三级成功 → `outcome:"verified", verifiedBy:"pixels"`。**"点了但没反应"从此是报告出来的事实，不是猜测。**

### 观测预算

- `region: "clientArea"` 直接裁到客户区（去掉标题栏/边框）；实测同一窗口 **280 KB → 19 KB**。
- `stableMs`：画面连续 N 毫秒不变才返回（替代拍脑袋的 sleep），返回 `settleMs`。
- `tokenEstimate` + `imageBudgetHint`：超过 200 KB 会提示改用 hash/region/diffOnly。
- `returnMode:"auto"`：小图内联、大图只回路径。
- 观测基线**落盘**到 `%TEMP%\wcu-baselines.json`，后端进程被回收后 `diffOnly` 仍然可用。
- 每次观测返回 `observationId`，配合 **`click_image_point {observationId, imageX, imageY}`** 用图片像素直接点击（自动处理缩放与裁剪）——实测 image (120,30) 在 scale 0.6311 下正确换算为屏幕 (223,74)。

### 回放升级

录制时记录**元素指纹**（name/automationId/className/controlType/bbox/runtimeId）；回放按"原 id → automationId → name"重定位，每步用录制时的结果做 **outcome drift** 校验（录制时像素变了、回放没变 → 判失败）；支持 `vars` 参数化（`${name}` 占位符）与 `fromStep/toStep` 区间。

### 运维与可观测

- **`doctor`**：一次调用体检 MCP 桥接包、profile 依赖、后端存活、UIA/截图/OCR、光标 helper、红线配置、基线文件、录制状态、当前工具分组。
- **`stats`**：每个工具的调用数、错误数、p50/p95/max 延迟。
- **`WCU_TOOL_GROUPS`**：按组裁剪工具面（`vision` / `cursor` / `record` / `dev`），默认全开；关掉的组既不出现在 `tools/list`，调用也会被明确拒绝。

### 虚拟光标增强

`label`（光标下方文字标签）、`trail`（淡出轨迹）、`doubleClick`（真实 WM_LBUTTONDBLCLK + 第二圈涟漪）、`reducedMotion`；未指定窗口目标时改用 **`WindowFromPoint`** 找到该点所属窗口（返回 `targetHwndSource:"window-from-point"`），实在没有窗口才报 `no-input-surface`。

### 上游同步

`docs/fork-delta.md` 列出与上游的全部差异与重放要点；`node tools/sync-upstream.mjs <upstream> [--write]` 自动重放可定位的锚点并列出必须手工处理的项。

## 0.3.2 —— 向 Codex 官方 CU 学到的 10 条

对照本机 `@oai/sky` 0.7.1（Codex 官方运行时）与它的官方技能书，逐条落地：

1. **观测凭据强绑定**：`bindObservation:true` 时，动作必须携带有效 `observationId`；观测过期（此后再有输入动作）或被别的目标产生 → 直接拒绝（`observation-required` / `observation-stale` / `observation-target-mismatch`）。
2. **临时 UI 同帧抓取**：`observe` 现在把目标拥有的菜单/下拉/模态（`GW_OWNER` + `GetLastActivePopup`）收进**同一次**观测（`transientWindows` + 各自截图），另有 `transient_windows` 工具单独取列表。
3. **树查询裁剪**：`tree_query {query, tree}` 在已有无障碍树上做大小写不敏感搜索，只回命中节点 + 祖先上下文（含 depth），省 token。
4. **拖拽分段观察**：`drag_start` / `drag_step` / `drag_end` —— 按住不放，中途可以 `observe` 再决定往哪走；会话超时（默认 30s）自动松手。
5. **应用索引**：`list_apps` / `resolve_app` 从开始菜单快捷方式（WScript.Shell 解析目标）+ `Get-StartApps` 建立应用清单，带"是否在运行"和近期使用信号；`launch_app {app:"画图"}` 可以直接用中文名启动。
6. **元素动作面**：`element_info` 现在附带 `secondaryActions`（Invoke/Toggle/Expand/Collapse/Select/Scroll xxx/Raise/SetValue/SetRangeValue/Default/SetFocus），`element_actions` 单独查询，`secondary_action` 按名执行。
7. **动作后自动沉降**：提交类输入（click/type/key/scroll/set_value/invoke/secondary/drag_end/virtual_click/act）之后自动等画面稳定，结果里给 `settle.settleMs`；`settle:false` 可关。
8. **落点检测**：坐标输入前先问"这个点其实属于哪个窗口"，不属于目标窗口 → `point-owner-mismatch` 拒绝（`point_owner` 可单独查询，`allowAnyWindow:true` 可放行）。
9. **工作流技能书**：`docs/skills/computer-use/SKILL.md`（循环、纪律、**翻车恢复手册**、红线），并通过 MCP 资源 `windows-computer-use://skill/computer-use` 暴露。
10. **浏览器面显式化**：`capabilities.browser` 现在实测 CDP 端口（9222/9223/9224/9333）与在跑的浏览器进程，给出"该用独立浏览器插件"的明确提示——wincu 依然不做浏览器。

工具数 42 → **52**。

## 0.3.3 —— 入口收敛（B+C）

工具面从 **52 个入口 / 88,214 字符 ≈ 2.2 万 tokens** 收到 **16 个入口 / 17,996 字符 ≈ 4.5k tokens**（省约 **80%**），能力一条没少。

做法：**引擎动作完全不动**，只在 MCP 层加一张路由表——合并入口按 `action`/`mode` 路由到原来的动作，且路由发生在**所有策略检查之前**，所以分组开关、approve 闸门、红线、落点检测、观测绑定、录制统计全部照旧生效。旧工具名**仍然可调用**（只是不再出现在 `tools/list`），已有脚本和上游测试不受影响。

| 入口 | 覆盖的旧工具 |
| --- | --- |
| `read` | snapshot / accessibility_tree / find / element_info / tree_query / ocr |
| `mouse` | click / double_click / move / scroll / drag / drag_start·step·end / click_image_point |
| `keyboard` | type_text / keypress / focus |
| `element` | element_actions / invoke / set_value / secondary_action |
| `window` | list_windows / activate_window / close_window / move_window / transient_windows / target_identity |
| `app` | list_apps / resolve_app / launch_app / kill_app |
| `verify` | verify_state / point_owner |
| `cursor` | agent_cursor / virtual_move / virtual_click |
| `record` | record_start / record_stop / record_status / replay |
| `clipboard` | clipboard_read / clipboard_write |
| `status` | capabilities / doctor / stats |
| `wait` | wait / wait_for |
| `act` `observe` `describe` `health` | 同名保留 |

描述也做了瘦身：共享属性块（窗口目标 / 坐标空间 / homing / 策略）改成一行级说明，长教程挪进技能书 `docs/skills/computer-use/SKILL.md`（需要时才读）。
