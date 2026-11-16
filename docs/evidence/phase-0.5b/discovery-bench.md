# Codex 发现性能（B08 S2）

- 日期：2026-11-16
- 目的：验证 spec §7.1 的「1000 个 rollout 首扫 ≤1.5s，重复扫描走索引」要求。
- 实现：`src/discover/codex.ts` 增加目录 mtime 缓存（`DIR_CACHE`）与文件 mtime+size 缓存（`META_CACHE`）；`clearCodexDiscoveryCache()` 供测试重置。

## 方法

临时目录生成 1000 个 `YYYY/MM/DD/rollout-*.jsonl`，每个首行 `session_meta` 含 id/session_id/timestamp/cwd/thread_source=user；
用 `discoverCodexSessions({ sessionsRoot, cwd, sinceDays: 3650 })` 连续调用两次，取 `performance.now()` 差值。

## 结果

```json
{"count":1000,"firstMs":116,"cachedMs":16}
```

- 首扫 116ms、缓存扫描 16ms，均远低于 1.5s 门槛。
- 复现命令见 `review-fixes-2026-11-16.md` §S2。
