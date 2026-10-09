# LaTeX 分隔符回归样例

行内公式：\(E=mc^2\)，以及原有美元符号公式 $x_1+x_2$。

块公式：

\[
\boxed{\begin{gathered}
\text{输入原始 Markdown}\\
\Downarrow\\
\text{解析公式并渲染预览}
\end{gathered}}
\]

单行块公式：

\[\int_0^1 x^2\,dx=\frac{1}{3}\]

原有块公式：

$$\alpha+\beta=\gamma$$

> \[
> a^2+b^2=c^2
> \]

- 列表内公式：\(\frac{a}{b}\)。

| 类型 | 示例 |
| --- | --- |
| 行内 | \(H_{c1}\) |

以下内容应保持字面显示，不渲染成公式：

`\(x\)`、`\[x\]`、`$x$`

```tex
\[
\notARealCommand
\]
```

~~~tex
\(\notARealCommand\)
~~~

转义后的分隔符：\\(x\\)、\\[x\\]。
