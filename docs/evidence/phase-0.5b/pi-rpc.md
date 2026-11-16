# Pi 会话发现 + RpcClient 驱动证据（T6 / B04）

- 日期：2026-11-16
- 分支：feat/phase-0.5b-codex-pi
- 基线：0434e94（T1+T2 已完成）
- 范围：Pi 会话发现、RpcClient 子进程驱动、lease 双写拦截、D6 provider 预检
- 非范围：src/transcript/pi.ts（T7）、/agents 注册（T8）

## 1. D6 provider 预检（必须先做）

### 1.1 版本

    $ pi --version
    1.5.2

### 1.2 最小 prompt

第一次按任务原文从仓库目录执行：

    $ pi --print "say OK"
    OK
    [pi-workbench] 控制面未运行，已尝试自动启动：node E:\pi-workbench\packages\control-plane\dist\cli.js start（pid ...）

stdout 已返回 OK（模型调用成功，无 402），但进程在 60s 内没有退出；原因是本机 pi 全局配置
（~/.pi/agent/settings.json 的 packages）加载了 E:\pi-workbench\packages\extension，其 daemon
自动拉起钩子在 print 模式下仍保持进程存活。这是扩展行为，不是 provider 失败。

干净复跑（避开工作区扩展，关闭会话落盘）：

    $ cd %TEMP%
    $ pi --no-extensions --no-session --print "say OK"
    OK
    exit code = 0
    stderr = ""
    elapsed = 1731ms

**结论：Pi provider 可用，无 402 / 鉴权失败，无需降级。** 默认 caps 保留
stream/inject/interrupt/resume/transcript = true、attach = false；同时仍实现并测试了 provider 402
的降级路径（见 §4）。

## 2. RpcClient 实际导出路径

本机包：C:\Users\huang\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent，
版本 1.5.2。

package.json 的 exports：

    {
      ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
      "./rpc-entry": { "import": "./dist/bundle/rpc-entry.js" }
    }

dist/index.d.ts:36 确认导出：

    export { ..., RpcClient, type RpcClientOptions, type RpcCommand, ... } from "./modes/index.ts";

RpcClientOptions：cliPath? / cwd? / env? / provider? / model? / args?。
RpcClient.start() 的实现为：

    spawn("node", [cliPath, "--mode", "rpc", ...args], { cwd, env, stdio: ["pipe","pipe","pipe"] })

因此 cliPath 必须传包内绝对路径；本实现默认解析到 <pkg>/dist/cli.js
（resolveDefaultPiCliPath()），并按需从 <pkg>/dist/index.js 动态 import RpcClient。
测试通过 createRpcClient 注入 fixtures 里的假 RPC 进程，不依赖本机全局安装路径。

## 3. 会话发现

规格 §7.2：不推断目录 mangle，只读首行 type=session 的 version/id/timestamp/cwd。
本机实测（均为 version 3）：

    C:\Users\huang\.pi\agent\sessions\--E--pi-workbench--\2026-11-15T16-24-08-473Z_01a1e005-f219-7337-baa4-9470afbc39b3.jsonl
    {"type":"session","version":3,"id":"01a1e005-f219-7337-baa4-9470afbc39b3","timestamp":"2026-11-15T16:24:08.473Z","cwd":"E:\\pi-workbench"}

    C:\Users\huang\.pi\agent\sessions\--E--pi-workbench-spike-workspace--\2026-11-14T13-34-01-468Z_01a1da43-d6fc-747b-ac99-9b17580934af.jsonl
    {"type":"session","version":3,"id":"01a1da43-d6fc-747b-ac99-9b17580934af","timestamp":"2026-11-14T13:34:01.468Z","cwd":"E:\\pi-workbench\\spike\\workspace"}

实现：src/discover/pi.ts

- 递归扫描 sessionsRoot 下的 *.jsonl，只读首行（64 KiB 上限）；
- version !== 3 → unsupported 计数并跳过；
- 坏 JSON / 非 session / 缺 id 或 cwd → skipped 计数并跳过；
- cwd 过滤用首行 cwd（Windows 大小写不敏感、忽略尾分隔符），不读目录名；
- key = pi:<id>，transcriptPath 为命中文件绝对路径，caps = capsOf("pi")；
- 结果按首行 timestamp 倒序，limit 截断。

测试 fixture：test/fixtures/pi/session-sample.jsonl；用例见 test/pi-discovery.test.ts。

## 4. 驱动与 lease 双写拦截

实现：src/agents/pi-driver.ts

| 契约方法 | Pi RPC 行为 |
|---|---|
| attach | 新 RpcClient + --session <abs file>，启动后 get_state 握手 |
| resume | 已有客户端 → switch_session <path>；否则重新 attach |
| inject | prompt(message)；返回 disposition=queued 时 effective=next_turn |
| interrupt | abort()，归一化 { stopReason: "aborted" } |
| handoff | ["pi","--session",<abs file>]，mode=resume-tui |

所有 RPC 调用经 withTimeout（默认 30s）；超时/失败统一 E_ADAPTER_DOWN 并 client.stop()
（内部 SIGTERM→SIGKILL 兜底）。事件流归一化：message_update / tool_execution_start/end /
agent_start/agent_settled → AdapterUpdate；未知事件返回 null 只跳过，不抛。

### lease 硬约束

inject / interrupt / resume / handoff 在触碰 RPC 客户端之前调用：

    this.#lease.acquire(ref.key, "pi", this.#clientId, this.#leaseTtlMs);
    this.#lease.assertWriter(ref.key, this.#clientId);

- 第二写者（不同 clientId）acquire → E_LEASE_CONFLICT；
- 该失败发生在 #ensureClient 之前，因此不会拉起第二个 RPC 子进程；
- 测试 test/pi-driver.test.ts 用真实 LeaseManager（:memory: SQLite）+ 两个 PiDriver 验证：
  首写者 prompt 计数 1、created clients 1；第二写者 inject/interrupt 均为 E_LEASE_CONFLICT，
  clients 仍为 1、prompt 仍为 1。

### provider 402 降级

- 构造参数 providerStatus.available=false → caps 变为
  { stream:false, inject:false, interrupt:false, attach:false, resume:false, transcript:true,
  permissions:false, background:false }；
- 运行时 RPC 错误文本命中 402 / Payment Required / 余额不足 → 同样降级，首次抛
  E_ADAPTER_DOWN，之后 inject/interrupt 在拉起进程前抛 E_CAP_UNSUPPORTED；
- 测试 PiDriver provider 402... 覆盖：prompt 只发 1 次、clients 只建 1 个。

## 5. 验证命令与结果

    cd packages/control-plane
    node --test --experimental-strip-types test/*.test.ts
    # tests 301 / pass 300 / fail 0 / skipped 1

    cd packages/extension
    node --test --experimental-strip-types test/*.test.ts
    # tests 49 / pass 49 / fail 0

    pnpm -r build
    # packages/shared build: Done
    # packages/control-plane build: Done
    # packages/extension build: Done

T6 新增用例：test/pi-discovery.test.ts（4）+ test/pi-driver.test.ts（9）= 13 条全绿。

## 6. 真实 RpcClient 冒烟（手工，非自动测试）

用本机真实包跑了一次 attach（不 prompt，避免测试消耗）：

    discovered 15 pi:01a1e2fd-dd4f-730b-adfc-dbf62bbd3e3e
    attach-ok {"stream":true,"inject":true,"interrupt":true,"attach":false,"resume":true,"transcript":true,"permissions":false,"background":false}

说明：动态 import 的 RpcClient、包内 dist/cli.js 绝对路径、--session 启动与 get_state 握手
在本机可用；stderr 仍出现扩展的 daemon 自动拉起日志（与 D6 同一原因），不影响 RPC 握手。

## 7. 已知边界 / 交接

- 本任务不实现 src/transcript/pi.ts（T7）；PiDriver 不声明 see，路由层应回落到文件 transcript。
- T8 注册 PiDriver 时必须传入与接管层一致的 clientId 和同一个 LeaseManager，否则会按设计得到
  E_LEASE_CONFLICT。
- 本机 pi 全局配置加载了 E:\pi-workbench\packages\extension；真实 RPC --mode rpc 冒烟时应加
  --no-extensions（或接受 daemon 自动拉起），避免 print/rpc 进程被扩展保活。
- 真实 RpcClient 的进程级冒烟未纳入自动测试（自动测试用 fixtures 假 RPC 进程）；§6 已记录手工冒烟结果。

