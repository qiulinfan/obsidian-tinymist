#import "../template.typ": *

= 概率 <chap:prob>

期望写作 $EE[X] = integral_Omega X dif PP$，其中 $X: Omega -> RR$。
方差的定义：
$ Var(X) = EE[(X - EE[X])^2] $ <eq:var>

#theorem(title: [全期望])[
  #set text(fill: red)
  若 $EE[abs(X)] < infinity$，则
  $ EE[X] = EE[EE[X given Y]]. $ <eq:total>
]

- 第一项 $a_1$；
- 第二项见 @eq:inner。
+ 编号项 $sum_(i=1)^n i = n(n+1) / 2$

价格 \$5 不是数学，`$x$` 也不是。
// 注释里的 $alpha$ 不是数学。
