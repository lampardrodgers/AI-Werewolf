# AI 狼人杀

AI 狼人杀是一个本地运行的狼人杀沙盒。你可以创建 6-12 人局，让真人玩家和 AI 玩家一起完成夜晚行动、警长竞选、发言、投票、放逐和胜负结算，并在暴露模式下复盘 AI 决策过程。

## 环境要求

- Node.js 20 或更高版本
- npm

## 安装

```bash
npm install
```

## 启动

```bash
npm run dev
```

启动后打开：

- 游戏页面：http://127.0.0.1:12000
- 后端服务：http://127.0.0.1:12001

如果只想检查项目是否能构建：

```bash
npm run build
```

运行测试：

```bash
npm test
```

## 使用方式

1. 打开 http://127.0.0.1:12000。
2. 在开局页面选择总人数、真人人数、AI 人数和随机种子。
3. 点击开始游戏。
4. 按当前阶段提示操作：夜晚行动、警长竞选、白天发言、投票和放逐。
5. 需要调试或复盘时，可以开启暴露模式查看身份、AI 后台理由、prompt 和调用记录。

## 配置真实 AI

项目默认可以使用 mock 流程跑通游戏。要接入真实模型：

1. 进入后台管理控制台。
2. 在 AI 配置里选择或新增供应商。
3. 填写 Base URL、模型名和本机 API Key。
4. 点击连接测试，确认模型列表或接口可用。
5. 回到游戏页面，让 AI 座位自动请求模型决策。

API Key 不会写入 Git。默认配置文件保存在 `data/ai-config.json`，该文件已被 `.gitignore` 排除。

常用环境变量：

- `PORT`：后端端口，默认 `12001`
- `HOST`：后端监听地址，默认 `127.0.0.1`
- `LANGRENSHA_DATA_DIR`：配置文件保存目录，默认项目根目录下的 `data`
- `LANGRENSHA_ALLOWED_ORIGINS`：允许访问后端的前端来源
- `LANGRENSHA_BODY_LIMIT_BYTES`：后端请求体大小限制

## 项目功能

- 6-12 人标准渐进预女猎守规则包
- 真人、AI、mock 座位混合开局
- 自动身份分配和确定性随机种子
- 夜晚守卫、狼人、预言家、女巫行动
- 警长竞选、白天发言、投票、放逐和胜负结算
- AI 供应商、模型、推理强度、上下文压缩和成本控制配置
- AI 决策状态跟踪，包括构建 prompt、等待模型、修复输出、完成或失败
- 普通玩家视角隐藏身份和后台信息
- 暴露模式用于测试、日志审计和整局复盘
- Markdown 游戏记录导出

## 项目结构

```txt
apps/web              React/Vite 前端
apps/server           Fastify API 服务
packages/engine       狼人杀规则引擎
packages/llm-gateway  多供应商 LLM 适配层
packages/prompts      AI 提示词
packages/shared       共享类型和规则配置
data                  本地 AI 配置目录
```
