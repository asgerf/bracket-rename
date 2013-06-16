/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define, $, brackets */

define(function (require, exports, module) {
    "use strict";
    
    var CommandManager  = brackets.getModule("command/CommandManager"),
        Menus           = brackets.getModule("command/Menus"),
        EditorManager   = brackets.getModule("editor/EditorManager");
    
    var JavaScriptBuffer = require('light-refactor.js/type-inference');
    
    var ModalBar = brackets.getModule('widgets/ModalBar').ModalBar;
    
    function convertPos(pos) {
        return {line: pos.line-1, ch: pos.column}
    }
    
    CommandManager.register("Show Message", "showMessage", function () {
        var editor = EditorManager.getFocusedEditor()
        if (editor === null)
            return
            
        var text = editor.document.getText()
        var pos = editor.indexFromPos(editor.getCursorPos())
            
        var jsb = new JavaScriptBuffer;
        jsb.add("main", text)
        var questions = jsb.renameTokenAt("main", pos) // TODO: run in parallel with modal bar
        if (!questions)
            return
        
        var initialRange;
        initialRangeLoop:
        for (var i=0; i<questions.length; i++) {
            for (var j=0; j<questions[i].length; j++) {
                var range = questions[i][j];
                if (range.start.offset <= pos && pos <= range.end.offset) {
                    initialRange = range;
                    break initialRangeLoop;
                }
            }
        }
        var oldName = text.substring(initialRange.start.offset, initialRange.end.offset) // todo: nicer way to get old name
        
        var nameBar = new ModalBar('New name: <input type="text" style="width: 10em" value="'+oldName+'"/>', true); // true=auto-close
        
        var selected = {} // indices of selected renamings
        
        // todo: auto-answer question with initial token
        
        var newName;
        
        $(nameBar).on("closeOk", function() {
            newName = $("input[type='text']", nameBar.getRoot()).val()
            nameBar = null
            askQuestion(0)
        })
        
        function askQuestion(i) {
            if (i === questions.length) {
                finishRenaming()
            } else {
                var token = questions[i][0]
                // todo: better highlighting
                // todo: highlight all tokens in group
                editor.setSelection(convertPos(token.start), convertPos(token.end), true) // true=center viewport on selection
                var confirmBar = new ModalBar('Rename this token? ' +
                                              '<button id="rename-yes" class="btn">Yes</button> ' +
                                              '<button id="rename-no" class="btn">No</button> ' +
                                              '<span style="margin-left: 3em">&nbsp;</span> ' +
                                              '<button id="rename-yes-all" class="btn">Yes to Rest</button> ' +
                                              '<button id="rename-no-all" class="btn">No to Rest</button> ' +
                                              '<span style="margin-left: 3em">&nbsp;</span> ' +
                                              '<button class="btn">Abort</button><br/>'+
                                              (i+1) + ' / ' + questions.length, 
                                              true) // true=auto-close
                confirmBar.getRoot().on("click", "button", function(e) {
                    confirmBar.close()
                    switch (e.target.id) {
                        case 'rename-yes':
                            selected[i] = true
                            askQuestion(i+1)
                            break;
                        case 'rename-no':
                            selected[i] = false
                            askQuestion(i+1)
                            break;
                        case 'rename-yes-all':
                            for (var j=i; j<questions.length; j++) {
                                selected[j] = true;
                            }
                            finishRenaming();
                            break;
                        case 'rename-no-all':
                            finishRenaming();
                            break;
                        default:
                            break; // stop button - do nothing
                    }
                })
            }
        }
        
        function finishRenaming() {
            // After renaming, zoom back to original position. We need to keep track of the exact
            // column offset in case it changes due to renaming
            var zoomCol = initialRange.start.column;
            var zoomLine = initialRange.start.line;
            var oldNameLength = initialRange.end.column - initialRange.start.column;
            var zoomScreen = questions.length > 1; // don't zoom if renaming was completely automatic
            
            // collect all ranges to update
            var ranges = []
            for (var i=0; i<questions.length; i++) {
                if (!selected[i])
                    continue
                for (var j=0; j<questions[i].length; j++) {
                    var range = questions[i][j]
                    ranges.push(range)
                    
                    // check if this renaming pushes the zoom offset
                    if (range.start.line == initialRange.start.line && range.start.column < initialRange.start.column) {
                        zoomCol += newName.length - oldNameLength;
                    }
                }
            }
            
            // sort ranges from back to front to avoid changing offset during replaceRange
            ranges.sort(function(x,y) { return y.start.offset - x.start.offset })
            
            // apply changes
            editor.document.batchOperation(function() {
                ranges.forEach(function (range) {
                    editor.document.replaceRange(newName, convertPos(range.start), convertPos(range.end))
                })
                // zoom back to original token and select it
                editor.setSelection({line:zoomLine-1, ch:zoomCol}, {line:zoomLine-1, ch:zoomCol+newName.length}, zoomScreen)
            })
        }
        
    });
    
    var editMenu = Menus.getMenu(Menus.AppMenuBar.EDIT_MENU);
    
    editMenu.addMenuItem("showMessage", null, Menus.FIRST);
});
