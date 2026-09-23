#!/usr/bin/env node
/**
 * echo 身份回显服务 —— 验证 Higress 认证链路（jwt-auth JWKS / OIDC）
 *
 * 演进说明：
 *   - 最初：纯 JSON 回显（验证 jwt-auth claims_to_headers 注入的 X-User-* 头）。
 *   - 加「退出登录」按钮：按 Accept 头分流，浏览器渲染 HTML 页面（带退出按钮），
 *     其它客户端仍返回 JSON，不破坏既有测试与 API 调用方。
 *   - 加 Cache-Control: no-store：确保浏览器每次访问都经过网关 OIDC 插件拦截/
 *     重定向到 AUTH_HOST（Keycloak）登录，而不是被浏览器缓存的旧 HTML 页面骗过
 *     （否则看不到跳转登录）。
 *
 * 认证链路：
 *   - 浏览器 OIDC：浏览器 → Higress oidc 插件(未认证 → 302 到 Keycloak 登录) → 回调
 *       → oidc 把 ID Token 放 Authorization、Access Token 放 X-Forwarded-Access-Token
 *       → echo-server 解析 token 里的 claim（含 new_emp_no）渲染 HTML 身份页 / JSON
 *   - API/Bearer：客户端带 Keycloak token → jwt-auth 把 claim 注入 X-User-* 头
 *       → echo-server 读 X-User-* 头
 *
 * 运行：node echo-server.mjs（PORT 默认 8080）
 */
import http from 'node:http'

const PORT = Number(process.env.PORT || 8080)

// —— 配置项（域名一律环境变量注入，默认值用脱敏示例域名）——
// 线上部署时由 K8S/网关注入真实域名，仓库内不带任何公司域名。
//   ECHO_HOST：本服务对外域名（用于页面展示 + 退出登录后的回跳地址）
//   AUTH_HOST：Keycloak 域名（用于真正注销 SSO 会话的 end_session_endpoint）
const ECHO_HOST = process.env.ECHO_HOST || 'echo.ai.example.com'
const AUTH_HOST = process.env.AUTH_HOST || 'auth.example.com'
// Keycloak realm 路径（employees 等），默认示例 realm 名
const AUTH_REALM = process.env.AUTH_REALM || 'employees'

// Higress 的 jwt-auth claims_to_headers 把 JWT 的 UTF-8 中文字段原样写进 header，
// 而 Node 的 req.headers 按 latin-1 解码 header 值 → 中文变成乱码（如 “刘彦龙”→“çæäº®”）。
// 这里把 latin-1 再编码回字节、按 utf-8 解码，恢复原始中文字符。（ASCII 值往返不变，安全）
function unMojibake(v) {
  if (v == null) return null
  try {
    const recovered = Buffer.from(String(v), 'latin1').toString('utf8')
    return recovered
  } catch {
    return v
  }
}

// 从 JWT 的 payload 段解析出 claims（仅 base64 解码，不验签——信任已过网关认证的 token）。
// 兼容两条链路传来的 token：
//   - jwt-auth（API/Bearer）：claims_to_headers 已把 claim 注入 X-User-* 头，这里 token 作兜底
//   - oidc（浏览器）：pass_authorization_header=true 把 ID Token 放 Authorization，
//     pass_access_token=true 把 Access Token 放 X-Forwarded-Access-Token
// 员工编号的 Keycloak claim 名为 new_emp_no（对应 LDAP 属性 NewEmpNo，属性名不可改）。
function decodeJwtPayloadTokenHeader(v) {
  if (!v) return null
  const parts = String(v).split('.')
  if (parts.length !== 3) return null
  try {
    let b64 = parts[1]
    b64 = b64.replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const json = Buffer.from(b64, 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

function claimsToIdentity(payload) {
  if (!payload) return {}
  return {
    username: payload.preferred_username ?? null,
    name: payload.name ?? null,
    email: payload.email ?? null,
    phone: payload.phone_number ?? null,
    employeeNo: payload.new_emp_no ?? null,
    givenName: payload.given_name ?? null,
    familyName: payload.family_name ?? null,
  }
}

function collectIdentity(req) {
  // X-User-* 头由 jwt-auth claims_to_headers 注入（API/Bearer 路径）
  const fromHeaders = {
    username: req.headers['x-user-username'] ?? null,
    name: unMojibake(req.headers['x-user-name']),
    email: req.headers['x-user-email'] ?? null,
    phone: req.headers['x-user-phone'] ?? null,
    employeeNo: req.headers['x-user-employee-no'] ?? null,
    givenName: unMojibake(req.headers['x-user-given-name']),
    familyName: unMojibake(req.headers['x-user-family-name']),
  }

  // 优先用 X-User-* 头（网关已把 claim 拆好）；缺的员工编号再尝试从 token 解析
  // oidc 路径不注入 X-User-*，所以这里必须从 token 兜底
  const authHdr = req.headers['authorization'] || ''
  let token = null
  if (authHdr.startsWith('Bearer ')) token = authHdr.slice(7).trim()
  const accessTok = req.headers['x-forwarded-access-token'] || null
  const fromClaims = claimsToIdentity(
    decodeJwtPayloadTokenHeader(token) ||
    decodeJwtPayloadTokenHeader(accessTok)
  )

  return {
    username: fromHeaders.username ?? fromClaims.username ?? null,
    name: fromHeaders.name ?? fromClaims.name ?? null,
    email: fromHeaders.email ?? fromClaims.email ?? null,
    phone: fromHeaders.phone ?? fromClaims.phone ?? null,
    employeeNo: fromHeaders.employeeNo ?? fromClaims.employeeNo ?? null,
    givenName: fromHeaders.givenName ?? fromClaims.givenName ?? null,
    familyName: fromHeaders.familyName ?? fromClaims.familyName ?? null,
  }
}

function renderPage(identity, consumer) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
  // 退出登录：rd 指向 Keycloak end_session_endpoint，真正注销 SSO 会话，
  // 并带 post_logout_redirect_uri 回跳本服务。域名全部来自配置项（见文件头部）。
  const endSessionUrl = `https://${AUTH_HOST}/realms/${AUTH_REALM}/protocol/openid-connect/logout` +
    `?post_logout_redirect_uri=${encodeURIComponent(`https://${ECHO_HOST}/`)}`
  const logoutHref = `/oauth2/sign_out?rd=${encodeURIComponent(endSessionUrl)}`
  const rows = [
    ['用户名 (username)', identity.username],
    ['姓名 (name)', identity.name],
    ['员工编号 (employeeNo)', identity.employeeNo],
    ['邮箱 (email)', identity.email],
    ['手机号 (phone)', identity.phone],
    ['名 (givenName)', identity.givenName],
    ['姓 (familyName)', identity.familyName],
    ['消费者 (x-mse-consumer)', consumer],
  ]
  const tr = rows.map(([k, v]) =>
    `<tr><th>${esc(k)}</th><td>${esc(v) || '<span class="na">—</span>'}</td></tr>`
  ).join('')
  const loggedIn = !!(identity.username || identity.phone || identity.name || identity.email)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>echo 身份回显</title>
<style>
  :root { --brand:#1667c9; --ok:#1a7f37; --danger:#cf222e; --bg:#f6f8fa; --line:#d0d7de; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif; background:var(--bg); margin:0; color:#1f2328; }
  .card { max-width:640px; margin:48px auto; background:#fff; border:1px solid var(--line); border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  .head { background:linear-gradient(135deg,#1667c9,#1f9bd8); color:#fff; padding:20px 24px; }
  .head h1 { margin:0; font-size:20px; }
  .head p { margin:6px 0 0; opacity:.9; font-size:13px; }
  .body { padding:24px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); }
  th { width:46%; color:#57606a; font-weight:500; background:#f6f8fa; }
  td { font-family:ui-monospace,Consolas,monospace; word-break:break-all; }
  .na { color:#9aa0a6; }
  .status { display:inline-block; margin-bottom:16px; padding:4px 10px; border-radius:20px; font-size:13px; font-weight:600; }
  .on { background:#dafbe1; color:var(--ok); }
  .off { background:#ffebe9; color:var(--danger); }
  .actions { display:flex; gap:12px; margin-top:20px; flex-wrap:wrap; }
  .btn { display:inline-block; padding:10px 18px; border-radius:8px; border:1px solid transparent; font-size:14px; font-weight:600; cursor:pointer; text-decoration:none; }
  .btn-logout { background:var(--danger); color:#fff; }
  .btn-logout:hover { background:#b91c29; }
  .btn-home { background:#fff; color:var(--brand); border-color:var(--brand); }
  .hint { margin-top:14px; font-size:12px; color:#57606a; }
  .hint code { background:#eff1f3; padding:1px 5px; border-radius:4px; }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <h1>🔐 echo 身份回显</h1>
      <p>${esc(ECHO_HOST)} · Keycloak(${esc(AUTH_REALM)}) OIDC 认证</p>
    </div>
    <div class="body">
      <span class="status ${loggedIn ? 'on' : 'off'}">${loggedIn ? '已认证' : '未认证'}</span>
      <table>
        ${tr}
      </table>
      <div class="actions">
        <a class="btn btn-logout" href="${logoutHref}">退出登录</a>
        <a class="btn btn-home" href="/">刷新</a>
      </div>
      <p class="hint">
        点击「退出登录」会清除本服务会话 Cookie，并跳转到
        <code>${esc(AUTH_HOST)}</code> 注销 Keycloak SSO 会话，再回到本页，方便反复测试。
      </p>
    </div>
  </div>
</body>
</html>`
}

function renderJson(identity, consumer, req, url, body) {
  const echo = {
    service: 'echo-identity',
    method: req.method,
    path: url.pathname,
    query: url.search,
    identity,
    consumer,
    authorization: req.headers['authorization']
      ? `${req.headers['authorization'].slice(0, 40)}...` : '(无)',
    allHeaders: req.headers,
    body: body ? body.slice(0, 500) : null,
  }
  return JSON.stringify(echo, null, 2)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  // 健康检查
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, service: 'echo-identity' }))
    return
  }

  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const identity = collectIdentity(req)
    const consumer = req.headers['x-mse-consumer'] ?? null
    console.log('[echo]', JSON.stringify({ path: url.pathname, identity, consumer }))

    // 浏览器请求 → 渲染 HTML 页面（带退出登录按钮）
    const accept = (req.headers['accept'] || '').toLowerCase()
    if (accept.includes('text/html')) {
      // 不缓存：保证每次访问都经过网关 OIDC 拦截/重定向到登录，
      // 而不是被浏览器缓存的旧页面骗过（否则看不到跳转 AUTH_HOST）
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      })
      res.end(renderPage(identity, consumer))
      return
    }

    // 其余客户端 → 维持原有 JSON 回显
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(renderJson(identity, consumer, req, url, body))
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`echo 身份回显服务已启动: http://0.0.0.0:${PORT}`)
})
