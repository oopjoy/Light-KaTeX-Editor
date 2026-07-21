# Light KaTeX Editor

轻量本地 Markdown 阅读 / 编辑器。源码仓库：<https://github.com/oopjoy/Light-KaTeX-Editor>。

不想安装 Node.js 的 Windows 用户可以直接下载 [v0.1.0 便携版](https://github.com/oopjoy/Light-KaTeX-Editor/releases/tag/v0.1.0)。

主要功能：

- 直接打开和保存现有 `.md` 文件
- 左侧 CodeMirror 6 源码编辑
- 右侧 markdown-it + KaTeX 实时预览
- 支持行内 `$...$`、单行块 `$$\alpha$$`、多行块 `$$ ... $$`
- 配置保存在应用用户目录，不写入文档目录
- 无 Vault、无数据库、无所见即所得内部文档模型

## 要求

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

- **错误列表**：窗口底部列出无法解析的 `$...$` / `$$...$$`，点击跳到源码行
- **补全提示**：在公式内输入 `\` 后自动提示常用 KaTeX 命令（希腊字母、分数、极限、环境等）；`Ctrl+Space` 可手动触发

## 设计原则

源码始终是唯一数据源：

```text
Markdown 源码 → 只读 HTML 预览
```

保存时写回编辑器中的原始字符串，预览结果不参与序列化，因此 `$$\alpha$$` 不会被改写成三行形式。

## 配置目录

Windows：

```text
%APPDATA%\light-katex-editor\config.json
```

仅保存最近文件、窗口尺寸、主题、字体大小、分栏比例等。


## 便携打包（Windows）

生成单文件便携版（解压式自解压 EXE，双击即可运行，无需安装 Node）：

```bash
npm install
npm run dist
```

产物：

```text
release/LightKaTeXEditor-0.1.0-portable.exe
```

也可只生成未压缩目录（调试用）：

```bash
npm run dist:dir
# release/win-unpacked/Light KaTeX Editor.exe
```

说明：

- 配置仍写在 `%APPDATA%\light-katex-editor\`，不会进压缩包
- 首次在其它电脑运行可能被 Windows SmartScreen 拦截（未签名），选「仍要运行」即可
- 体积约 70–90 MB 属 Electron 正常范围

## 许可证

[MIT](LICENSE)
