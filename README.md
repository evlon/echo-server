# echo-server · 身份回显服务

验证 **Higress 统一认证链路**（Keycloak OIDC / jwt-auth JWKS）的最小示例服务。

访问它时，它会回显网关注入的身份信息（用户名、姓名、员工编号、邮箱、手机号等），
用于直观确认「身份是否被正确透传、是否有衰减」。

## 它是干嘛的

```
浏览器/客户端
   │  (带或不带 Keycloak token)
   ▼
Higress 网关
   ├─ oidc 插件：未登录 → 302 到 Keycloak 登录；已登录 → 注入 ID Token / Access Token
   └─ jwt-auth 插件：校验 JWT → claims_to_headers 把 claim 注入 X-User-* 头
   ▼
echo-server（本服务）
   └─ 读 X-User-* 头 / 解析 JWT payload，渲染身份页(HTML) 或 回显(JSON)
```

- **浏览器访问** → 渲染 HTML 身份页（含「退出登录」按钮，真正注销 Keycloak SSO）。
- **API / curl 访问** → 返回 JSON 回显（含所有注入头、截断的 Authorization）。

## 认证链路（两条）

| 链路 | 触发 | 身份来源 |
|---|---|---|
| **浏览器 OIDC** | 浏览器带 `Accept: text/html` | oidc 插件注入 `Authorization`(ID Token) + `X-Forwarded-Access-Token`，服务端解析 JWT claim |
| **API / Bearer** | 客户端带 Keycloak token | jwt-auth 插件把 claim 注入 `X-User-*` 头，服务端读头 |

> 员工编号的 Keycloak claim 名为 `new_emp_no`（对应 LDAP 属性 `NewEmpNo`，属性名不可改）。

## 本地运行

```bash
node echo-server.mjs            # 默认端口 8080
PORT=9090 node echo-server.mjs  # 自定义端口
```

无需依赖，纯 `node:http` 零 npm 包。

## 配置项（环境变量）

源码**不含任何公司域名**——域名一律通过环境变量注入，仓库内默认值是脱敏示例域名：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `ECHO_HOST` | `echo.ai.example.com` | 本服务对外域名（页面展示 + 退出登录后回跳地址） |
| `AUTH_HOST` | `auth.example.com` | Keycloak 域名（真正注销 SSO 的 `end_session_endpoint`） |
| `AUTH_REALM` | `employees` | Keycloak realm 名 |
| `PORT` | `8080` | 监听端口 |

部署到真实环境时，由 K8S Deployment / 网关注入真实域名即可：

```bash
ECHO_HOST=echo.ai.ict.cmcc AUTH_HOST=auth.ict.cmcc AUTH_REALM=employees node echo-server.mjs
```

## 身份字段说明

| 字段 | 来源 |
|---|---|
| `username` | `preferred_username` claim / `X-User-Username` 头 |
| `name` | `name` claim / `X-User-Name` 头 |
| `employeeNo` | `new_emp_no` claim / `X-User-Employee-No` 头 |
| `email` | `email` claim / `X-User-Email` 头 |
| `phone` | `phone_number` claim / `X-User-Phone` 头 |
| `givenName` / `familyName` | `given_name` / `family_name` claim |

## 两个关键实现细节

1. **中文乱码修复**：Higress 的 `claims_to_headers` 把 JWT 的 UTF-8 中文字段原样写进 header，
   Node 按 latin-1 解码 → 中文乱码（如「刘彦龙」→「çæäº®」）。
   代码里 `unMojibake()` 把 latin-1 编码回字节、按 UTF-8 解码，恢复中文（ASCII 往返不变，安全）。

2. **退出登录真注销**：`/oauth2/sign_out` 只清本地 cookie，不清 Keycloak SSO 会话。
   本服务把退出链接指向 `end_session_endpoint` 并带 `post_logout_redirect_uri`，
   才能真正登出 Keycloak SSO 再回跳本页。

## 部署清单（在别的仓库）

部署相关的 ConfigMap / Ingress / jwt-auth 插件配置属于**部署层**，
不在本源码仓库内，见公司的 `k8s` 部署仓库。

## 相关文档

- 认证接入文档树：`docs/认证接入/`（总览 / 运维配置手册 / 开发接入指南 / 经验与坑）
- 身份透传第二跳示例：`app-echo-oidc-demo` 仓库（echo-a → echo-b 身份不衰减）
