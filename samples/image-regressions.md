# 图片加载与排版验收

蓝色 A 与绿色 B 均为 480 × 240 像素。请分别检查下列图片和图注。

## Markdown 相对路径

![蓝色 A](png-a.png)

## 引用式图片

![绿色 B][sample-b]

[sample-b]: png-b.png

## HTML flex 并排

<div style="display:flex;gap:12px;justify-content:center">
<figure style="width:48%;margin:0"><img src="png-a.png" alt="并排 A" style="width:100%"><figcaption>图 A：蓝色</figcaption></figure>
<figure style="width:48%;margin:0"><img src="png-b.png" alt="并排 B" style="width:100%"><figcaption>图 B：绿色</figcaption></figure>
</div>

## 居中与 48% 宽度

<p style="text-align:center"><img src="png-a.png" alt="居中 A" style="width:48%"></p>

## 右浮动绕排

<img src="png-b.png" alt="浮动 B" style="float:right;width:180px;margin:0 0 12px 16px">

这段文字应出现在绿色 B 的左边。窗口宽度变化时，文字应继续绕着图片排列。行内公式 $a^2+b^2=c^2$ 仍可正常显示。

<br style="clear:both">
