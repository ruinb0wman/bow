# opencode 会话头(`x-opencode-session`)由前端应用自行发送

本浏览器曾对 `opencode.ai` 的请求代注入 `x-opencode-session`(每标签页稳定 UUID)并覆盖 UA。
该行为已移除:**会话标识属于应用层职责**,浏览器只保留 CORS 白名单放行与全局 `bow` UA 签名。

OpenCode Go/Zen 的官方要求(官方文档 “Where can I use it”):

1. 发送符合编码 agent 特征的流量;
2. 用自有 User-Agent 标识自身(如 `my-coding-agent/1.0`),不要用通用 SDK / HTTP 库名;
3. **在 `x-opencode-session` 中发送每次对话稳定不变的会话 ID**,用于路由优化与 prompt 缓存。

参考:<https://opencode.ai/docs/go/#where-can-i-use-it>
缺失该头时上游返回:`400 {"type":"MissingSessionID","message":"... missing x-opencode-session ..."}`。

> 浏览器内运行的网页应用无法设置 `User-Agent`(fetch 的 forbidden header),该头由浏览器全局使用
> `bow` 签名;网页应用只需自行负责 `x-opencode-session`。

## 给前端应用的提示词(可直接复制)

---

**任务:让本应用自行发送 opencode 所需的 `x-opencode-session` 请求头**

背景:OpenCode Go/Zen 要求客户端在每次对话中发送稳定会话 ID(官方文档 “Where can I use it”):

1. 发送符合编码 agent 特征的流量;
2. 用自有 User-Agent 标识自身(如 `my-coding-agent/1.0`),不要用通用 SDK / HTTP 库名;
3. **在 `x-opencode-session` 中发送每次对话稳定不变的会话 ID**,用于路由优化与 prompt 缓存。

参考:<https://opencode.ai/docs/go/#where-can-i-use-it>
缺失该头时上游返回:`400 {"type":"MissingSessionID","message":"... missing x-opencode-session ..."}`。

实现要求:

1. 为每个「对话(conversation/session)」生成一个 UUID v4,作为该对话的 `x-opencode-session` 值。
2. 该值在同一对话内必须稳定:同一对话的多次请求、页面刷新后重建,都要复用同一个值。请把
   `conversationId → sessionId` 映射持久化(如 localStorage);若应用没有对话概念,则退化为每个
   页面会话(sessionStorage)一个稳定 UUID。
3. 统一在应用的 HTTP 客户端 / fetch 封装层注入该请求头,不要在调用点逐个手写;仅对目标主机为
   `opencode.ai` 或 `*.opencode.ai`(含 `/zen`、`/go` 路径)的请求注入。
4. 不要尝试设置 `User-Agent`:浏览器禁止 JS 设置该头,且运行环境已全局使用 `bow` 签名标识。
5. 自定义请求头会触发 CORS 预检(OPTIONS)。请确认发起页面来源已在运行环境的「CORS 放行」白名单内
   (默认含 `localhost` / `127.0.0.1`),否则请求会被拦截。
6. 补单元测试:同一 conversationId 多次取值一致;不同 conversationId 取值不同;请求头只附加到
   opencode.ai 主机、不附加到其他主机。

验收:

- DevTools → Network:发往 `opencode.ai`(`/zen`、`/go`)的请求带 `x-opencode-session: <uuid>`,
  同一对话内值不变;
- 不再出现 `400 MissingSessionID`。

---

## 参考实现(与具体框架无关)

```ts
/** 每个对话一个稳定 UUID;无对话概念时退化为每个页面会话一个 UUID */
function sessionIdFor(conversationId: string | null): string {
  const key = conversationId ? `opencode-session:${conversationId}` : 'opencode-session:page'
  const store = conversationId ? localStorage : sessionStorage
  let id = store.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    store.setItem(key, id)
  }
  return id
}

/** 仅对 opencode 托管主机附加会话头 */
function withOpencodeSession(url: string, conversationId: string | null, init: RequestInit = {}): RequestInit {
  let host = ''
  try {
    const u = new URL(url, location.href)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return init
    host = u.hostname.toLowerCase()
  } catch {
    return init
  }
  if (host !== 'opencode.ai' && !host.endsWith('.opencode.ai')) return init
  return {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-opencode-session': sessionIdFor(conversationId) }
  }
}

// 用法:把应用内所有对 opencode 的 fetch 统一走封装层
// fetch(url, withOpencodeSession(url, currentConversationId, init))
```
