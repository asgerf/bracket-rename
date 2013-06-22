---
layout: slate
title: LightRefactor for Brackets
repository_url: https://github.com/asgerf/bracket-rename
---

### Refactoring Tools for JavaScript
A splendid programmer such as yourself obviously never makes mistakes, and never regrets past decisions.

No? Oh, well.

Sometimes it becomes clear only in hindsight how things should have been done.
Wouldn't it be nice if we could leverage the [power of hindsight](https://www.google.dk/images?q=captain+hindsight) to fix mistakes of the past?

With the proper tools, we can. One particularly common mistake is to choose a bad name for a variable or property.

### Renaming JavaScript Identifiers
Local variables are easy to rename automatically, and many editors support this. But property names are more tricky.

Suppose you want to rename the `array` property of your `StringBuilder` class below to something else. How does your favourite editor help you do this?

{% highlight javascript %}
function StringBuilder() {
    this.array = []
}
StringBuilder.prototype.append = function(x) {
    this.array.push(x)
}
StringBuilder.prototype.clear = function() {
    this.array.length = 0
}
StringBuilder.prototype.toString = function() {
    return this.array.join('')
}
{% endhighlight %}

For a long time, there have been two approaches to this problem:

- ***The Bulldozer Approach***:
  Replace *all* occurrences of the `array` property name.

- ***The Old-School Approach***:
  Use find/replace tools and decide manually for every occurrence of `array` if it should be replaced. 

Neither of these are entirely satisfactory. There may be other properties called `array` that the bulldozer approach will accidentally rename, and the old-school approach can be rather tedious to carry out.

#### Semi-Automatic Renaming
The [LightRefactor extension](https://github.com/asgerf/bracket-rename) for [Brackets](http://brackets.io) walks a middle ground between the old-school and the bulldozer.

We use a static analyzer to figure out which tokens definitely refer to the same property, and won't bother you for feedback when we can figure out the answer automatically.

For example, if we ask to rename the `array` identifier in `StringBuilder`:
![](images/SelectName.png)
The tool can't tell if there is some common interface between `StringBuilder` and `BinaryHeap`, so you will have to tell it explicitly not to rename `BinaryHeap`'s `array` property.
![](images/YesOrNo.png)
After clicking "No" the refactoring kicks in:
![](images/Done.png)

### How Do I Try It?
Install [Brackets](http://brackets.io) and then use the extension manager to install it using the [GitHub URL](https://github.com/asgerf/bracket-rename).

### Research
Making refactoring tools for JavaScript is part of my Ph.D research in the [Programming Languages Group](http://cs.au.dk/research/research-areas/programming-languages/) at Aarhus University. We are currently exploring others types of refactorings, and ways to make the static analyzer smarter.
