# Image2 Generation App

一个面向 `gpt-image-2` / OpenAI 兼容图片接口的本地 Web 应用，支持生图、参考图改图、历史记录、图片预览和再次编辑。

## 功能特点

1. 友好的交互形式
   - 支持点击、拖动上传参考图
   - 支持拖动交换参考图位置
   - 支持图片预览、下载、复制、导入
   - 支持从历史结果再次编辑

2. 丰富的参数预设
   - 支持预设尺寸
   - 支持宽高比 + 分辨率模式
   - 支持质量、格式、背景、数量选择
   - 数量范围为 1-4 张

3. 多并发工作流
   - 支持多个工作区
   - 多个请求可以并行进行
   - 每个请求有独立状态、结果和历史记录
   - 实际并发能力取决于上游 API 的限流策略

<img width="1919" height="873" alt="image" src="https://github.com/user-attachments/assets/716b52da-2861-4584-80dd-2557a5fdd70b" />


## 环境要求

建议使用：

- Node.js 20.19+ 或 22.12+
- npm

## 安装

```bash
npm install
```

## 开发运行

```bash
npm run dev
```

默认地址：

- 前端：`http://localhost:5173`
- 后端 API：`http://localhost:8787`

开发模式下，Vite 会把 `/api` 请求代理到后端服务。

## 使用方法

1. 打开页面右上角的 `API 设置`
2. 填写 `Base URL`
   - 示例：`https://your-image-api.example.com/v1`
   - 需要是 OpenAI 兼容 API 地址
3. 填写 `API Key`
4. 点击 `检测连接`
5. 检测通过后点击 `保存`
6. 输入 Prompt 后点击生成图片
7. 如果上传了参考图，会自动进入改图流程；没有参考图则走生图流程

API 设置会保存在本地 `.data/api-config.json` 中。这个文件包含 API Key，不要提交或分享。

## 图片输入

参考图区域支持：

- 点击选择图片
- 拖入图片
- 拖动图片交换位置
- 鼠标悬停在坑位后使用 `Ctrl/Cmd + V` 粘贴图片

最多支持 5 张参考图。上传参考图后会走图片编辑接口；不上传参考图时走图片生成接口。

Mask 是可选项，并且作用于第 1 张参考图。

## 参数说明

支持两种尺寸控制方式：

- 直接尺寸：选择预设尺寸
- 比例 + 分辨率：选择宽高比和 `1K` / `2K` / `4K`

可选参数包括：

- 质量：`low` / `medium` / `high` / `auto`
- 格式：`png` / `jpeg`
- 背景：`auto` / `opaque` / `transparent`
- 数量：`1` 到 `4`

注意：

- `gpt-image-2` 不支持透明背景
- `jpeg` 格式不支持透明背景
- 宽高比和分辨率会被转换成实际发送给 API 的 `size`

## 环境变量

也可以通过环境变量提供 API 配置，作为本地测试或私有部署的 fallback：

```bash
IMAGE_API_BASE_URL=https://your-image-api.example.com/v1
IMAGE_API_KEY=sk-your-key-here
IMAGE_API_TIMEOUT_MS=1800000
PORT=8787
```

支持的别名：

```bash
LLM_API_BASE_URL / LLM_API_KEY
OPENAI_BASE_URL / OPENAI_API_BASE_URL / OPENAI_API_KEY
DEER_API_BASE_URL / DEER_API_KEY / DEER_API_TIMEOUT_MS
```

优先推荐在页面右上角 `API 设置` 中配置。

## 可用脚本

```bash
npm run dev
```

同时启动前端和后端。

```bash
npm run build
```

构建前端产物。

```bash
npm run preview
```

预览前端构建产物。注意：这不会单独启动 Express API 服务，因此不等同于完整应用运行。

测试脚本：

```bash
npm run test:generate
npm run test:params
npm run test:persistent-history
npm run test:payload-routing
npm run test:rate-limit
```

## 安全说明

不要提交或分享以下文件和目录：

```text
.data/
.env.local
node_modules/
dist/
```

其中：

- `.data/api-config.json` 会保存 API Key
- `.data/history.json` 和 `.data/history-assets/` 会保存生成历史和图片资产
- `.env.local` 可能包含本地私有配置
- `node_modules/` 和 `dist/` 是本地依赖和构建产物，不需要分享

项目的 `.gitignore` 已默认忽略这些本地文件，因此通过 Git 推送代码时它们不会被提交。

如果你是手动压缩整个项目文件夹分享，`.gitignore` 不会自动生效，请手动排除以上文件和目录。
