# PipeRun

可视化 Shell 流水线运行器。在浏览器里编排、执行、查看多阶段 Shell 脚本。

## 功能

- **可视化编辑器** — 拖拽排序阶段与步骤，Shell 语法高亮
- **终端输出** — 实时 WebSocket 推送，ANSI 颜色完整渲染，跨帧标记正确拼接
- **步骤状态追踪** — 每步显示运行中 / 成功 / 失败及耗时
- **历史日志回放** — 重启或刷新后自动还原每步的成功 / 失败状态与耗时
- **沙箱试运行** — 在隔离目录中试跑单条命令，不影响宿主环境
- **环境变量注入** — Pipeline 级别 env var，脚本执行前自动 `export`
- **步骤选项**
  - 失败后继续（`continueOnError`）
  - 超时限制（`timeout`，秒，空或 0 = 不限制）
  - 失败重试（`retries`，最多 10 次）
- **运行历史** — 持久化运行记录与终端日志，重启后可回放
- **YAML 导入 / 导出** — 一键备份或迁移流水线配置
- **访问控制** — Origin 白名单 + 可选 API Token 鉴权

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vite 5 + React 18 + TypeScript |
| 样式 | TailwindCSS 3 + DaisyUI 4 |
| 终端 | @xterm/xterm 5 |
| 编辑器 | CodeMirror 6 (Shell 语法) |
| 后端 | Node.js HTTP + ws (WebSocket) |
| 存储 | 本地 JSON 文件 + 日志文件 |

## 快速开始

```bash
# 安装依赖
pnpm install

# （可选）配置环境变量
cp .env.example .env
# 按需编辑 .env，本地开发通常无需改动

# 开发模式（前端 :5173，后端 :3001，自动加载 .env）
pnpm dev
```

访问 http://localhost:5173

## 环境变量（服务端）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3001` | 监听端口 |
| `ALLOWED_ORIGINS` | `http://localhost:5173,...` | 允许的 WebSocket / CORS Origin，逗号分隔 |
| `API_TOKEN` | 未设置 | 设置后，非 localhost 的 API 请求必须携带 `Authorization: Bearer <token>`；WebSocket 连接需附 `?token=<token>` |

> 本地开发时无需配置任何环境变量，localhost 请求始终放行。

## 目录结构

```
piperun/
├── server/
│   ├── server.js          # Node.js HTTP + WebSocket 服务
│   └── data/
│       ├── pipelines.json # 流水线配置
│       ├── runs.json      # 运行记录
│       └── runs/          # 终端日志文件（*.log）
├── src/
│   ├── pages/
│   │   ├── PipelinesPage.tsx  # 首页：流水线列表
│   │   ├── EditorPage.tsx     # 编辑器
│   │   └── RunPage.tsx        # 执行页
│   └── components/
│       ├── XTerm.tsx          # 终端组件
│       ├── StageFlow.tsx      # 阶段/步骤面板
│       └── SandboxModal.tsx   # 沙箱试运行弹窗
└── vite.config.ts
```

## YAML 格式

```yaml
name: 示例流水线
description: 可选描述
env:
  - key: NODE_ENV
    value: production
stages:
  - name: 构建
    steps:
      - name: 安装依赖
        command: pnpm install
      - name: 构建产物
        command: pnpm run build
        timeout: 300      # 超时秒数，可选，省略或 0 = 不限制
        retries: 2        # 失败重试次数，可选，省略或 0 = 不重试
        continueOnError: false
  - name: 部署
    steps:
      - name: 上传
        command: rsync -av dist/ user@server:/var/www/
```

## 注意事项

- `server/data/` 已加入 `.gitignore`，不会提交运行数据
- 后端监听 3001 端口，生产部署时建议配置反向代理并设置 `API_TOKEN`
- 同一时刻只支持一条流水线并发执行
- 单条流水线最长运行时间 30 分钟，沙箱 60 秒
- 终端输出缓冲区上限 10 MB（超出时保留最近 5 MB）
