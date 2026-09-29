#import "../template.typ": *

= 线性代数 <chap:linalg>

内积 $inner(x, y)$ 与范数 $norm(x)$，参见 @eq:var。
#let ip(a, b) = $lr(chevron.l #a, #b chevron.r)$
$ inner(x, y)^2 <= inner(x, x) inner(y, y) $ <eq:inner>

在定义之前：$L$ 还只是字母。

#let Lip = $L$
#let grad = math.nabla

在定义之后：$norm(grad f(x) - grad f(y)) <= Lip norm(x - y)$。
