# ============================================================================
# echo-server 镜像 —— 身份回显服务（配置化版）
#
# 与 app-echo-oidc-demo 里那份「范例版」的区别：
#   - 域名走环境变量（ECHO_HOST / AUTH_HOST / AUTH_REALM），仓库内默认脱敏；
#   - 无教学标注注释，是「真实部署 / 开源」用的干净形态。
#
# 纯 Node ESM、零依赖（无 node_modules、无第三方包）。
# 集群节点是 aarch64，须在节点原生构建（本机 x86_64 不能直接 build arm64 镜像），
# 基础镜像 node:22-slim 已预先入 Harbor。
#
# 域名注入：由 Deployment 的 env 传入真实域名（见 deploy/ 或部署仓库），
# 不写进镜像 —— 保证镜像不含公司域名，可安全复用。
# ============================================================================
FROM dockerhub.kubekey.local:31104/library/node:22-slim

ENV TZ=Asia/Shanghai
ENV NODE_ENV=production

WORKDIR /app

COPY echo-server.mjs /app/echo-server.mjs

EXPOSE 8080

CMD ["node", "echo-server.mjs"]
