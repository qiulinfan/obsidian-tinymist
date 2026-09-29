// Synthetic book entry: template import, data, a document template, two chapters.
#import "template.typ": *
// Read from main's folder: fragment preambles make the path root-absolute.
#let meta = yaml("meta.yaml")

#show: book.with(title: meta.title)
#set math.equation(numbering: "(1.1)")

#include "chapters/ch1.typ"
// Between the chapters: part of ch2's fragment preamble, not ch1's.
#set math.vec(delim: "[")
#include "chapters/ch2.typ"

// After the chapters: never part of a chapter's fragment preamble.
#let after-chapters = $A$
