# PNG 并排预览

用旁边两张本地图看 HTML 排版效果。蓝块是 `png-a.png`，绿块是 `png-b.png`。

## 1. Flex 并排（推荐）

<div style="display:flex; gap:12px; align-items:flex-start">
  <img src="png-a.png" alt="A" style="width:48%; height:auto">
  <img src="png-b.png" alt="B" style="width:48%; height:auto">
</div>

## 2. 表格并排

<table>
  <tr>
    <td style="border:none; width:50%; text-align:center">
      <img src="png-a.png" alt="A" style="width:100%; height:auto">
    </td>
    <td style="border:none; width:50%; text-align:center">
      <img src="png-b.png" alt="B" style="width:100%; height:auto">
    </td>
  </tr>
</table>

## 3. 居中单图

<p style="text-align:center">
  <img src="png-a.png" alt="A" style="width:40%">
</p>

## 4. 右浮动绕排

<img src="png-b.png" alt="B" style="float:right; width:220px; margin:0 0 8px 12px">

这段文字会绕着右侧小图走。预览栏够宽时，公式和段落会从左边流过去。

行内公式 $a_i + b_i$ 也可以和绕排图一起看。

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

<br style="clear:both">
