// Unification-Based Type Inference for JavaScript
// ===============================================

(function (root, factory) { // Universal Module Definition (https://github.com/umdjs/umd)
    if (typeof exports === 'object') {
        module.exports = factory(require('./map'), require('./lib/esprima'), require('./htmljs'), require('./lineoffsets'));
    } else if (typeof define === 'function' && define.amd) {
        define(['./map', './lib/esprima', './htmljs', './lineoffsets'], factory);
    } else {
        root.JavaScriptBuffer = factory(root.Map, root.esprima, root.htmljs, root.LineOffsets);
    }
}(this, function (Map, esprima, htmljs, LineOffsets) {

// Ast Manipulation
// ----------------
// To simplify our work with ASTs, we define the following utility functions.
// First, to enable generic AST traversal, we define a function to get the list of
// children of an AST node.
// We use the convention that any property starting with `$` should not be considered a child node.
function children(node) {
    var result = [];
    for (var k in node) {
        if (!node.hasOwnProperty(k))
            continue;
        if (k[0] === '$')
            continue;
        var val = node[k];
        if (!val)
            continue;
        if (typeof val === "object" && typeof val.type === "string") {
            result.push(val);
        }
        else if (val instanceof Array) {
            for (var i=0; i<val.length; i++) {
                var elm = val[i];
                if (typeof elm === "object" && typeof elm.type === "string") {
                    result.push(elm);
                }
            }
        } 
    }
    return result;
}

// We inject parent pointers into every node. Pointer pointers let refer directly to AST nodes
// without needing to piggy-back a lot of contextual information.
// I once did the refactoring logic without parent pointers, and it wasn't pretty. Parent pointers are good.
function injectParentPointers(node, parent) {
    node.$parent = parent;
    var list = children(node);
    for (var i=0; i<list.length; i++) {
        injectParentPointers(list[i], node);
    }
}

function getEnclosingFunction(node) {
    while  (node.type !== 'FunctionDeclaration' && 
            node.type !== 'FunctionExpression' && 
            node.type !== 'Program') {
        node = node.$parent;
    }
    return node;
}

// We annotate each scope with the set of variables they declare.
function buildEnvs(node, scope) {
    if (node.type === 'Program') {
        scope = node;
        scope.$env = new Map;
    }
    switch (node.type) {
        case 'FunctionDeclaration':
        case 'FunctionExpression':
            if (node.type == 'FunctionDeclaration') {
                scope.$env.put(node.id.name, node.id);
            }
            scope = node;
            node.$env = new Map;
            for (var i=0; i<node.params.length; i++) {
                scope.$env.put(node.params[i].name, node.params[i]);
            }
            node.$env.put("arguments", node);
            break;
        case 'VariableDeclarator':
            scope.$env.put(node.id.name, node.id);
            break;
        case 'CatchClause':
            node.$env = new Map;
            node.$env.put(node.param.name, node.id);
            break;
    }
    var list = children(node);
    for (var i=0; i<list.length; i++) {
        buildEnvs(list[i], scope);
    }
}

function getVarDeclScope(node) {
    var name = node.name;
    var prev = node;
    node = node.$parent;
    while (node) {
        switch (node.type) {
            case 'Program':
                return node;
            case 'FunctionDeclaration':
                if (prev !== node.id && node.$env.has(name))
                    return node;
                break;
            case 'FunctionExpression':
            case 'CatchClause':
                if (node.$env.has(name))
                    return node;
                break;
        }
        prev = node;
        node = node.$parent;
    }
    return null;
}


// `findNode` finds an AST node from an absolute source file position. More precisely, it finds the
// deepest nested node whose range contains the given position. It lets us find the identifier token
// under the user's curser when the refactoring is initiated.
//
// We use a `ProgramCollection` node as a common root element for all ASTs, and we add the `$file` and `$offset`
// fields to the Program node. The following should be seen as an extension to the 
// [Mozilla Parser API](https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API):
//
//       interface ProgramCollection {
//           programs : [Program]
//       }
//       interface Program {
//           ...
//           $file: string
//           $offset: {start: int, end: int}
//       }
//
function inRange(range, x) {
    return range[0] <= x && x <= range[1];
}

function findNode(node, file, offset) {
    if (node.$file && node.$file !== file)
        return null;
    if (node.$offset) {
        if (node.$offset.start > offset || node.$offset.end < offset)
            return null;
        offset -= node.$offset.start; // make relative to esprima ranges
    }
    if (node.range && !inRange(node.range, offset)) {
        return null;
    }
    var list = children(node);
    for (var i=0; i<list.length; i++) {
        var r = findNode(list[i], file, offset)
        if (r !== null)
            return r;
    }
    return node;
}


// Types and Union-Find
// --------------------
// A `TypeNode` is a node in an augmented union-find data structure. Root nodes represent types.
// The `prty` field maps strings (property names) to type nodes.
// The `namespace` boolean denotes whether the type seems to be a namespace object.
// The `id` field is a unique identifier for each node.
var type_node_id = 0;
function TypeNode() {
    this.id = ++type_node_id;
    this.parent = this;
    this.rank = 0;
    this.prty = new Map;
    this.namespace = false;
}
/** Returns root node, and performs path compression */
TypeNode.prototype.rep = function() {
    if (this.parent != this) {
        this.parent = this.parent.rep();
    }
    return this.parent;
};
/** Returns type of the given property; creating it if necessary.
    Result will be a root node. */
TypeNode.prototype.getPrty = function(name) {
    if (typeof name !== "string")
        throw "Not a string: " + name;
    var map = this.rep().prty;
    var t = map.get(name);
    if (!t) {
        t = new TypeNode;
        map.put(name, t);
    }
    return t.rep();
}


// The `TypeUnifier` implements the unification procedure of the union-find algorithm.
// Calling `unify(x,y)` will unify x and y. The `prty` maps of x and y will be partially
// merged; the merging will be completed by calling the `complete` method.
function TypeUnifier() {
    this.queue = [];
}
TypeUnifier.prototype.unify = function(x,y) {
    x = x.rep();
    y = y.rep();
    if (x === y)
        return;
    if (x.rank < y.rank) {
        var z = x; // swap x,y so x has the highest rank
        x = y;
        y = z;
    } else if (x.rank === y.rank) {
        x.rank += 1;
    }
    y.parent = x;
    x.namespace |= y.namespace;
    var src = y.prty;
    var dst = x.prty;
    for (var k in src) {
        if (k[0] !== '$')
            continue;
        if (!src.hasOwnProperty(k))
            continue;
        if (dst.hasOwnProperty(k)) {
            this.unifyLater(src[k], dst[k]);
        } else {
            dst[k] = src[k];
        }
    }
    delete y.rank;
    delete y.prty;
    delete y.namespace;
};
TypeUnifier.prototype.unifyLater = function(x,y) {
    if (x != y) {
        this.queue.push(x);
        this.queue.push(y);
    }
};
TypeUnifier.prototype.complete = function() {
    var q = this.queue;
    while (q.length > 0) {
        var x = q.pop();
        var y = q.pop();
        this.unify(x,y);
    }
};

// Type Inference
// --------------
// The type inference procedure initially assumes all expressions have distinct
// types, and then unifies types based on a single traversal of the AST.
// There are a couple of utility functions we must establish before we do the traversal, though.
function inferTypes(asts) {
    var unifier = new TypeUnifier;

    var global = new TypeNode; // type of the global object

    // We maintain a stack of type maps to hold the types of local variables in the current scopes.
    // `env` always holds the top-most environment.
    var env = new Map;
    var envStack = [env]; 

    /** Get type of variable with the given name */
    function getVar(name) {
        for (var i=envStack.length-1; i>=0; i--) {
            var t = envStack[i].get(name);
            if (t)
                return t;
        }
        return global.getPrty(name);
    }
    
    /** Add variable to current environment. Used when entering a new scope. */
    function addVarToEnv(name) {
        if (typeof name !== "string")
            throw "Not a string: " + name;
        if (!env.has(name)) {
            env.put(name, new TypeNode);
        }
    }

    // We create type nodes on-demand and inject them into the AST using `getType` and `getEnv`.
    /* Type of the given expression. For convenience acts as identity on type nodes */
    function getType(node) {
        if (node instanceof TypeNode)
            return node;
        if (!node.$type_node) {
            node.$type_node = new TypeNode;
        }
        return node.$type_node;
    }
    /** Environment of the given scope node (function or catch clause) */
    function getEnv(scope) {
        return scope.$env_type || (scope.$env_type = new Map);
    }

    // We model the type of "this" using a fake local variable called `@this`.
    // The return type of a function is modeled with a variable called `@return`.
    function thisType(fun) {
        return getEnv(fun).get("@this");
    }
    function returnType(fun) {
        return getEnv(fun).get("@return");
    }
    function argumentType(fun, index) {
        if (index < fun.params.length) {
            return getEnv(fun).get(fun.params[index].name);
        } else {
            return new TypeNode;
        }
    }

    // The `unify` function takes a number of AST nodes and/or type nodes and unifies their types.
    // It will be used a lot during the AST traversal.
    function unify(x) {
        x = getType(x);
        for (var i=1; i<arguments.length; i++) {
            unifier.unify(x, getType(arguments[i]));
        }
    }

    // To properly infer the receiver type of methods, we need a way to distinguish methods
    // from constructors in namespaces. The following functions are called during the first traversal
    // to indicate potential methods, and what objects appear to be used as namespaces.
    var potentialMethods = []; // interleaved (base,receiver) pairs
    function addPotentialMethod(base, receiver) {
        potentialMethods.push(getType(base));
        potentialMethods.push(getType(receiver));
    }

    function markAsNamespace(node) {
        getType(node).rep().namespace = true;
    }
    function markAsConstructor(node) {
        if (node.type === "MemberExpression") {
            markAsNamespace(node.object);
        }
    }

    // We use these constants to avoid confusing boolean constants
    var Primitive = true; // returned to indicate expression was a primitive
    var NotPrimitive = false;

    var Void = true; // argument to indicate expression occurs in void context
    var NotVoid = false;

    var Expr = true; // argument to visitFunction to indicate it is an expression
    var NotExpr = false;

    // The AST traversal consists of three mutually recursive functions:
    //
    // - `visitStmt(node)`
    // - `visitExp(node, void_ctx)`.
    // - `visitFunction(fun, expr)`.
    function visitFunction(fun, expr) {
        fun.$env_type = env = new Map; // create new environment
        envStack.push(env);
        for (var i=0; i<fun.params.length; i++) {
            addVarToEnv(fun.params[i].name); // add params to env
            fun.params[i].$type_node = env.get(fun.params[i].name);
        }
        fun.$env.forEach(function (key,val) {
            addVarToEnv(key);
        });
        if (expr && fun.id !== null) {
            addVarToEnv(fun.id.name); // add self-reference to environment
            unify(fun, env.get(fun.id.name));
            fun.id.$type_node = fun.$type_node;
        }
        addVarToEnv("@this");
        addVarToEnv("@return");
        addVarToEnv("arguments");
        unify(thisType(fun), getType(fun).getPrty("prototype"))
        visitStmt(fun.body); // visit function body
        envStack.pop(); // restore original environment
        env = envStack[envStack.length-1];
    }

    function visitExp(node, void_ctx) {
        if (typeof void_ctx !== "boolean")
            throw "No void_ctx given";
        if (node === null)
            return null;
        if (typeof node !== "object" || !node.type)
            throw new Error("visitExp not called with node: " + node);
        switch (node.type) {
            case "FunctionExpression":
                visitFunction(node, Expr);
                return NotPrimitive;
            case "ThisExpression":
                unify(node, getVar("@this"));
                return NotPrimitive;
            case "ArrayExpression":
                var typ = getType(node);
                for (var i=0; i<node.elements.length; i++) {
                    var elm = node.elements[i];
                    visitExp(elm, NotVoid);
                    unify(typ.getPrty("@array"), elm);
                }
                return NotPrimitive;
            case "ObjectExpression":
                var typ = getType(node);
                for (var i=0; i<node.properties.length; i++) {
                    var prty = node.properties[i];
                    var name;
                    if (prty.key.type === "Identifier") {
                        name = prty.key.name;
                    } else if (typeof prty.key.value === "string") {
                        name = prty.key.value;
                    } else {
                        continue;
                    }
                    switch (prty.kind) {
                        case "init":
                            visitExp(prty.value, NotVoid);
                            unify(typ.getPrty(name), prty.value);
                            if (prty.value.type === 'FunctionExpression') {
                                addPotentialMethod(typ, thisType(prty.value));
                            }
                            break;
                        case "get":
                            visitFunction(prty.value);
                            unify(typ.getPrty(name), returnType(prty.value));
                            unify(typ, thisType(prty.value));
                            break;
                        case "set":
                            visitFunction(prty.value);
                            unify(typ.getPrty(name), argumentType(prty.value, 0));
                            unify(typ, thisType(prty.value));
                            break;
                    }
                }
                return NotPrimitive;
            case "SequenceExpression":
                for (var i=0; i<node.expressions.length-1; i++) {
                    visitExp(node.expressions[i], Void);
                }
                var p = visitExp(node.expressions[node.expressions.length-1], void_ctx);
                unify(node, node.expressions[node.expressions.length-1]); // return value of last expression
                return p;
            case "UnaryExpression":
                visitExp(node.argument, Void);
                return Primitive;
            case "BinaryExpression":
                visitExp(node.left, Void);
                visitExp(node.right, Void);
                return Primitive;
            case "AssignmentExpression":
                if (typeof node.operator !== "string")
                    throw "node.operator" // TODO: debugging
                visitExp(node.left, NotVoid);
                var p = visitExp(node.right, NotVoid);
                if (node.operator === "=") {
                    if (!p) {
                        unify(node, node.left, node.right);
                    }
                    if (node.left.type === 'MemberExpression' && node.right.type === 'FunctionExpression') {
                        addPotentialMethod(node.left.object, thisType(node.right));
                    }
                    return p;
                } else {
                    return Primitive; // compound assignment operators
                }
            case "UpdateExpression":
                visitExp(node.argument, Void);
                return Primitive;
            case "LogicalExpression":
                if (node.operator === "&&") {
                    visitExp(node.left, Void);
                    var p2 = visitExp(node.right, void_ctx);
                    unify(node, node.right);
                    return p2;
                } else if (node.operator === "||") {
                    var p1 = visitExp(node.left, void_ctx);
                    var p2 = visitExp(node.right, void_ctx);
                    if (!void_ctx) {
                        unify(node, node.left, node.right);
                    }
                    return p1 && p2;
                }
            case "ConditionalExpression":
                visitExp(node.test, Void);
                var p1 = visitExp(node.consequent, void_ctx);
                var p2 = visitExp(node.alternate, void_ctx);
                if (!void_ctx) {
                    unify(node, node.consequent, node.alternate);
                }
                return p1 && p2;
            case "NewExpression":
            case "CallExpression":
                var args = node.arguments || [];
                visitExp(node.callee, NotVoid);
                for (var i=0; i<args.length; i++) {
                    visitExp(args[i], NotVoid);
                }
                if (node.callee.type === "FunctionExpression") {
                    var numArgs = Math.min(args.length, node.callee.params.length);
                    for (var i=0; i<numArgs; i++) {
                        unify(args[i], argumentType(node.callee, i));
                    }
                    unify(node, returnType(node.callee));
                    if (node.type === "NewExpression") {
                        unify(node, thisType(node.callee));
                    } else {
                        unify(global, thisType(node.callee));
                    }
                }
                if (node.type === "NewExpression") {
                    markAsConstructor(node.callee);
                }
                return NotPrimitive;
            case "MemberExpression":
                visitExp(node.object, NotVoid);
                if (node.computed) {
                    visitExp(node.property, Void);
                    if (node.property.type === "Literal" && typeof node.property.value === "string") {
                        unify(node, getType(node.object).getPrty(node.property.value));
                    } else {
                        unify(getType(node.property).getPrty("@prty-of"), node.object);
                    }
                } else {
                    unify(node, getType(node.object).getPrty(node.property.name));
                    if (node.property.name === "prototype") {
                        markAsConstructor(node.object);
                    }
                }
                return NotPrimitive;
            case "Identifier":
                if (node.name === "undefined") {
                    return Primitive;
                }
                unify(node, getVar(node.name));
                return NotPrimitive;
            case "Literal":
                return Primitive;
        }
        /* The cases must return Primitive or NotPrimitive */
        throw "Expression " + node.type + " not handled";
    }

    function visitStmt(node) {
        if (node === null)
            return;
        if (!node || !node.type)
            throw new Error("Not a statement node: " + node);
        switch (node.type) {
            case "EmptyStatement":
                break;
            case "BlockStatement":
                node.body.forEach(visitStmt);
                break;
            case "ExpressionStatement":
                visitExp(node.expression, Void);
                break;
            case "IfStatement":
                visitExp(node.test, Void);
                visitStmt(node.consequent);
                visitStmt(node.alternate);
                break;
            case "LabeledStatement":
                visitStmt(node.body);
                break;
            case "BreakStatement":
                break;
            case "ContinueStatement":
                break;
            case "WithStatement":
                visitExp(node.object, NotVoid);
                visitStmt(node.body);
                break;
            case "SwitchStatement":
                var pr = visitExp(node.discriminant, NotVoid);
                for (var i=0; i<node.cases.length; i++) {
                    var caze = node.cases[i];
                    visitExp(caze.test, pr ? Void : NotVoid);
                    caze.consequent.forEach(visitStmt);
                }
                break;
            case "ReturnStatement":
                if (node.argument !== null) {
                    visitExp(node.argument, NotVoid);
                    unify(node.argument, getVar("@return"));
                }
                break;
            case "ThrowStatement":
                visitExp(node.argument, Void);
                break;
            case "TryStatement":
                visitStmt(node.block);
                node.handlers.forEach(visitStmt);
                node.guardedHandlers.forEach(visitStmt);
                visitStmt(node.finalizer);
                break;
            case "CatchClause":
                node.$env_type = env = new Map; // create environment with exception var
                envStack.push(env);
                addVarToEnv(node.param.name);
                visitStmt(node.body);
                envStack.pop(); // restore original environment
                env = envStack[envStack.length-1];
                break;
            case "WhileStatement":
                visitExp(node.test, Void);
                visitStmt(node.body);
                break;
            case "DoWhileStatement":
                visitStmt(node.body);
                visitExp(node.test, Void);
                break;
            case "ForStatement":
                if (node.init !== null && node.init.type === "VariableDeclaration") {
                    visitStmt(node.init);
                } else {
                    visitExp(node.init, Void);
                }
                visitExp(node.test, Void);
                visitExp(node.update, Void);
                visitStmt(node.body);
                break;
            case "ForInStatement":
                if (node.left.type === "VariableDeclaration") {
                    visitStmt(node.left);
                } else {
                    visitExp(node.left, Void);
                }
                visitExp(node.right, NotVoid);
                visitStmt(node.body);
                /* note: `each` is always false in Esprima */
                break;
            case "DebuggerStatement":
                break;
            case "FunctionDeclaration":
                visitFunction(node);
                unify(node, getVar(node.id.name)); // put function into its variable
                break;
            case "VariableDeclaration":
                for (var i=0; i<node.declarations.length; i++) {
                    var decl = node.declarations[i];
                    if (decl.init !== null) {
                        var pr = visitExp(decl.init, NotVoid);
                        if (!pr) {
                            unify(getVar(decl.id.name), decl.init)
                        }
                    }
                    decl.id.$type_node = getVar(decl.id.name);
                }
                break;
            default:
                throw "Unknown statement: " + node.type;
        }
    }

    // We start the AST traversal with a call to visitRoot
    function visitRoot(node) {
        switch (node.type) {
            case 'Program':
                node.body.forEach(visitStmt);
                break;
            case 'ProgramCollection':
                node.programs.forEach(visitRoot);
                break;
        }
    }

    visitRoot(asts);

    // After the initial traversal, we satisfy the saturation rules to ensure we have detected namespaces.
    // Then we apply receiver-type inference and complete the unification again.
    unifier.complete();
    for (var i=0; i<potentialMethods.length; i += 2) {
        var base = potentialMethods[i].rep();
        var receiver = potentialMethods[i+1].rep();
        if (!base.namespace && !receiver.namespace) {
            /* unify later to ensure deterministic behaviour */
            unifier.unifyLater(base, receiver); 
        }
    }
    unifier.complete();

    asts.global = global; // expose global object type
} /* end of inferTypes */

// Renaming Identifiers
// --------------------
// `classifyId` classifies an identifier token as a property, variable, or label.
// Property identifiers additionally have a *base* expression, denoting the object on
// which the property is accessed. Variables may be global or local.
function classifyId(node) {
    if (node.type != 'Identifier' && (node.type !== 'Literal' || typeof node.value !== 'string'))
        return null; // only identifiers and string literals can be IDs
    var parent = node.$parent;
    switch (parent.type) {
        case 'MemberExpression':
            if (!parent.computed && parent.property === node && node.type === 'Identifier') {
                return {type:"property", base:parent.object, name:node.name};
            } else if (parent.computed && parent.property === node && node.type === 'Literal') {
                return {type:"property", base:parent.object, name:node.value};
            }
            break;
        case 'Property':
            if (parent.key === node) {
                if (node.type === 'Identifier') {
                    return {type:"property", base:parent.$parent, name:node.name};
                } else if (node.type === 'Literal') {
                    return {type:"property", base:parent.$parent, name:node.value};
                }
            }
            break;
        case 'BreakStatement':
        case 'ContinueStatement':
            if (parent.label === node) {
                return {type:"label", name:node.name};
            }
            break;
        case 'LabeledStatement':
            if (parent.label === node) {
                return {type:"label", name:node.name};
            }
            break;
    }
    if (node.type === 'Identifier')
        return {type:"variable", name:node.name};
    else
        return null;
}

// To rename an identifier given some position, we find the identifier token, classify it, and then dispatch
// to the proper renaming function (defined below).
function computeRenaming(ast, file, offset) {
    var node = findNode(ast, file, offset)
    if (node === null)
        return null;
    var idClass = classifyId(node);
    if (idClass === null)
        return null;
    var groups;
    switch (idClass.type) {
        case 'variable':
            var scope = getVarDeclScope(node);
            if (scope.type === 'Program') {
                inferTypes(ast);
                groups = computeGlobalVariableRenaming(ast, node.name);
            } else {
                groups = computeLocalVariableRenaming(scope, node.name);
            }
            break;
        case 'label':
            groups = computeLabelRenaming(node);
            break;
        case 'property':
            inferTypes(ast);
            if (idClass.base.$type_node.rep() === ast.global.rep()) {
                groups = computeGlobalVariableRenaming(ast, node.name);
            } else {
                groups = computePropertyRenaming(ast, node.name);
            }
            break;
        default: throw new Error("unknown id class: " + idClass.type);
    }
    return groups;
}

// `computeRenamingGroupsForName` computes the groups for a given property name. The token
// selected by the user is not an input, because the concrete token chosen does not influence
// the choice of renaming groups.
function computePropertyRenaming(ast, name) {
    var group2members = {};
    var global = ast.global.rep().id;
    function add(base, id) {
        var key = base.$type_node.rep().id;
        if (key === global)
            return; // global variables are kept separate
        if (!group2members[key]) {
            group2members[key] = [];
        }
        group2members[key].push(id);
    }
    function visit(node) {
        var clazz = classifyId(node);
        if (clazz !== null && clazz.type === 'property' && clazz.name === name) {
            add(clazz.base, node);
        }
        children(node).forEach(visit);
    }
    visit(ast);
    var groups = [];
    for (var k in group2members) {
        if (!group2members.hasOwnProperty(k))
            continue;
        groups.push(group2members[k]);
    }
    return groups;
}

function reorderGroupsStartingAt(groups, file, offset) {
    function compare(x,y) {
        if (x.file !== y.file) {
            if (x.file === file)
                return -1;
            if (y.file === file)
                return 1;
            return x.file < y.file ? -1 : 1;
        }
        if (x.file === file) { // start search from offset when in the target file
            if (x.end.offset < offset && y.end.offset >= offset)
                return 1
            if (x.end.offset >= offset && y.end.offset < offset)
                return -1
        }
        return x.start.offset - y.start.offset;
    }
    function compareGroups(x,y) {
        return compare(x[0], y[0])
    }
    groups.forEach(function(x) { return x.sort(compare) })
    groups.sort(compareGroups)
}

// To rename labels, we find its declaration (if any) and then search its scope for possible references.
function getLabelDecl(node) {
    var name = node.name;
    while (node && (node.type !== 'LabeledStatement' || node.label.name !== name)) {
        node = node.$parent;
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression')
            return null;
    }
    return node || null;
}
function computeLabelRenaming(node) {
    var name = node.name;
    var decl = getLabelDecl(node);
    var result;
    function visit(node) {
        switch (node.type) {
            case 'LabeledStatement':
                if (node.label.name === name)
                    return; // shadowed label
                break;
            case 'FunctionDeclaration':
            case 'FunctionExpression':
                return; // labels don't propagte inside functions
            case 'BreakStatement':
            case 'ContinueStatement':
                if (node.label !== null && node.label.name === name)
                    result.push(node.label);
                break;
        }
        children(node).forEach(visit);
    }
    var search;
    if (decl === null) { // gracefully handle error case where label was undeclared
        result = [];
        search = getEnclosingFunction(node);
    } else {
        result = [decl.label];
        search = decl.body;
    }
    visit(search);
    return [result]
}

// To rename global variables, we enumerate all ASTs looking for direct references as well as indirect ones through
// the global object (i.e. `window.foo`). 
// Somewhat optimistically, we assume that the user wants to rename the both types of references.
function computeGlobalVariableRenaming(ast, name) {
    var ids = [];
    var global = ast.global.rep();
    function visit(node, shadowed) {
        switch (node.type) {
            case 'Identifier':
            case 'Literal':
                var clazz = classifyId(node);
                if (clazz !== null && clazz.name === name) {
                    if (clazz.type === 'variable' && !shadowed) {
                        ids.push(node);
                    } else if (clazz.type === 'property' && clazz.base.$type_node.rep() === global) {
                        ids.push(node);
                    }
                }
                break;
            case 'FunctionDeclaration':
            case 'FunctionExpression':
            case 'CatchClause':
                if (node.$env.has(name)) {
                    if (!shadowed && node.type === 'FunctionDeclaration' && node.id.name === name) {
                        ids.push(node.id); // name belongs to outer scope
                    }
                    shadowed = true;
                }
                break;
        }
        var list = children(node);
        for (var i=0; i<list.length; i++) {
            visit(list[i], shadowed);
        }
    }
    visit(ast, false);
    return [ids];
}

// To rename local variables, we search its scope for references and cut off the search if the
// variable gets shadowed.
// We choose to ignore with statements because their use is frowned upon and seldom seen in practice;
// they just don't seem worth the trouble.
function computeLocalVariableRenaming(scope, name) {
    var ids = [];
    function visit(node) {
        switch (node.type) {
            case 'Identifier':
                if (node.name === name && classifyId(node).type === 'variable') {
                    ids.push(node);
                }
                break;
            case 'FunctionDeclaration':
            case 'FunctionExpression':
            case 'CatchClause':
                if (node !== scope && node.$env.has(name)) { // shadowed?
                    if (node.type === 'FunctionDeclaration' && node.id.name === name) {
                        ids.push(node.id); // belongs to outer scope, hence not shadowed 
                    }
                    return;
                }
                break;
        }
        children(node).forEach(visit);
    }
    if (scope.type === 'FunctionDeclaration') { // function decls name is not part of its own scope
        scope.params.forEach(visit) 
        visit(scope.body)
    } else {
        visit(scope)
    }
    return [ids];
}

// Public API
// -----------------------------------------------
// `JavaScriptBuffer` provides an AST-agnostic interface that deals with abstract file names
// and source code offsets instead of node pointers. Abstract file names are strings used to
// uniquely identify a script loaded into the buffer; they need not be paths in any file system.
// We use the following two types to describe ranges in the source code.
//
//     type Range = { range:int[2], 
//                    loc: { start:Loc, 
//                           end:Loc }}
//     type Loc = {line:int, column:int}
// 
function JavaScriptBuffer() {
    this.asts = {type:'ProgramCollection', programs:[]};
}

/**  Adds a file to this buffer. 
     `file` can be any string unique to this file, typically derived from the file name.
     Files with the same `global_id` share the same global object. */
JavaScriptBuffer.prototype.add = function(file, source_code, options) {
    options = options || {}
    var global_id = options.global_id || "default";
    var type = options.type || "js";
    function makeAST(code, offset) {
        var ast = esprima.parse(code, {range:true, tolerant:true, loc:true});
        ast.$file = file;
        ast.$offset = offset;
        ast.$global_id = global_id;
        injectParentPointers(ast);
        buildEnvs(ast);
        return ast
    }
    switch (type) {
        case "html":
            console.log("html")
            var fragments = htmljs(source_code)
            var lineOffsets = new LineOffsets(source_code)
            for (var i=0; i<fragments.length; i++) {
                var frag = fragments[i]
                if (frag.type === 'extern')
                    continue; // externs have no code
                var linePos = lineOffsets.position(frag.code.start)
                var offsets = {
                    start: frag.code.start,
                    end: frag.code.end,
                    line: linePos.line,
                    column: linePos.column
                }
                var ast = makeAST(source_code.substring(frag.code.start, frag.code.end), offsets)
                this.asts.programs.push(ast)
            }
            break;
        case "js":
            var ast = makeAST(source_code, {start:0, end:source_code.length, line:0, column:0})
            this.asts.programs.push(ast);
            break;
        default:
            throw new Error("Unrecognised type: " + type + ". Use html or js.");
    }
};

/** If true, renaming the identifier at the given offset does not affect other files */
JavaScriptBuffer.prototype.canRenameLocally = function(file, offset) {
    var c = this.classify(file,offset);
    return c === 'local' || c === 'label';
};

/** Returns "local", "global", "property", or "label" or null.
    For non-null return values, the identifier at the given offset can be renamed */
JavaScriptBuffer.prototype.classify = function(file, offset) {
    var node = findNode(this.asts, file, offset)
    if (node === null)
        return null;
    var clazz = classifyId(node);
    if (clazz === null)
        return null;
    switch (clazz.type) {
        case "variable": return getVarDeclScope(node).type === 'Program' ? "global" : "local";
        case "property": return "property";
        case "label": return "label";
    }
};

/** Returns null or a Range[][] object where each Range[] is a group of tokens that are related,
    and Range denotes the type {0:<start>, 1:<end>}. */
JavaScriptBuffer.prototype.renameTokenAt = function(file,offset) {
    var list = computeRenaming(this.asts, file, offset);
    if (list === null)
        return null
    list.forEach(identifiersToRanges);
    reorderGroupsStartingAt(list, file, offset);
    return list;
};

JavaScriptBuffer.prototype.renamePropertyName = function(name) {
    inferTypes(this.asts);
    var list = computePropertyRenaming(this.asts, name);
    if (list === null)
        return null
    list.forEach(identifiersToRanges);
    reorderGroupsStartingAt(list, null, null);
    return list;
};

/** Removes all contents of the buffer */
JavaScriptBuffer.prototype.clear = function() {
    this.asts.programs = [];
};
    
function getNodeFile(node) {
    while (node && !node.$file) {
        node = node.$parent;
    }
    return node && node.$file;
}
function getProgram(node) {
    while (node.type !== 'Program') {
        node = node.$parent;
    }
    return node;
}
function identifierRange(node) {
    var prog = getProgram(node);
    var delta = node.type === 'Literal' ? 1 : 0; // skip quote
    var offset = prog.$offset.start;
    var lineOffset = prog.$offset.line;
    var columnOffset = node.loc.start.line === 1 ? prog.$offset.column : 0;
    return {
        file: prog.$file,
        start: {
            offset: node.range[0] + delta + offset,
            line: node.loc.start.line - 1 + lineOffset,
            column: node.loc.start.column + delta + columnOffset
        },
        end : {
            offset: node.range[1] - delta + offset,
            line: node.loc.end.line - 1 + lineOffset,
            column: node.loc.end.column - delta + columnOffset
        }
    };
}
function identifiersToRanges(list) {
    for (var i=0; i<list.length; i++) {
        list[i] = identifierRange(list[i]);
    }
}
    
return JavaScriptBuffer

})); // end of UMD

