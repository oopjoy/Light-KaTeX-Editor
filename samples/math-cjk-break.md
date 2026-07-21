# 中文公式与换行

## 行内中文

设误差为 $误差 \le \varepsilon$，则收敛。

状态 $状态量 U^{n+1}$ 满足方程。

## 单行块中文

$$误差 bound:\quad \|e^{n+1}\| \le C h^{2}$$

## 无 aligned 时用 \\ 换行

$$
a = b + c \\
d = e + f \\
g = h
$$

## 也支持用户误写的 // 换行

$$
x = 1 //
y = 2 //
z = 3
$$

## Typora 风格开闭（$$ 与环境同一行）

$$\begin{aligned}
p_2(t)
&= U_{n+1}\frac{(t-t_n)(t-t_{n-1})}{(t_{n+1}-t_n)(t_{n+1}-t_{n-1})} \\
&+ U_n\frac{(t-t_{n+1})(t-t_{n-1})}{(t_n-t_{n+1})(t_n-t_{n-1})} \\
&+ U_{n-1}\frac{(t-t_{n+1})(t-t_n)}{(t_{n-1}-t_{n+1})(t_{n-1}-t_n)}.
\end{aligned}$$

## 已有 aligned 不重复包裹

$$
\begin{aligned}
E &= mc^2 \\
F &= ma
\end{aligned}
$$
