# PipeRun

可视化 Shell 流水线运行器。在浏览器里编排、执行、查看多阶段 Shell 脚本。

## 功能

- **可视化编辑器** — 拖拽排序阶段与步骤，Shell 语法高亮
- **终端输出** — 实时 WebSocket 推送，ANSI 颜色完整渲染
- **步骤状态追踪** — 每步显示运行中 / 成功 / 失败及耗时
- **沙箱试运行** — 在隔离目录中试跑单条命令，不影响宿主环境
- **环境变量注入** — Pipeline 级别 env var，脚本执行前自动 `export`
- **步骤选项**
  - 失败后继续（`continueOnError`）
  - 超时限制（`timeout`，秒）
  - 失败重试（`retries`，最多 10 次）
- **运行历史** — 持久化运行记录与终端日志，重启后可回放
- **YAML 导入 / 导出** — 一键备份或迁移流水线配置
- **WebSocket 安全** — Origin 校验，拒绝跨域连接

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

# 开发模式（前端 :5173，后端 :3001）
pnpm dev          # 启动 Vite 前端
node server/server.js  # 另一个终端启动后端
```

访问 http://localhost:5173

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
        timeout: 300      # 超时秒数，可选
        retries: 2        # 失败重试次数，可选
        continueOnError: false
  - name: 部署
    steps:
      - name: 上传
        command: rsync -av dist/ user@server:/var/www/
```

## 注意事项

- `server/data/` 已加入 `.gitignore`，不会提交运行数据
- 后端监听 3001 端口，生产部署时建议配置反向代理
- 同一时刻只支持一条流水线并发执行
- 单条流水线最长运行时间 30 分钟，沙箱 60 秒
