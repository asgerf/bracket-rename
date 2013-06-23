// htmljs.js: Locates JavaScript in HTML
// =====================================

// TODO:
// - handle PHP, ASP, JSP

(function (root, factory) {  // Universal Module Definition (https://github.com/umdjs/umd)
    if (typeof exports === 'object') {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define(factory);
    } else {
        root.htmljs = factory();
  }
}(this, function () {

return function(code) {
	// Lexer states
	var Init = 0;
	var OpenTag = 1;
	var InsideTagName = 2;
	var BetweenAttributes = 3;
	var InsideAttrName = 4;
	var BeforeAttrValue = 5;
	var InsideAttrValue = 6;
	var InsideQuotedAttrValue = 7;
	var InsideScriptTag = 8;
	var InsideStyleTag = 9;
	var InsideComment = 10;
	var InsideCData = 11;

	var isCloseTag = false;
	var isSelfClosingTag = false;

	var startOfTagName = -1;
	var endOfTagName = -1;
	var startOfAttrName = -1;
	var endOfAttrName = -1;
	var startOfAttrValue = -1;
	var endOfAttrValue = -1;
	var startOfScriptBody = -1;
	var endOfScriptBody = -1;

	var quote = '\0';

	var isScriptTag = false;
	var result = [];

	function isTagChar(ch) {
		switch (ch) {
			case undefined:
			case ' ':
			case '\r':
			case '\n':
			case '\t':
			case '\v':
			case '/':
			case '>':
				return false;
		}
		return true;
	}

	function match(text, start, end) {
		if (typeof end === 'undefined') {
			end = start + text.length;
		} else if (end - start !== text.length) {
			return false;
		}
		if (end >= codeLen)
			return false;
		return code.substring(start,end).toLowerCase() === text;
	}

	var codeLen = code.length;
	var state = Init;
	for (var i=0; i<codeLen; i++) {
		var c = code[i];
		switch (state) {
			case Init:
			while (c !== '<' && i<codeLen) c = code[++i]; 
			if (c === '<') {
				state = OpenTag;
				isCloseTag = false;
				isSelfClosingTag = false;
				startOfAttrName = endOfAttrName = -1;
			}
			break; // else stay in Init

			case OpenTag:
			switch (c) {
				case '/':
					isCloseTag = true;
					break; // stay in OpenTag
				case ' ':
				case '\r':
				case '\n':
				case '\t':
				case '\v':
					break; // stay in OpenTag
				case '>':
					state = Init; // error tolerance: <>, </>, etc
					break;
				default:
					startOfTagName = i;
					state = InsideTagName;
					break;
			}
			break;

			case InsideTagName:
			switch (c) {
				case ' ':
				case '\r':
				case '\n':
				case '\t':
				case '\v':
					endOfTagName = i;
					onFinishTagName();
					state = BetweenAttributes;
					break;
				case '>':
					endOfTagName = i;
					onFinishTagName();
					onFinishTag(i);
					state = enterTagBody();
					break;
				case '/':
					onFinishTagName();
					isSelfClosingTag = true;
					state = BetweenAttributes;
					break;
				case '-': // check for html comment: <!-- 
					if (match('!-',startOfTagName,i)) {
						state = InsideComment;
					}
					break;
				case '[': // check for CDATA section: <![CDATA[
					if (match('![cdata',startOfTagName,i)) {
						state = InsideCData;
					}
					break;
				default:
					break;
			}
			break;

			case BetweenAttributes: // note: state also used in case space between attr name and equals
			switch (c) {
				case ' ':
				case '\r':
				case '\n':
				case '\t':
				case '\v':
					break;
				case '>':
					onFinishTag(i);
					state = enterTagBody();
					break;
				case '/':
					isSelfClosingTag = true;
					break;
				case '=':
					if (endOfAttrName !== -1) {
						state = BeforeAttrValue; // whitespace separated attribute name from '=' symbol
					}
					break; // ignore if no attribute name preceeded us
				default:
					startOfAttrName = i;
					state = InsideAttrName;
					break;
			}
			break;

			case InsideAttrName:
			switch (c) {
				case ' ':
				case '\r':
				case '\n':
				case '\t':
				case '\v':
					state = BetweenAttributes;
					break;
				case '>':
					onFinishTag(i); // note: we discard this attribute, because we don't care about no-value attributes
					state = enterTagBody();
					break;
				case '/':
					isSelfClosingTag = true;
					state = BetweenAttributes;
					break;
				case '=':
					endOfAttrName = i;
					state = BeforeAttrValue;
				default:
					break;
			}
			break;

			case BeforeAttrValue:
			switch (c) {
				case ' ':
				case '\r':
				case '\n':
				case '\t':
				case '\v':
					break;
				case '>':
					onFinishTag(i); // note: we discard this attribute, because we don't care about no-value attributes
					state = enterTagBody();
					break;
				case '/':
					startOfAttrValue = i;
					state = InsideAttrValue;
					break;
				case '=':
					break; // multiple '=' signs
				case '"':
				case '\'':
					quote = c;
					startOfAttrValue = i+1;
					state = InsideQuotedAttrValue;
					break;
				default:
					startOfAttrValue = i;
					state = InsideAttrValue;
					break;
			}
			break;

			case InsideAttrValue:
			switch (c) {
				case ' ':
				case '\r':
				case '\n':
				case '\t':
				case '\v':
					endOfAttrValue = i;
					onFinishAttr();
					state = BetweenAttributes;
					break;
				case '>':
					if (code[i-1] === '/') {
						isSelfClosingTag = true;
						endOfAttrValue = i-1;
					} else {
						endOfAttrValue = i;
					}
					onFinishAttr();
					onFinishTag(i);
					state = enterTagBody();
					break;
				case '/': // handle '/' as regular attribute value
				default:
					break;

			}
			break;

			case InsideQuotedAttrValue:
			while (c !== quote && i<codeLen) c = code[++i]; 
			if (c === quote) {
				endOfAttrValue = i;
				onFinishAttr();
				state = BetweenAttributes;
			}
			break;

			case InsideScriptTag: // TODO: detect CDATA trick and comment trick
			while (c !== '<' && i<codeLen) c = code[++i]; 
			if (c === '<') {
				if (match('/script', i+1) && !isTagChar(code[i+8])) {
					endOfScriptBody = i;
					onFinishScript();
					i = i+7;
					isCloseTag = true;
					state = InsideTagName;
				}
			}
			break;

			case InsideStyleTag:
			while (c !== '<' && i<codeLen) c = code[++i]; 
			if (c === '<') {
				if (match('/style', i+1) && !isTagChar(code[i+7])) {
					i = i+6;
					isCloseTag = true;
					state = InsideTagName;
				}
			}
			break;

			case InsideComment:
			while (c !== '>' && i<codeLen) c = code[++i]; 
			if (c === '>') { // end of comment: -->
				// take care not to match <!--> and <!---> (but <!----> is ok) (TODO check with browser)
				if (i - startOfTagName > 3 && code[i-1] === '-' && code[i-2] === '-') {
					state = Init;
				}
			}
			break;

			case InsideCData:
			while (c !== '>' && i<codeLen) c = code[++i]; 
			if (c === '>') {
				if (match(']]',i-2)) {
					state = Init;
				}
			}
			break;
		}
	}
	// end of code; check if we are in an unfinished script tag
	if (state === InsideScriptTag) {
		endOfScriptBody = codeLen;
		onFinishScript();
	}
	
	var scriptTagIsJavaScript;
	var startOfScriptSrc;
	var endOfScriptSrc

	function enterTagBody() {
		if (isScriptTag) {
			return InsideScriptTag;
		}
		if (match('style', startOfTagName, endOfTagName) && !isCloseTag && !isSelfClosingTag) {
			return InsideStyleTag
		}
		return Init;
	}

	function onFinishTagName() {
		if (isCloseTag)
			return;
		isScriptTag = match('script', startOfTagName, endOfTagName);
		startOfScriptSrc = endOfScriptSrc = -1;
		scriptTagIsJavaScript = true;
	}

	function onFinishAttr() {
		if (isScriptTag) {
			if (match('type', startOfAttrName, endOfAttrName)) {
				var type = code.substring(startOfAttrValue, endOfAttrValue);
				if (!/javascript/i.test(type) && !/ecmascript/i.test(type)) {
					scriptTagIsJavaScript = false;
				}
			}
			else if (match('src', startOfAttrName, endOfAttrName)) {
				startOfScriptSrc = startOfAttrValue;
				endOfScriptSrc = endOfAttrValue;
			}
		}
		tryEventHandler();
		tryHrefJavaScript();
	}

	function onFinishTag(i) {
		if (isScriptTag) {
			startOfScriptBody = i+1;
		}
	}

	function onFinishScript() {
		tryScript();
		isScriptTag = false;
	}

	function tryScript() {
		if (!scriptTagIsJavaScript)
			return;
		if (startOfScriptSrc !== -1) {
			outputJavaScript({
				type: "extern",
				href: {
					start: startOfScriptSrc,
					end: endOfScriptSrc
				}
			})
		} else {
			outputJavaScript({
				type: "script",
				code: {
					start: startOfScriptBody,
					end: endOfScriptBody
				}
			})
		}
	}
	
	function tryEventHandler() {
		if (!match('on', startOfAttrName))
			return;
		outputJavaScript({
			type: "event",
			code: {
				start: startOfAttrValue,
				end: endOfAttrValue
			},
			attr: {
				start: startOfAttrName,
				end: endOfAttrName,
			},
			tag: {
				start: startOfTagName,
				end: endOfTagName
			}
		});
	}

	function tryHrefJavaScript() {
		if (!match('a', startOfTagName, endOfTagName))
			return;
		if (!match('href', startOfAttrName, endOfAttrName))
			return;
		if (!match('javascript:', startOfAttrValue)) // TODO: detect whitespace?
			return;
		outputJavaScript({
			type: "href",
			code: {
				start: startOfAttrValue+11,
				end: endOfAttrValue
			}
		});
	}

	function outputJavaScript(obj) {
		result.push(obj);
	}

	return result;
};
    
})); // end of UMD

