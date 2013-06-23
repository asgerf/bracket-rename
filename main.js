/*jslint asi: true, vars: true, plusplus: true, devel: true, nomen: true,  maxerr: 50 */
/*global define, $, brackets */

define(function (require, exports, module) {
    var CommandManager  = brackets.getModule("command/CommandManager"),
        Menus           = brackets.getModule("command/Menus"),
        EditorManager   = brackets.getModule("editor/EditorManager"),
        FileUtils       = brackets.getModule("file/FileUtils");
    
    var JavaScriptBuffer = require('lib/light-refactor.js/type-inference');
    
    var ModalBar = brackets.getModule('widgets/ModalBar').ModalBar;
    
    function convertPos(pos) {
        return {line: pos.line, ch: pos.column}
    }
    
    CommandManager.register("Rename JavaScript Identifier", "javascript.renameIdentifier", function () {
        var editor = EditorManager.getFocusedEditor()
        if (editor === null)
            return
        var cm = editor._codeMirror
        
        var text = editor.document.getText()
        var pos = editor.indexFromPos(editor.getCursorPos())
        
        var filename = editor.document.file ? editor.document.file.name : "";
        var isHtml = FileUtils.isStaticHtmlFileExt(filename)
        
        var jsb = new JavaScriptBuffer;
        jsb.add("main", text, {type: isHtml ? "html" : "js"})
        var questions = jsb.renameTokenAt("main", pos) // TODO: run in background?
        if (!questions)
            return
        
        var initialRange = questions[0][0];
        var oldName = text.substring(initialRange.start.offset, initialRange.end.offset)
        
        // We need to highlight groups of tokens. We use an array to keep track of the text markers we've inserted.
        var markers = []
        function setHighlighting(ranges) {
            cm.operation(function() {
                markers.forEach(function(x) { x.clear() }) // remove any existing markers
                markers.length = 0
                $(cm.getWrapperElement()).addClass("find-highlighting");
                for (var j=0; j<ranges.length; j++) {
                    var range = ranges[j]
                    var marker = editor._codeMirror.markText(convertPos(range.start), convertPos(range.end), {className:"CodeMirror-searching"})
                    markers.push(marker)
                }
            })
        }
        function clearHighlighting() {
            $(cm.getWrapperElement()).removeClass("find-highlighting");
            cm.operation(function() {
                markers.forEach(function(x) { x.clear() })
                markers.length = 0
            })
        }
        
        // Highlight token related to the selected token while asking for the new name
        setHighlighting(questions[0])
        var nameBar = new ModalBar('New name: <input type="text" style="width: 10em" value="'+oldName+'"/>', true); // true=auto-close
        
        var selected = {0:true} // indices of selected renamings (auto-answer first question)
        
        var newName;
        
        $(nameBar).on("closeOk", function() {
            newName = $("input[type='text']", nameBar.getRoot()).val()
            nameBar = null
            askQuestion(1)
        })
        $(nameBar).on("closeCancel", cancelRenaming)
        $(nameBar).on("closeBlur", cancelRenaming)
        
        function askQuestion(i) {
            if (i === questions.length) {
                finishRenaming()
            } else {
                var token = questions[i][0]
                editor.setSelection(convertPos(token.start), convertPos(token.start), true) // true=center viewport on selection
                setHighlighting(questions[i])
                var confirmBar = new ModalBar('Rename this token? ' +
                                              '<button id="rename-yes" class="btn">Yes</button> ' +
                                              '<button id="rename-no" class="btn">No</button> ' +
                                              '<button class="btn">Abort</button>' +
                                              '<div style="float: right; color:gray">' +
                                                'Question ' + (i+1-1) + ' / ' + (questions.length-1) + ' ' +
                                                '<button id="rename-yes-all" class="btn">Yes to Rest</button> ' +
                                                '<button id="rename-no-all" class="btn">No to Rest</button> ' +
                                              '</div>', 
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
                            cancelRenaming();
                            break;
                    }
                })
                $(confirmBar).on("closeBlur", cancelRenaming);
                $(confirmBar).on("closeCancel", cancelRenaming);
            }
        }
        
        function cancelRenaming() {
            clearHighlighting();
        }
        
        function finishRenaming() {
            clearHighlighting();
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
                    if (range.start.line === initialRange.start.line && range.start.column < initialRange.start.column) {
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
                editor.setSelection({line:zoomLine, ch:zoomCol}, {line:zoomLine, ch:zoomCol+newName.length}, zoomScreen)
            })
        }
        
    });
    
    var editMenu = Menus.getMenu(Menus.AppMenuBar.EDIT_MENU);
    
    var keys = [
        {key: "Ctrl-R", platform:"mac"}, // don't translate to Cmd-R on mac
        {key: "Ctrl-R", platform:"win"}
    ];
    
    editMenu.addMenuItem("javascript.renameIdentifier", keys, Menus.LAST_IN_SECTION, Menus.MenuSection.EDIT_REPLACE_COMMANDS);
});
