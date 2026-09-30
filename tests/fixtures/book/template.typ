// Synthetic book template for the fragment-renderer tests (no packages).
// Chapters import it themselves (`#import "../template.typ": *`): an included
// file does not see main.typ's bindings.

#let accent = rgb("#1f5fbf")

// Math aliases.
#let RR = $bb(R)$
#let EE = math.op($bb(E)$)
#let PP = $bb(P)$
#let Var = math.op("Var")
#let given = math.mid(sym.bar.v)
#let inner(a, b) = $lr(chevron.l #a, #b chevron.r)$

// A theorem box whose body is markup (a statement spanning several lines).
#let theorem(title: none, body) = block(
  width: 100%,
  inset: (x: 8pt, y: 6pt),
  stroke: (left: 2pt + accent),
)[
  #text(fill: accent, weight: "bold")[定理#if title != none [（#title）]]
  #body
]

#let book(title: none, body) = {
  set document(title: title)
  set heading(numbering: "1.1")
  set math.equation(numbering: "(1)", supplement: none)
  // Captions in the book's colour: only the document template applies it.
  show figure.caption: set text(fill: rgb("#6b2fa3"))
  page(numbering: none)[#align(center, text(size: 20pt, title))]
  body
}
