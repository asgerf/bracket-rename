Lightweight Refactoring Tools for JavaScript
============================================

Lightweight analysis tools for JavaScript, geared towards automated refactoring support.

Basic Usage
-----------

```javascript
var jsb = new JavaScriptBuffer;
jsb.add(<filename>, <source code>);
var groups = jsb.renameTokenAt(<file>, <offset>);
```
	
The groups returned are of type `Range[][]` given the following type schema:

```javascript
interface Position {
    offset: int;
    line: int;
    column: int;
}
interface Range {
    file: string;
    start: Position
    end: Position
}
```

Each `Range[]` object in the topmost array is one group of identifiers that should be renamed together.

Usage Details
-------------

For renaming local variables and labels, loading all files into the buffer is not necessary. For that reason,
one may use the following approach:

```javascript
jsb.add(<current file>, <source code>)
if (!jsb.canRenameLocally(<current file>, <offset>))  {
/* add all other files that should be updated */
}
```

For the time being, a `JavaScriptBuffer` object should not be reused once a rename function has been invoked.
