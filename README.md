# cache-lab

把 HTTP 响应里的缓存头贴进来，在浏览器里本地推演：这份副本现在新不新鲜、还要多久过期、浏览器和 CDN 的结论会不会不一样。**纯前端，不上传。**

在线试用：<https://temptation2017.github.io/cache-lab/>

## 做什么

- 解析 `Cache-Control`、`Age`、`Date`、`Expires`、`Last-Modified`、`ETag`、`Pragma`、`Vary`、`Set-Cookie`
- 按 [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html) 估算当前年龄（apparent age、Age 头、在缓存里又驻留了多久）和新鲜期
- 新鲜期来源按优先级：共享缓存上的 `s-maxage` → `max-age` → `Expires` → 启发式 `(Date − Last-Modified) × 10%`（封顶 24 小时）
- 区分**私有缓存（浏览器）**和**共享缓存（CDN / 代理）**：`private`、带 `Authorization` 的请求、`s-maxage` 与 `max-age` 不同等
- 识别 `no-store`、`no-cache`（用之前必须再验证，并不是“不要缓存”）、`must-revalidate`、`immutable`
- 过期后的 `stale-while-revalidate` / `stale-if-error`，以及请求侧的 `max-age`、`min-fresh`、`max-stale`
- 画出一条时间轴：新鲜期、SWR 窗口、「现在」落在哪里
- 给出再验证时会带上的 `If-None-Match` / `If-Modified-Since`
- 标出常见踩坑：`public` 却带 `Set-Cookie`、同时写了 `max-age` 和 `Expires`、`Pragma` 与 `Cache-Control` 并存、`Vary: *`
- 一键复制 Markdown 摘要

全部在本机计算，不会把粘贴内容发到任何服务器，也不向源站发真实请求。

## 怎么打开

- 打开 GitHub Pages：<https://temptation2017.github.io/cache-lab/>
- 或本地下载后双击 `index.html`，或：

```bash
python3 -m http.server 8080
# 浏览器访问 http://127.0.0.1:8080/
```

无需构建、无需 npm。

可选校验（零依赖，只需 Node.js）：

```bash
node test_cache.js
```

## 怎么用

1. 选择缓存类型（浏览器或 CDN）和请求方法。
2. 在「响应头」里粘贴从开发者工具复制的响应头，可带 `HTTP/1.1 200 OK` 这样的状态行。
3. 需要时再贴请求头（例如带 `Authorization`，或请求侧的 `Cache-Control: max-age=0`）。
4. 观测时刻默认是「刚刚收到」。用「+1 分钟 / +10 分钟 / +1 小时」看稍后会不会过期。
5. 用示例按钮对比常见场景：CDN 仍新鲜、已过期但可 SWR、登录页 `no-store`、`no-cache` 必须再验证、仅浏览器可缓存、带令牌的请求、启发式过期、`public` 却带 Cookie。
6. 要把结论带走，点「复制 Markdown 摘要」。

从浏览器开发者工具复制：Network → 选中请求 → Headers → Response Headers。

## 示例

下列域名、令牌和 Cookie 都是虚构样本。规则与 RFC 9111 在常见实现中的理解一致，不保证和某一种浏览器或某家 CDN 的私有策略逐条相同。

| 场景 | 结论要点 |
| --- | --- |
| `public, max-age=300, s-maxage=600`，Age 已 20 秒 | CDN 新鲜期按 600 秒算，浏览器按 300 秒算 |
| `max-age=60, stale-while-revalidate=300`，已过期 30 秒 | 可以先交出旧副本，同时后台再验证 |
| `Cache-Control: no-store` 且带 `Set-Cookie` | 不得写入缓存 |
| `Cache-Control: no-cache` 且有 ETag | 可以存储，但每次使用前必须再验证 |
| `private, max-age=3600` 拿到共享缓存上判断 | CDN / 代理不得存储；换到浏览器则在新鲜期内可复用 |
| 请求带 `Authorization`，响应只有 `max-age=60` | 共享缓存默认不得存储；若加上 `public` 或 `s-maxage` 才可能存储 |
| 只有 `Date` 和 `Last-Modified`，没有 Cache-Control | 用启发式新鲜期，并在界面上标明这不是源站显式过期时间 |
| `public, max-age=600` 同时带 `Set-Cookie` | 按规范也许能被共享缓存存储，但会给出风险提示 |

## 限制与后续可改进点

- 没有请求/响应的精确收发时间戳时，用「收到时刻」和 `Date` / `Age` 估算年龄，不模拟传输延迟。
- 不实现具体浏览器（Chrome / Safari / Firefox）或 CDN 的私有启发式、默认缓存键、以及它们对 `Set-Cookie` 的额外拒绝规则。
- 不处理缓存键、内容协商变体匹配的完整算法（只对 `Vary: *` 给出提示）。
- 不解析 `Cache-Control` 扩展指令的语义，未知指令会列出来但不参与判定。
- `206` 部分内容、启发式与校验的更多边角、以及把一次 304 刷新后的新鲜期再算一遍，都可以作为后续增强。

## 许可

MIT。详见 [LICENSE](LICENSE)。
