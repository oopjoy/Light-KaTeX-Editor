# 让公式笔记回到文件本身

Light KaTeX Editor · 本地 Markdown 阅读与编辑

源码在左，预览在右。一窗一文，直接打开已有文件。

## 公式与推导

行内公式 $E=mc^2$，也支持 LaTeX 分隔符 \(\nabla\cdot\mathbf{E}=\rho/\varepsilon_0\)。

$$
\begin{aligned}
\mathcal{F}[f](\omega) &= \int_{-\infty}^{\infty} f(t)e^{-i\omega t}\,dt \\
f(t) &= \frac{1}{2\pi}\int_{-\infty}^{\infty}\hat{f}(\omega)e^{i\omega t}\,d\omega
\end{aligned}
$$

## 表格中的数学

| 表达式 | 含义 | 支持 |
| --- | --- | --- |
| $\min|\psi|$ | 绝对值 | ✓ |
| $\|\mathbf{x}\|_2$ | 向量范数 | ✓ |
| $\alpha_i+\beta_i$ | 行内公式 | ✓ |

## 从笔记到分享

- [x] 原始 Markdown 文件直接保存
- [x] 未保存编辑的恢复快照
- [x] 本地图片与 HTML 排版
- [x] 导出 HTML / PDF

```python
import numpy as np

t = np.linspace(0, 2 * np.pi, 256)
signal = np.sin(t)
```

## 轻量的工作方式

用文档大纲定位章节，在源码和预览间双向跳转。

按 `Ctrl+S` 保存，按 `Ctrl+T` 切换浅色与深色主题。
