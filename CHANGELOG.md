# Changelog

## 0.4.1 - GUI 实战暴露的缺陷修复

- 启动链：explorer shell:AppsFolder 在本机被拒(Access denied) -> cmd /c start 优先 + explorer 兜底 + 裸 shell 路径；URI 同链；回报 shellHandoff
- 启动已在运行的应用：无新窗口时取 shell 聚焦的窗口 pid，回报 reusedExistingWindow（此前 pid 不可用会让后续调用退化成前台窗口）
- 合并入口未知 action：结构化 invalid-action + allowedActions（此前静默回退 type_text）
- imageX/imageY 对任意指针动作生效（服务端统一换算），此前只有 click 支持
- region 裁切：返回文件真的是裁切图；bounds/origin/imageScale 修正
- 落点守卫：activate:true 先激活再判定（此前直接拒绝）
- move_window 支持 width/height（此前静默忽略）

## 0.4.0 — 审计驱动修复（B1 正确性 + B2 性能 + 实测发现）

正确性：
- 按名字启动：AUMID/URL 按 kind 路由（此前一律当路径 → 100% 失败），改走 explorer shell:AppsFolder；返回窗口属主 pid 而非 explorer 的 pid；失败给结构化 app-launch-failed
- 目标解析：优先可见/有标题窗口（此前会选中进程的隐藏 helper 弹窗）；标题匹配分层（精确 > 前缀 > 子串）；多匹配回报 ambiguousTitle + 候选
- 激活可靠性：Set-WindowForeground 改三级阶梯（AttachThreadInput+Alt → 置顶往返 → 重试 3 轮），逐级验证
- 焦点/落点判定接受同进程窗口；activate:true 改为服务端激活+校验并给结构化 activation-failed
- bindObservation 不再静默回退（伪造 id → observation-required），命中回显 boundObservationId
- 显式目标解析不到 → target-not-found（此前 observe 会偷偷拍前台窗口）
- 元素文本回读：新增 element_text（ValuePattern → TextPattern → LegacyIAccessible → GetWindowText），read {mode:element} 附带 text/textSource
- region:clientArea 裁切修复（字典字段读取不一致导致 0x0 与误报 cropWarning）
- LegacyIAccessiblePattern 类型守卫；守卫失败 fail-closed 并回报 guardsSkipped；拒绝路径也回报 ignoredArgs

性能：
- 后端预热 + kill 后立即后台重建；capabilities 缓存（696ms → 1ms）；应用索引缓存 120s（833ms → 41ms）
- 稳定探测重写：默认 1500ms 预算、最多 8 次（实测 32 张截图/6021ms → 3 次/410ms）
- 守卫共享一次目标解析；target_identity 可同回前台窗口
- 抓图管线：哈希改算原始像素、hash 模式不落盘、%TEMP% GC 改为每 2 分钟一次
- 虚拟光标：静止不重绘、无命令 5 分钟自退

验证：surface-test 36/36、tools/check.mjs 4/4、上游 7 套件全绿。

## 0.3.4 — 正确性、能力与护栏（P0/P1/P2）

P0 正确性：
- 参数卫生改为按**调用方看到的 schema**（合并入口）校验：此前 `observe {transient:false}` 这类只在合并 schema 里声明的参数会被丢掉
- `read`/`snapshot` 现在也会签发 `observationId`（服务端补发），`bindObservation` 对「先看后做」两条路径都成立
- 键盘输入新增焦点守卫：目标不是前台窗口时拒绝 `not-focused`（可用 `activate:true` 先激活，或 `allowUnfocused:true` 明确绕过）
- 新增 `node tools/check.mjs`（语法 + PS BOM/解析 + 路由审计 + 工具面预算守卫）与 `test/router-map.mjs`（16 入口 / 0 孤儿 / 卫生取值）

P1 能力：
- `read {mode:"window", diffAgainst:"<observationId>"}`：树差分（新增/消失/变化，含位移与值变化），默认用 diff 取代整棵树
- `observe {includeTree:true}`：同一瞬间拿像素 + 控件树
- `keyboard {method}` 暴露引擎既有的 clipboard / sendinput / background 三种注入；`delayMs` 支持逐字符节奏（sendinput）
- `mouse {action:"drag", phase:"end", expect:[...]}`：拖拽收尾可验证，不再是「拖完就算成功」

P2 工程：
- README 瘦身（13.5k → 7.9k 字符），0.3.0→0.3.3 细节移入 `docs/history.md`
- `status {detail:"budget"}` 会话级观测开销统计；`status {detail:"internals"}` 暴露基线缓存/观测缓存/录制状态（补上三个此前无入口的调试动作）
- `docs/fork-delta.md` 记录合并入口/策略层的重放要点与 PowerShell `,@()` 返回坑；`tools/sync-upstream.mjs` 的 hunk 列表细化到 8 项

## 0.3.3 — 入口收敛

修复（入口收敛过程中实测发现）：
- `Get-WcuAppIndex` / `Get-WcuTransientWindows` / `Select-WcuTreeQuery` 用 `return ,@(...)` 返回"装着整个数组的单元素数组"，调用方拿到后 `$a["isRunning"]` 变成拿字符串当数组下标 → `list_apps` 直接报 Int32 转换错误，`resolve_app` 的匹配失效（把整套应用当命中返回）、`window {action:"transient"}` 永远返回 0。改为返回扁平数组并显式给出排序键。

- 公开工具面 52 → **16**（`read` `mouse` `keyboard` `act` `element` `window` `app` `observe` `verify` `cursor` `record` `describe` `status` `clipboard` `wait` `health`）
- 每请求提示词成本 88,214 → 17,996 字符（≈22k → ≈4.5k tokens）
- MCP 层路由表把合并入口映射回原动作；路由先于策略检查执行
- 旧工具名保留可调用，仅从 `tools/list` 隐藏（上游测试与既有脚本不受影响）
- 技能书改写为 16 入口版本

## 0.3.2 — Codex 对齐批

- 观测凭据强绑定 `bindObservation` + `observationId`（过期/串目标一律拒绝）
- `observe` 同帧抓取 target 拥有的临时 UI（`transientWindows`）；新增 `transient_windows`
- `tree_query`：已有无障碍树的服务端裁剪查询
- `drag_start/drag_step/drag_end`：可中途观察的分段拖拽会话（超时自动松手）
- `list_apps` / `resolve_app` + `launch_app {app:"<名称>"}` 应用索引
- `secondaryActions` 元素动作面 + `element_actions` + `secondary_action`
- 提交类输入自动沉降 `settle.settleMs`
- 落点检测 `point-owner-mismatch` + `point_owner`
- `docs/skills/computer-use/SKILL.md` 工作流与恢复手册（MCP 资源）
- `capabilities.browser` 实测 CDP 端口与浏览器进程

## 0.3.1 — 策略层与体验

- `homing` 默认 strict（`window_moved` 拒绝），auto/off 可选；`approve:true` 闸门覆盖 kill/close/系统组合键
- `space: screen|window|client` 全坐标类工具支持并回显
- 新增 `act`（语义→后台→前台投递阶梯 + expect/像素验证）、`click_image_point`（图片像素直点）、`doctor`、`stats`
- observe：`region:"clientArea"`、`stableMs`、`tokenEstimate`、`imageBudgetHint`、`returnMode:"auto"`、`observationId`、基线落盘
- replay：元素指纹重定位、`vars` 参数化、`fromStep/toStep`、outcome drift 校验
- `WCU_TOOL_GROUPS` 工具分组；红线支持操作者配置文件与改名免疫的控制台启发式
- 虚拟光标：label/trail/doubleClick/reducedMotion + WindowFromPoint 目标解析
- 上游同步：`docs/fork-delta.md` + `tools/sync-upstream.mjs`
- 测试：`native-window-contract` 更新为 fork 契约（strict 拒绝 / auto 补偿 / off 跳过）

## 0.3.0 — 本地 fork（0.2.3 + 扩展层）

在 0.2.3 之上加入 `scripts/windows-uia-ext.ps1` 与 `scripts/agent-cursor.ps1` 扩展层，主脚本只做两处最小改动（点源扩展层、动作分发兜底 + 结果信封），上游两个文件缺失时自动降级为原行为。

新增 16 个工具：
- 诊断/身份：`capabilities`、`target_identity`
- 剪贴板与应用生命周期：`clipboard_read`、`clipboard_write`、`launch_app`、`kill_app`
- 观测预算：`observe`（region / cropToElement / returnMode / diffOnly / 哈希证据）
- 验证闭环：`verify_state`（8 类断言 + 轮询）
- 虚拟光标：`agent_cursor`、`virtual_move`、`virtual_click`（后台投递，如实标 verified:false）
- 视觉回退：`describe`（OCR 预处理 + 可选 VLM）
- 轨迹：`record_start` / `record_stop` / `record_status` / `replay`

其它：
- 每个结果附 `envelope`（动作、耗时、真实目标身份）
- 输入类工具支持 `evidence:true`（前后降采样哈希 + changed）
- 红线策略在 MCP 层与引擎层双重执行，拒绝时明说 `inputSent:false`
- `test/source-encoding.mjs` 扩展到三个 .ps1 文件


## 0.2.3 — 2026-09-28

- 修复 MCP 取消后 worker 继续阻塞及旧 worker 退出影响替代进程的问题；带激活行为的读取和已发出的输入完成当前动作后再回收，仍受现有超时限制。
- 顶层窗口发现改用 EnumWindows；目标解析保留此前观察的坐标缓存，HWND/PID 元素 ID 校验窗口身份和 viewMode。
- 检查光标定位和点击输入返回值，成功按下后在异常路径中尝试释放；新增 PowerShell 5.1/7 隔离回归测试。
- 保留后端脚本的 UTF-8 BOM，避免 Windows PowerShell 5.1 在非 UTF-8 系统编码下解析失败，并增加编码回归检查。
- Fixed worker cancellation and replacement isolation, native window discovery with preserved coordinate observations, and checked click input cleanup. Activation-aware cancellation remains bounded by the existing timeout. Added isolated PowerShell 5.1/7 regressions.
- 感谢 / Thanks to [@xut1021](https://github.com/xut1021) for the report, patches and tests in [#8](https://github.com/Yu-tao-Li/dsh-computer-use-win/issues/8), [#9](https://github.com/Yu-tao-Li/dsh-computer-use-win/pull/9), [#10](https://github.com/Yu-tao-Li/dsh-computer-use-win/pull/10) and [#11](https://github.com/Yu-tao-Li/dsh-computer-use-win/pull/11).

## 0.2.2 — 2026-09-26

- **修复 `ocr` 的 `query` 参数被 schema 禁止**([#6](https://github.com/Yu-tao-Li/dsh-computer-use-win/issues/6)):handler 一直支持并处理 `query`(返回 `query`/`matched`),README 也已宣传,但 `additionalProperties: false` 的 schema 未声明该参数,规范客户端永远无法发送。现已加入 `ocr` 的 inputSchema。感谢 [@TomJerry234](https://github.com/TomJerry234) 的自动化审计。
- **统一 `viewMode`/`includeOffscreen` 的行为与文档**([#4](https://github.com/Yu-tao-Li/dsh-computer-use-win/issues/4)):这两个参数作用于 scope 解析与树遍历;`uia:rt:*` 形式的元素 id 由 RuntimeId 直接定位、按设计绕过视图过滤。现在所有路径都会校验 `viewMode` 合法性(此前非法值在 `uia:rt:*` 路径被静默吞掉、在 legacy 路径报错,行为不一致),schema 描述与 `docs/wiki/mcp-tools.md` 已写明该语义。
- **`activate` 参数在所有声明它的路径上生效或如实文档化**([#5](https://github.com/Yu-tao-Li/dsh-computer-use-win/issues/5)):此前 `activate` 只在 drag/type_text/keypress 与元素解析路径被读取。现在 `click`/`double_click`/`move`/`scroll` 的 x/y 坐标路径也会先激活目标窗口(坐标输入命中的是物理位置的像素,目标被遮挡时输入会静默落到遮挡窗口上);`ocr` 在 `activate: true` 时先置前再截屏(被遮挡窗口截到的是遮挡者像素;激活被前台锁拒绝时在结果里加 `warning` 而不失败);`move_window` 尊重 `activate: true`(去掉硬编码的 `SWP_NOACTIVATE`,并通过 `Set-WindowForeground` 助手强制置前——`SetWindowPos` 的隐式激活会被 Windows 前台锁静默拒绝;结果新增 `activated` 字段,被拒时附 `warning`),默认仍不抢焦点;`element_info` 的 FromPoint 路径同样先激活。`close_window`(WM_CLOSE 后台即可)与 `activate_window`(工具本身就是激活)按文档写明语义。感谢 [@TomJerry234](https://github.com/TomJerry234) 的自动化审计。
- 修复 `mcp/server.mjs` 硬编码 `SERVER_VERSION` 与 `package.json` 版本漂移的问题:现在从 `package.json` 读取版本号。
- **Fixed the `ocr` `query` parameter being forbidden by its own schema** ([#6](https://github.com/Yu-tao-Li/dsh-computer-use-win/issues/6)): the handler always supported and processed `query` (returning `query`/`matched`) and the README advertised it, but the `additionalProperties: false` inputSchema never declared it, so schema-respecting clients could not send it. `query` is now part of the `ocr` schema. Thanks to [@TomJerry234](https://github.com/TomJerry234) for the automated schema-vs-implementation audit.
- **Made `viewMode`/`includeOffscreen` behaviour consistent and documented** ([#4](https://github.com/Yu-tao-Li/dsh-computer-use-win/issues/4)): the two parameters apply to scope resolution and tree walking; `uia:rt:*` element ids are looked up directly by RuntimeId and bypass view filtering by design. `viewMode` is now validated on every path (an illegal value used to be silently swallowed on the `uia:rt:*` path while the legacy path threw), and the schema descriptions plus `docs/wiki/mcp-tools.md` document the semantics.
- **`activate` now works or is honestly documented on every path that declares it** ([#5](https://github.com/Yu-tao-Li/dsh-computer-use-win/issues/5)): `activate` was only read by drag/type_text/keypress and element-target resolution. Now the x/y coordinate paths of `click`/`double_click`/`move`/`scroll` activate the target window first (coordinate input hits whatever is physically under the point — with the target occluded, input silently landed on the overlapping window); `ocr` brings the window forward before capturing when `activate: true` (an occluded window captured the occluder's pixels; if the foreground lock refuses activation the result carries a `warning` instead of failing); `move_window` honours `activate: true` (the hardcoded `SWP_NOACTIVATE` is now conditional, and the switch is enforced via the `Set-WindowForeground` helper — `SetWindowPos`'s implicit activation is silently refused by the Windows foreground lock; the result gains an `activated` field plus a `warning` when refused, default unchanged); `element_info`'s FromPoint path activates too. `close_window` (WM_CLOSE works in the background) and `activate_window` (the tool is the activation) now document their semantics. Thanks to [@TomJerry234](https://github.com/TomJerry234) for the automated audit.
- Fixed `mcp/server.mjs` reporting a hardcoded `SERVER_VERSION` that drifted from `package.json`: the version is now read from `package.json`.

## 0.2.1 — 2026-09-26

- 修复窗口激活无条件调用 `SW_RESTORE` 的问题：对最大化/贴靠窗口执行带 `activate: true` 的工具时会取消其最大化并重置位置大小（含用户自己的宿主窗口，并连带导致坐标点击偏移）。现在仅当窗口确实最小化（`IsIconic`）时才还原，其余情况不动窗口状态。感谢 [@snmtg1008](https://github.com/snmtg1008) 在 [#2](https://github.com/Yu-tao-Li/dsh-computer-use-win/issues/2) 中定位并给出修法。
- Fixed window activation unconditionally calling `SW_RESTORE`: any tool run with `activate: true` un-maximized maximized/snapped windows and reset their position and size (including the user's own host window, and cascading into misaligned coordinate clicks). `SW_RESTORE` is now issued only when the window is actually minimized (`IsIconic`); otherwise the window state is left untouched. Thanks to [@snmtg1008](https://github.com/snmtg1008) for diagnosing the issue and proposing the fix in [#2](https://github.com/Yu-tao-Li/dsh-computer-use-win/issues/2).

## 0.2.0 — 2026-09-10

- 修复 DSH profile 安装后的 `mcp/server.mjs` 路径解析：通过 profile 的 `package.json` 解析已安装的 npm 包，兼容 pnpm 布局。
- Fixed DSH profile startup path resolution by resolving the installed npm package through the host profile's `package.json`, including pnpm layouts.
- 新增 profile 路径回归测试并接入 `npm test` 和 GitHub Actions CI。
- Added a profile-resolution regression test and wired it into `npm test` and GitHub Actions CI.
- README 增加 npm 安装方式，并同步更新中英文路径说明。
- Documented the npm installation route and refreshed the bilingual path-resolution guidance.
- 感谢 [@CnsMaple](https://github.com/CnsMaple) 在 [#1](https://github.com/Yu-tao-Li/dsh-computer-use-win/pull/1) 中定位并修复该问题。
