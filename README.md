# Light KaTeX Editor

轻量本地 Markdown 阅读 / 编辑器。源码仓库：<https://github.com/oopjoy/Light-KaTeX-Editor>。

**Windows 用户推荐下载 [最新完整安装版](https://github.com/oopjoy/Light-KaTeX-Editor/releases/latest)**，选择 `LightKaTeXEditor-版本号-Setup.exe`。

安装包内置 Electron 和全部运行依赖，**无需安装 Node.js，也无需下载源码**。安装向导支持选择安装目录、创建桌面和开始菜单快捷方式，并提供卸载入口；安装后直接启动，不再每次自解压。不会修改 Markdown 默认打开程序。旧版 portable 仍保留在历史 Releases 中。

安装包目前未进行代码签名，Windows SmartScreen 可能提示未知发布者。请核对仓库来源和发布页的 SHA-256 校验值后再决定是否运行。

主要功能：

- 直接打开和保存现有 `.md` 文件
- 左侧 CodeMirror 6 源码编辑
- 右侧 markdown-it + KaTeX 实时预览
- 支持行内 `$...$`、`\(...\)`，以及单行或多行块公式 `$$...$$`、`\[...\]`
- 保留 LaTeX 原始分隔符；代码片段、代码块和转义后的分隔符不会被误解析为公式
- 配置保存在应用用户目录，不写入文档目录
- 无 Vault、无数据库、无所见即所得内部文档模型

## 源码运行要求

以下要求仅适用于开发和源码运行；Windows x64 安装版不需要 Node.js。

- Node.js 20+
- Windows / macOS / Linux

## 安装

```bash
git clone https://github.com/oopjoy/Light-KaTeX-Editor.git
cd Light-KaTeX-Editor
npm install
```

## 开发运行

```bash
npm run dev
```

## 生产构建

```bash
npm run build
npm start
```

## 窗口模型

**一窗一文**：每个窗口只绑定一个 Markdown 文件。

- 点 **打开** / `Ctrl+O`：始终在**新窗口**打开所选文件
- 点 **新窗口** / `Ctrl+Shift+N`：新建空窗口
- 命令行传入多个 `.md`：每个文件各开一个窗口
- 若该文件已在某窗口打开：聚焦已有窗口，不重复开窗

## 注册到 Windows「打开方式」

只添加 Open with 条目，**不会**改默认打开程序：

```bash
npm run register-open-with
```

之后可对 `.md` 右键 → 打开方式 → Light KaTeX Editor。

取消注册：

```bash
npm run unregister-open-with
```

## 双向跳转

- **双击预览**中的段落 / 标题 / 公式 / 代码块 → 源码跳到对应行
- **源码区右键** →「跳转到预览」→ 预览滚动到对应块并高亮

映射粒度是块级（基于 `data-source-line`），不是字符级。

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+O` | 打开（新窗口） |
| `Ctrl+Shift+N` | 新建空窗口 |
| `Ctrl+S` | 保存 |
| `Ctrl+Shift+S` | 另存为 |
| `Ctrl+F` | 查找 |
| `Ctrl+H` | 替换 |
| `Ctrl+,` | 设置（主题 / 字体 / 字号 / 行距 / 宽度） |
| `Ctrl+=` / `Ctrl+-` | 增大 / 减小字号 |
| `Ctrl+0` | 重置字号 |
| `Ctrl+T` | 切换主题 |
| `F11` / `Esc` | 全屏 / 退出全屏 |

菜单：**文件 → 最近打开**，**编辑 → 查找/替换**，**设置 → 外观与字体**，**设置 → 主题 → 浅色/深色**，**查看 → 增大/减小/重置字号**。

## 公式辅助

- **错误列表**：窗口底部列出无法解析的 `$...$` / `$$...$$` / `\(...\)` / `\[...\]`，点击跳到源码行
- **补全提示**：在公式内输入 `\` 后自动提示常用 KaTeX 命令（希腊字母、分数、极限、环境等）；`Ctrl+Space` 可手动触发

## 设计原则

源码始终是唯一数据源：

```text
Markdown 源码 → 只读 HTML 预览
```

保存时写回编辑器中的原始字符串，预览结果不参与序列化，因此 `$$\alpha$$` 不会被改写成三行形式，`\(...\)` / `\[...\]` 也不会被替换成美元符号分隔符。

## 配置目录

Windows：

```text
%APPDATA%\light-katex-editor\config.json
```

仅保存最近文件、窗口尺寸、主题、字体大小、分栏比例等。


## Windows 安装包构建

默认构建完整离线 NSIS 安装包（Windows x64）：

```bash
npm ci
npm test
npm run dist
```

产物：

```text
release/LightKaTeXEditor-0.1.3-Setup.exe
```

安装版使用固定安装目录，包含运行时、应用资源和卸载程序。默认按当前用户安装，支持自选路径；卸载不删除用户配置或文档。

如需原来的自解压单文件便携版：

```bash
npm run dist:portable
```

也可只生成未压缩目录（调试用）：

```bash
npm run dist:dir
# release/win-unpacked/Light KaTeX Editor.exe
```

说明：

- 配置仍写在 `%APPDATA%\light-katex-editor\`，不会进压缩包
- 安装包尚未签名，首次运行可能收到 Windows SmartScreen 提示；请确认来源与校验值
- 包体包含完整 Electron 运行时，安装后占用数百 MB 属正常情况

## 许可证

[MIT](LICENSE)
