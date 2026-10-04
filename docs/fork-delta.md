# fork-delta — 这个 fork 与上游的差异清单

上游基线：**dsh-computer-use-win 0.2.3**（npm），fork 版本 **0.3.0**。
升级上游时按本文件逐条重放；`node tools/sync-upstream.mjs <upstream-checkout> [--write]` 会先自动重放能定位的锚点，并列出必须手工处理的项。

## 新增文件（不需要合并，直接保留）

| 文件 | 作用 |
| --- | --- |
| `scripts/windows-uia-ext.ps1` | 扩展层：全部新动作（capabilities/target_identity/clipboard/launch-kill/observe/verify_state/act/click_image_point/describe/agent_cursor/virtual_*） |
| `scripts/agent-cursor.ps1` | 虚拟光标 overlay（独立进程，点击穿透、不抢焦点、不动真指针） |
| `tools/sync-upstream.mjs` | 上游升级辅助 |
| `docs/fork-delta.md` | 本文件 |

## 修改 `scripts/windows-uia.ps1`（必须重放）

1. **扩展层点源 + 缺失降级**：`$script:WcuExtPath` 之后点源 `windows-uia-ext.ps1`；若文件缺失则定义 `Add-ResultEnvelope`/`Invoke-ExtAction` 两个空实现，保证只装上游两个文件时行为不变。
2. **`Invoke-Action` 的 `default:` 分支**：转发到 `Invoke-ExtAction`，实现动作扩展。
3. **结果信封**：持久模式与一次性入口在返回前调用 `Add-ResultEnvelope -Result ... -Action ... -InputObject ... -ElapsedMs ...`。
4. **坐标空间**：`Get-PointFromArgs` 支持 `space: screen|window|client`（经 `Resolve-WcuPointSpace` 换算）；`drag` 的路径同样支持；`element_info` 的坐标分支改走 `Get-PointFromArgs`。
5. **homing 模式**：`Home-Point` 增加 `-Mode strict|auto|off`，默认 **strict**（窗口移动过就抛 `window_moved`）；5 个调用点传入 `(Get-Prop $inputObject "homing" "strict")`。
6. **结果回显**：click/move/drag 的结果里回显 `space/requested/screen/windowLocal/clientLocal`。

## 修改 `mcp/server.mjs`（必须重放）

- 新增工具定义（`capabilities` … `stats`，共 20 个）与分发 case。
- 策略层：`APPROVAL_RULES`（破坏性动作要 `approve:true`）、`redLineRefusal`（输入类工具红线）、`TOOL_GROUPS`（`WCU_TOOL_GROUPS` 控制工具面）。
- 观测/证据：`EVIDENCE_ACTIONS` + 前后 `capture_hash` 对比。
- 录制/回放：`traceStart/Stop/Status/Append`、`traceReplay`（元素指纹重定位、`${var}` 参数化、`fromStep/toStep`、outcome drift 检测）。
- 指标：`recordToolStat`/`statsReport`，`callTool` 拆成 `callTool`(统计包装) + `callToolInner`。
- 后端响应语义：**`ok:false` 且带 `error` 才算传输失败**；`ok:false` 无 `error` 是"有意义的结果"（act 未验证、红线拒绝），必须回给调用方。

## 升级流程

1. 下载上游新版本源码到临时目录。
2. `node tools/sync-upstream.mjs <该目录> --write`（先不带 `--write` 看一遍）。
3. 手工处理脚本列出的 `MANUAL` 项（通常是上游改了上下文）。
4. `& <workspace>/wcu-parse-check.ps1` 确认两个 .ps1 仍是 BOM + 可解析（PS 5.1 硬要求）。
5. `node test/run-tests.mjs`（本机缺 PowerShell 7，`backend-lifecycle` 会因硬编码 `pwsh` 失败，属环境问题）。
6. 重启宿主后跑一次 `doctor`，并抽查 `act` / `observe` / `verify_state`。

### 0.3.3 之后的差异（合并入口 + 策略层）

`mcp/server.mjs` 里除「扩展工具」外还有四块必须一起重放：

1. **合并入口（16 个）**：`mergedTools` 数组 + `routeToLegacy` 路由表 + `MERGED_TOOL_NAMES`；`tools/list` 只回合并入口，旧名保留可调用。
2. **参数卫生**：`filterArgsForAction`（按调用方看到的 schema 校验）+ `noteIgnoredArgs`（未转发的参数回报为 `ignoredArgs`）。
3. **策略层**：`APPROVAL_RULES`、`redLineRefusal`、`checkObservationBinding`（观测凭据）、`pointOwnerCheck`（落点归属）、`focusGuard`（键盘焦点）、`settleAfterAction`（自动沉降）。
4. **记录/回放/指标/预算**：`traceStart|Stop|Status|Append`、`traceReplay`、`recordToolStat|statsReport`、`budgetReport|internalsReport`。

`scripts/windows-uia-ext.ps1` 的 D 块（临时窗口 / 树查询 / 落点归属 / 元素动作面 / 拖拽会话 / 应用索引 / 浏览器探测）以及 `observe includeTree`、`drag_end expect` 都只在这一个文件里，升级时整文件保留即可。

**坑位提醒**：PowerShell 里 `return ,@(...)` 会让调用方拿到「装着数组的单元素数组」（曾导致 `list_apps` 报 Int32 错误、`resolve_app` 匹配失效、`transient_windows` 恒为 0）。扩展层新增函数一律返回扁平数组。

### 自检

```powershell
node tools/check.mjs        # 语法 + PS BOM/解析 + 路由审计 + 工具面预算
node test/router-map.mjs    # 16 入口 / 0 孤儿 / 卫生取值
```
