<!--
Copyright (c) 2026 Yao

This file is part of AiWorkHarness, AI coding agent chat inside VS Code.
https://github.com/westhack/ai-work-harness

Licensed under the MIT License. See LICENSE file in the project root.
-->

# AiWorkHarness

[English](README.md) · **简体中文**

**面向 VS Code 的开源 AI 编程智能体。带上你自己的模型，在你的工作区里工作，并始终掌控每一项改动。**

<p align="center">
  <img src="media/readme/hero.png" alt="AiWorkHarness 界面预览：示例编程对话、高亮代码、排队中的跟进消息，以及保留或撤销改动的操作按钮。" width="1440" />
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=westhack.ai-work-harness">安装到 VS Code</a> ·
  <a href="https://github.com/westhack/ai-work-harness/releases">版本发布</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#开发">从源码构建</a> ·
  <a href="#致谢">致谢</a>
</p>

AiWorkHarness 把对话、代码探索、文件编辑、终端命令与改动审查都放进编辑器里。你可以连接受支持的账号、使用自己的 API Key，或用 Ollama、llama.cpp 在本地运行模型。选好适合当前任务的模型与权限，然后实时跟进工作过程。

## 快速开始

1. **安装 AiWorkHarness**：从 [VS Code 市场](https://marketplace.visualstudio.com/items?itemName=westhack.ai-work-harness) 安装；也可以在 [版本发布](https://github.com/westhack/ai-work-harness/releases) 下载 `.vsix`，然后执行 **扩展：从 VSIX 安装**。需要 VS Code 1.96 或更高版本。
2. **接入模型。** 打开 AiWorkHarness 侧边栏，进入设置。在 **Providers（提供商）** 中添加账号或 API 提供商，或配置 **Ollama**、**llama.cpp** 做本地推理。
3. **选择模型并开始对话。** 在 **Models（模型）** 中启用需要的模型，在输入框中选择一个，然后描述你的任务。Windows/Linux 按 `Ctrl+L`、macOS 按 `Cmd+L`，可把编辑器中的选区（未选中时为整个文件）加入对话。在编辑器获得焦点时，这会覆盖 VS Code 默认的 *扩展行选择* 快捷键；如果想保留原快捷键，可在键盘快捷方式中重新绑定 `aiworkharness.addToChat`。
4. **审查结果。** 查看工具活动与文件改动，然后保留或撤销修改。调整权限控制，决定哪些操作需要你的批准。

部分功能在首次使用时会下载原生运行时或模型文件。如需离线工作，请提前完成这些下载。

## 从一句提示到可评审的改动

| 能力 | 你可以做什么 |
| --- | --- |
| **感知工作区的对话** | 引用文件、文件夹、选区、文档、终端输出与 Git 上下文。用标签页分隔不同会话，草稿自动保存，历史可搜索。 |
| **富文本消息** | 直接在输入框写 Markdown，粘贴图片，预览附件，使用可指定或自动检测语言的高亮代码块。消息同时支持 RTL 与 LTR 内容。 |
| **可见的进度** | 跟进可折叠的工作活动、工具调用、任务列表与子智能体。已完成的工作会保留摘要，便于回看。 |
| **跟进与引导** | 排队下一条请求，编辑或调整队列顺序，引导正在运行的任务，或立即发送新请求打断它。 |
| **实现类工具** | 读写文件、搜索代码、执行终端命令、查看语言符号、验证浏览器行为。 |
| **改动审查** | 查看变更文件，在编辑器中逐块审查。准备好后使用 **Keep All（全部保留）** 或 **Undo All（全部撤销）**。 |

可在 **Agent**、**Ask**、**Plan**、**Project**、**Multitask** 模式间切换。Ask 为只读；Plan 可保存计划而不修改项目代码；Agent 会在你配置的权限下执行改动。你也可以派生或归档会话，把独立工作委派给子智能体。

## 接入你想用的模型

<img src="media/readme/providers.png" alt="账号连接、API Key、本地模型与免鉴权端点汇入已配置的提供商与对话模型选择器。多个凭据支持提供商级别的负载均衡与故障转移。" width="1440" />

| 连接方式 | 示例 | 配置方式 |
| --- | --- | --- |
| **账号** | Claude Code、OpenAI Codex、Google Antigravity、Gemini CLI、GitHub Copilot、Kiro、Kimi Code 等 | 在 **Add Account** 中选择提供商，按浏览器、设备码或导入令牌的流程操作。 |
| **API 提供商** | OpenAI、Anthropic、Google Gemini、OpenRouter、xAI、DeepSeek、Moonshot/Kimi、Z.ai、MiniMax、Qwen、Groq、Mistral、Together、Fireworks | 添加提供商并填入一个或多个 API Key。 |
| **自定义提供商** | 你自己的 OpenAI 兼容或 Anthropic 兼容端点 | 设置 Base URL、凭据（如需要）与模型。 |
| **本地模型** | Ollama 与 llama.cpp | 连接 Ollama，或管理 llama.cpp 运行时与 GGUF 模型。 |
| **免鉴权提供商** | OpenCode Free | 无需账号或 Key 即可添加连接。 |

只有已配置的 API 提供商会出现在提供商列表中。Models 页面只显示已启用且已连接的提供商，方便你专注于真正在用的连接。

**多账号与多 Key。** 同一提供商的多个连接会归为一组，并有各自的负载均衡设置。可选择「优先可用」或「轮询」路由；支持额度信息的账号提供商还会给出考虑额度的选项。在响应内容开始返回之前，符合条件的失败可以切换到其他凭据。

**与模型匹配的选项。** 模型目录与提供商发现会列出可用模型及其支持的推理、思考与上下文控制项。在 **Settings > Models** 中查看并启用你的连接可用的模型。可用性与工具支持取决于提供商与账号；目录条目不代表你已获得该模型的访问权限。

**选择处理速度。** 受支持的 GPT 与 Claude 模型会在模型选择器中提供 **Standard** 与 **Fast** 两档。默认是 Standard。Fast 请求优先处理，不会改变你的推理设置，但可能消耗额外额度或产生更高的 API 费用。你的账号与端点必须支持该能力；自定义网关需要把速度设置转发给上游提供商。

## 本地运行

<img src="media/readme/local-stack.png" alt="本地工作区连接 llama.cpp 或 Ollama 进行推理，并使用设备端嵌入索引做语义检索。模型与运行时下载会在离线使用前准备好。" width="1440" />

### llama.cpp

搜索 GGUF 模型、选择量化方式、下载文件，并在设置中管理模型服务。可配置上下文大小、GPU 层数、KV 缓存及其他启动参数。运行时健康状态、下载进度、取消操作与显存占用建议，让你清楚机器上正在发生什么。

### Ollama

连接 Ollama 端点，浏览已安装模型，拉取新模型，并加载或卸载它们。AiWorkHarness 会显示服务健康状态与运行时报告的模型能力。

### 本地推理与检索

将设备端模型与本地嵌入结合使用，即可在没有托管模型 API 的情况下工作。装好所需的模型与运行时后，本地编码与代码搜索可以离线完成。网络搜索、在线文档抓取与远程集成仍需要各自对应的服务。

## 为智能体提供相关上下文

<img src="media/readme/semantic-search.png" alt="工作区文件会变成可搜索的本地索引。文档遵循独立的有限页面计划，只索引选中的页面。两者都为智能体提供相关上下文。" width="1440" />

**按语义、也按文本搜索。** 语义检索结合嵌入与词法匹配，即使提问用词与实现用词不同，也能找到有用的代码。索引增量更新，会考虑编辑器中未保存的内容，并校验取回的代码片段是否仍然有效。默认提供本地嵌入；也可以选择兼容的托管嵌入端点。

**在限定范围内索引文档。** 在 **Settings > Indexing & Docs** 中添加文档来源，选择页面或章节，可选填主题与排除路径。发现流程会基于来源、导航、`llms.txt` 和有限范围的 sitemap 发现，构建一个页面数量确定的计划。AI 辅助筛选可以用你配置的模型缩小该计划。

抓取到的页面不会再向计划中添加新链接。每次运行都有请求数、下载量与时间上限；重复内容会被过滤，未变化的嵌入可以复用。如果更新失败，之前可用的索引会被保留。任务需要时，用 `@Docs` 引用已索引的文档。

## 定制工作流

- **指令与技能：** 使用按范围生效的工作区指令、规则、可复用技能与人格，引导智能体的工作方式。
- **MCP 与钩子：** 通过本地或远程 MCP 服务器接入工具与资源，并在支持的生命周期事件前后运行钩子。
- **子智能体与目标：** 委派工作、跟进后台任务，并用可选的 token 预算跟踪一个目标。
- **工作树与执行：** 使用隔离的 Git 工作树处理不同任务，需要时配置 Docker 命令执行。
- **插件与远程任务：** 安装本地插件包，或把工作提交给已配置的 worker，并审查导出的补丁。

语言导航依赖已安装的 VS Code 语言提供程序；浏览器工具有需要已安装的浏览器；Docker 执行需要运行中的引擎和已有镜像。远程任务使用已配置的 worker 和已提交的仓库版本；应用返回的补丁是单独的审查步骤。

## 你的数据与连接

对话、草稿、索引与编辑恢复数据都由扩展保存在本地。API Key 与账号令牌存放在 **VS Code SecretStorage** 中。

模型推理在你选择的端点进行。托管模型与嵌入会收到其请求所需的上下文；文档抓取、浏览器工具、MCP 服务器、钩子与远程 worker 会使用你配置或调用的服务。若要走纯本地流程，请选择本地推理与本地嵌入，并在不需要时关闭外部工具。

## 开发

构建扩展需要 Node.js 22、pnpm、Git 与 VS Code。

```bash
git clone https://github.com/westhack/ai-work-harness.git
cd ai-work-harness
pnpm install --frozen-lockfile
pnpm run compile
```

用 VS Code 打开仓库，按 `F5` 启动扩展开发宿主。开发过程中可用 `pnpm run watch`，或执行 `pnpm run vsix` 生成可安装的包。

### 检查

```bash
pnpm run check-types
pnpm run lint
pnpm run test:unit
pnpm run test:browser
```

其他检查包括 `pnpm run test:runtime`、`pnpm run test:host` 与 `pnpm run test:worker`，分别覆盖运行时安装、扩展激活与 worker 执行。在线提供商检查需要已配置的凭据。

浏览器测试套件与单元测试分开运行。本地使用已安装的 Chrome 或 Edge；CI 会安装与锁定 Playwright 版本匹配的 Chromium，并要求这些浏览器测试必须通过。

### 预览界面

编译完成后，启动本地预览：

```bash
pnpm run preview:ui
```

打开 `http://127.0.0.1:4173`。预览会用示例数据和模拟的 VS Code 桥接渲染生产版对话与设置界面。可以试试 `/?state=conversation&theme=light&width=380` 查看窄栏对话，或 `/?view=settings&theme=dark&width=1200` 查看设置页。

README 用的图片位于 [`media/readme`](media/readme)。SVG 源文件可直接编辑，PNG 导出版保证在 GitHub 与市场中正常显示。执行 `node scripts/render-readme-diagrams.cjs` 可重新生成示意图；在预览运行时执行 `node scripts/render-readme-hero.cjs` 可刷新界面截图。

## 贡献

欢迎提交缺陷报告、文档改进、提供商修复与 Pull Request。请 [提交 issue](https://github.com/westhack/ai-work-harness/issues)，附上复现步骤、VS Code 版本以及相关的提供商或运行时。分享日志与截图前，请先移除凭据与私有工作区内容。

提交代码改动时，请给出针对性的验证；界面有变化时请附截图。保持 PR 范围聚焦，便于审查行为与其验证方式。

## 许可证

AiWorkHarness 基于 [MIT 许可证](LICENSE) 发布。

本项目由 Pawan Osman 的 OpenCursor 演化而来，按 MIT 许可证分发，原始版权声明保留在 [LICENSE](LICENSE) 中。

## 致谢

- **[OpenCursor](https://github.com/PawanOsman/OpenCursor)**（作者 Pawan Osman）是 AiWorkHarness 的上游项目。
- **[Codex](https://github.com/openai/codex)**（OpenAI）启发了 AiWorkHarness 的界面设计、样式与交互方式。
- **[9router](https://github.com/decolua/9router)** 为 AiWorkHarness 中的提供商集成与账号认证支持提供了基础。

感谢这些项目及其贡献者。
