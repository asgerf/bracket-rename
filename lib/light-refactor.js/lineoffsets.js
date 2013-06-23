(function (root, factory) {  // Universal Module Definition (https://github.com/umdjs/umd)
    if (typeof exports === 'object') {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define(factory);
    } else {
        root.LineOffsets = factory();
  }
}(this, function () {

function LineOffsets(text) {
    var offsets = this.offsets = [0];
    var len = text.length;
    var wasR = false
    for (var i=0; i<len; ++i) {
        switch (text[i]) {
            case '\n':
                offsets.push(i+1)
                break;
            case '\r':
                if (text[i+1] === '\n') {
                    ++i;
                }
                offsets.push(i+1)
                break;
        }
    }
    if (offsets[offsets.length-1] !== len) {
        offsets.push(len)
    }
}
LineOffsets.prototype.position = function(offset) {
    var line = this.line(offset)
    var column = offset - this.offsets[line];
    return {line:line, column:column};
}
LineOffsets.prototype.line = function(offset) {
    var low = 0;
    var high = this.offsets.length-2;
    while (low <= high) {
        var mid = (low + high) >> 1;
        var start = this.offsets[mid];
        var end = this.offsets[mid+1];
        if (offset < start) {
            high = mid-1;
        } else if (offset > end) {
            low = mid+1;
        } else {
            return mid;
        }
    }
    return offset < 0 ? 0 : this.offsets.length-1; // offset out of range
}
LineOffsets.prototype.column = function(offset) {
    return this.position(offset).column;
}
LineOffsets.prototype.offset = function(line, col) {
    if (line < 0)
        line = 0;
    else if (line >= this.offsets.length)
        line = this.offsets.length-1;
    if (typeof col === 'undefined')
        col = 0;
    return this.offsets[line] + col;
}

return LineOffsets;
    
})); // end of UMD