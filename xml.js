/*
	JavaScript XML Library
	Plus a bunch of object utility functions
	
	Usage:
		var XML = require('pixl-xml');
		var myxmlstring = '<?xml version="1.0"?><Document>' + 
			'<Simple>Hello</Simple>' + 
			'<Node Key="Value">Content</Node>' + 
			'</Document>';
		
		var tree = XML.parse( myxmlstring, { preserveAttributes: true });
		console.log( tree );
		
		tree.Simple = "Hello2";
		tree.Node._Attribs.Key = "Value2";
		tree.Node._Data = "Content2";
		tree.New = "I added this";
		
		console.log( XML.stringify( tree, 'Document' ) );
	
	Copyright (c) 2004 - 2015 Joseph Huckaby
	Released under the MIT License
	This version is for Node.JS, converted in 2012.

	This version is more universal converted in 2022
*/

const xml_header = '<?xml version="1.0"?>';
const re_valid_tag_name = /^\w[\w\-:.]*$/;

export class XML {
    preserveDocumentNode = false;
    preserveAttributes = false;
    preserveWhitespace = false;
    lowerCase = false;
    forceArrays = false;

    patTag = /([^<]*?)<([^>]+)>/g;
    patSpecialTag = /^\s*([!?])/;
    patPITag = /^\s*\?/;
    patCommentTag = /^\s*!--/;
    patDTDTag = /^\s*!DOCTYPE/;
    patCDATATag = /^\s*!\s*\[\s*CDATA/;
    patStandardTag = /^\s*(\/?)([\w\-:.]+)\s*([\s\S]*)$/;
    patSelfClosing = /\/\s*$/;
    patAttrib = new RegExp("([\\w\\-\:\.]+)\\s*=\\s*([\\\"\\'])([^\\2]*?)\\2", "g");
    patPINode = /^\s*\?\s*([\w\-:]+)\s*(.*)$/;
    patEndComment = /--$/;
    patNextClose = /([^>]*?)>/g;
    patExternalDTDNode = new RegExp("^\\s*\!DOCTYPE\\s+([\\w\\-\:]+)\\s+(SYSTEM|PUBLIC)\\s+\\\"([^\\\"]+)\\\"");
    patInlineDTDNode = /^\s*!DOCTYPE\s+([\w\-:]+)\s+\[/;
    patEndDTD = /]$/;
    patDTDNode = /^\s*!DOCTYPE\s+([\w\-:]+)\s+\[(.*)]/;
    patEndCDATA = /]]$/;
    patCDATANode = /^\s*!\s*\[\s*CDATA\s*\[([^]*)]]/;

    attribsKey = '_Attribs';
    dataKey = '_Data';

    constructor(args, opts) {
        // class constructor for XML parser class
        // pass in args hash or text to parse
        if (!args) args = '';
        if (isaHash(args)) {
            for (let key in args) {
                this[key] = args[key];
            }
        } else {
            this.text = args || '';
        }

        // options may be 2nd argument as well
        if (opts) {
            for (let key in opts) {
                this[key] = opts[key];
            }
        }

        // stringify buffers
        if (this.text instanceof Buffer) {
            this.text = this.text.toString();
        }

        this.tree = {};
        this.errors = [];
        this.piNodeList = [];
        this.dtdNodeList = [];
        this.documentNodeName = '';

        if (this.lowerCase) {
            this.attribsKey = this.attribsKey.toLowerCase();
            this.dataKey = this.dataKey.toLowerCase();
        }

        this.patTag.lastIndex = 0;
        if (this.text) {
            this.parse();
        }
    }

    parse(branch, name) {
        // parse text into XML tree, recurse for nested nodes
        if (!branch) {
            branch = this.tree;
        }
        if (!name) {
            name = null;
        }
        let foundClosing = false;
        let matches = null;

        // match each tag, plus preceding text
        while (matches = this.patTag.exec(this.text)) {
            const before = matches[1];
            let tag = matches[2];

            // text leading up to tag = content of parent node
            if (before.match(/\S/)) {
                if (typeof (branch[this.dataKey]) != 'undefined') {
                    branch[this.dataKey] += ' ';
                } else {
                    branch[this.dataKey] = '';
                }
                branch[this.dataKey] += !this.preserveWhitespace ? trim(decodeEntities(before)) : decodeEntities(before);
            }

            // parse based on tag type
            if (tag.match(this.patSpecialTag)) {
                // special tag
                if (tag.match(this.patPITag)) {
                    tag = this.parsePINode(tag);
                } else if (tag.match(this.patCommentTag)) {
                    tag = this.parseCommentNode(tag);
                } else if (tag.match(this.patDTDTag)) {
                    tag = this.parseDTDNode(tag);
                } else if (tag.match(this.patCDATATag)) {
                    tag = this.parseCDATANode(tag);
                    if (typeof (branch[this.dataKey]) != 'undefined') {
                        branch[this.dataKey] += ' ';
                    } else {
                        branch[this.dataKey] = '';
                    }
                    branch[this.dataKey] += !this.preserveWhitespace ? trim(decodeEntities(tag)) : decodeEntities(tag);
                } // cdata
                else {
                    this.throwParseError("Malformed special tag", tag);
                    break;
                } // error
                if (tag == null) {
                    break;
                }
            } // special tag
            else {
                // Tag is standard, so parse name and attributes (if any)
                let matches = tag.match(this.patStandardTag);
                if (!matches) {
                    this.throwParseError("Malformed tag", tag);
                    break;
                }

                const closing = matches[1];
                const nodeName = this.lowerCase ? matches[2].toLowerCase() : matches[2];
                const attribsRaw = matches[3];

                // If this is a closing tag, make sure it matches its opening tag
                if (closing) {
                    if (nodeName === (name || '')) {
                        foundClosing = 1;
                        break;
                    } else {
                        this.throwParseError("Mismatched closing tag (expected </" + name + ">)", tag);
                        break;
                    }
                } // closing tag
                else {
                    // Not a closing tag, so parse attributes into hash.  If tag
                    // is self-closing, no recursive parsing is needed.
                    const selfClosing = !!attribsRaw.match(this.patSelfClosing);
                    let leaf = {};
                    let attribs = leaf;

                    // preserve attributes means they go into a sub-hash named "_Attribs"
                    // the XML composer honors this for restoring the tree back into XML
                    if (this.preserveAttributes) {
                        leaf[this.attribsKey] = {};
                        attribs = leaf[this.attribsKey];
                    }

                    // parse attributes
                    this.patAttrib.lastIndex = 0;
                    while (matches = this.patAttrib.exec(attribsRaw)) {
                        const key = this.lowerCase ? matches[1].toLowerCase() : matches[1];
                        attribs[key] = decodeEntities(matches[3]);
                    } // foreach attrib

                    // if no attribs found, but we created the _Attribs subhash, clean it up now
                    if (this.preserveAttributes && !numKeys(attribs)) {
                        delete leaf[this.attribsKey];
                    }

                    // Recurse for nested nodes
                    if (!selfClosing) {
                        this.parse(leaf, nodeName);
                        if (this.error()) break;
                    }

                    // Compress into simple node if text only
                    const num_leaf_keys = numKeys(leaf);
                    if ((typeof (leaf[this.dataKey]) != 'undefined') && (num_leaf_keys === 1)) {
                        leaf = leaf[this.dataKey];
                    } else if (!num_leaf_keys) {
                        leaf = '';
                    }

                    // Add leaf to parent branch
                    if (typeof (branch[nodeName]) != 'undefined') {
                        if (isaArray(branch[nodeName])) {
                            branch[nodeName].push(leaf);
                        } else {
                            const temp = branch[nodeName];
                            branch[nodeName] = [temp, leaf];
                        }
                    } else if (this.forceArrays && (branch !== this.tree)) {
                        branch[nodeName] = [leaf];
                    } else {
                        branch[nodeName] = leaf;
                    }

                    if (this.error() || (branch === this.tree)) break;
                } // not closing
            } // standard tag
        } // main reg exp

        // Make sure we found the closing tag
        if (name && !foundClosing) {
            this.throwParseError("Missing closing tag (expected </" + name + ">)", name);
        }

        // If we are the master node, finish parsing and setup our doc node
        if (branch === this.tree) {
            if (typeof (this.tree[this.dataKey]) != 'undefined') {
                delete this.tree[this.dataKey];
            }

            if (numKeys(this.tree) > 1) {
                this.throwParseError('Only one top-level node is allowed in document', firstKey(this.tree));
                return;
            }

            this.documentNodeName = firstKey(this.tree);
            if (this.documentNodeName && !this.preserveDocumentNode) {
                this.tree = this.tree[this.documentNodeName];
            }
        }
    }

    throwParseError(key, tag) {
        // log error and locate current line number in source XML document
        const parsedSource = this.text.substring(0, this.patTag.lastIndex);
        const eolMatch = parsedSource.match(/\n/g);
        let lineNum = (eolMatch ? eolMatch.length : 0) + 1;
        lineNum -= tag.match(/\n/) ? tag.match(/\n/g).length : 0;

        this.errors.push({
            type: 'Parse',
            key: key,
            text: '<' + tag + '>',
            line: lineNum
        });

        // Throw actual error (must wrap parse in try/catch)
        throw new Error(this.getLastError());
    }

    error() {
        // return number of errors
        return this.errors.length;
    }

    getError(error) {
        // get formatted error
        let text = '';
        if (!error) return '';

        text = (error.type || 'General') + ' Error';
        if (error.code) text += ' ' + error.code;
        text += ': ' + error.key;

        if (error.line) text += ' on line ' + error.line;
        if (error.text) text += ': ' + error.text;

        return text;
    }

    getLastError() {
        // Get most recently thrown error in plain text format
        if (!this.error()) {
            return '';
        }
        return this.getError(this.errors[this.errors.length - 1]);
    }

    parsePINode(tag) {
        // Parse Processor Instruction Node, e.g. <?xml version="1.0"?>
        if (!tag.match(this.patPINode)) {
            this.throwParseError("Malformed processor instruction", tag);
            return null;
        }

        this.piNodeList.push(tag);
        return tag;
    }

    parseCommentNode(tag) {
        // Parse Comment Node, e.g. <!-- hello -->
        let matches = null;
        this.patNextClose.lastIndex = this.patTag.lastIndex;

        while (!tag.match(this.patEndComment)) {
            if (matches = this.patNextClose.exec(this.text)) {
                tag += '>' + matches[1];
            } else {
                this.throwParseError("Unclosed comment tag", tag);
                return null;
            }
        }
        this.patTag.lastIndex = this.patNextClose.lastIndex;
        return tag;
    }

    parseDTDNode(tag) {
        // Parse Document Type Descriptor Node, e.g. <!DOCTYPE ... >
        let matches = null;

        if (tag.match(this.patExternalDTDNode)) {
            // tag is external, and thus self-closing
            this.dtdNodeList.push(tag);
        } else if (tag.match(this.patInlineDTDNode)) {
            // Tag is inline, so check for nested nodes.
            this.patNextClose.lastIndex = this.patTag.lastIndex;

            while (!tag.match(this.patEndDTD)) {
                if (matches = this.patNextClose.exec(this.text)) {
                    tag += '>' + matches[1];
                } else {
                    this.throwParseError("Unclosed DTD tag", tag);
                    return null;
                }
            }

            this.patTag.lastIndex = this.patNextClose.lastIndex;

            // Make sure complete tag is well-formed, and push onto DTD stack.
            if (tag.match(this.patDTDNode)) {
                this.dtdNodeList.push(tag);
            } else {
                this.throwParseError("Malformed DTD tag", tag);
                return null;
            }
        } else {
            this.throwParseError("Malformed DTD tag", tag);
            return null;
        }
        return tag;
    }

    parseCDATANode(tag) {
        // Parse CDATA Node, e.g. <![CDATA[Brooks & Shields]]>
        let matches = null;
        this.patNextClose.lastIndex = this.patTag.lastIndex;

        while (!tag.match(this.patEndCDATA)) {
            if (matches = this.patNextClose.exec(this.text)) {
                tag += '>' + matches[1];
            } else {
                this.throwParseError("Unclosed CDATA tag", tag);
                return null;
            }
        }

        this.patTag.lastIndex = this.patNextClose.lastIndex;
        if (matches = tag.match(this.patCDATANode)) {
            return matches[1];
        } else {
            this.throwParseError("Malformed CDATA tag", tag);
            return null;
        }
    }

    getTree() {
        // get reference to parsed XML tree
        return this.tree;
    }


    compose(indent_string, eol) {
        // compose tree back into XML
        if (typeof (eol) == 'undefined') eol = "\n";
        let tree = this.tree;
        if (this.preserveDocumentNode) {
            tree = tree[this.documentNodeName];
        }

        const raw = stringify(tree, this.documentNodeName, 0, indent_string, eol);
        const body = raw.replace(/^\s*<\?.+?\?>\s*/, '');
        let xml = '';

        if (this.piNodeList.length) {
            for (let idx = 0, len = this.piNodeList.length; idx < len; idx++) {
                xml += '<' + this.piNodeList[idx] + '>' + eol;
            }
        } else {
            xml += xml_header + eol;
        }

        if (this.dtdNodeList.length) {
            for (let idx = 0, len = this.dtdNodeList.length; idx < len; idx++) {
                xml += '<' + this.dtdNodeList[idx] + '>' + eol;
            }
        }

        xml += body;
        return xml;
    };
}

//
// Static Utility Functions:
//

export function parse(text, opts) {
    // turn text into XML tree quickly
    if (!opts) opts = {};
    opts.text = text;
    const parser = new XML(opts);
    return parser.error() ? parser.getLastError() : parser.getTree();
}

export function trim(text) {
    // strip whitespace from beginning and end of string
    if (text == null) {
        return '';
    }

    if (text && text.replace) {
        text = text.replace(/^\s+/, "");
        text = text.replace(/\s+$/, "");
    }

    return text;
}

export function encodeEntities(text) {
    // Simple entitize exports.for = function for composing XML
    if (text == null) {
        return '';
    }
    if (text && text.replace) {
        text = text.replace(/&/g, "&amp;"); // MUST BE FIRST
        text = text.replace(/</g, "&lt;");
        text = text.replace(/>/g, "&gt;");
    }

    return text;
}

export function encodeAttribEntities(text) {
    // Simple entitize exports.for = function for composing XML attributes
    if (text == null) {
        return '';
    }

    if (text && text.replace) {
        text = text.replace(/&/g, "&amp;"); // MUST BE FIRST
        text = text.replace(/</g, "&lt;");
        text = text.replace(/>/g, "&gt;");
        text = text.replace(/"/g, "&quot;");
        text = text.replace(/'/g, "&apos;");
    }

    return text;
}

export function decodeEntities(text) {
    // Decode XML entities into raw ASCII
    if (text == null) {
        return '';
    }

    if (text && text.replace && text.match(/&/)) {
        text = text.replace(/&lt;/g, "<");
        text = text.replace(/&gt;/g, ">");
        text = text.replace(/&quot;/g, '"');
        text = text.replace(/&apos;/g, "'");
        text = text.replace(/&amp;/g, "&"); // MUST BE LAST
    }

    return text;
}

export function stringify(node, name, indent, indent_string, eol, sort) {
    // Compose node into XML including attributes
    // Recurse for child nodes
    if (typeof (indent_string) == 'undefined') {
        indent_string = "\t";
    }
    if (typeof (eol) === 'undefined') {
        eol = "\n";
    }
    if (typeof (sort) === 'undefined'){
        sort = true;
    }
    let xml = "";

    // If this is the root node, set the indent to 0
    // and setup the XML header (PI node)
    if (!indent) {
        indent = 0;
        xml = xml_header + eol;

        if (!name) {
            // no name provided, assume content is wrapped in it
            name = firstKey(node);
            node = node[name];
        }
    }

    // Setup the indent text
    let indent_text = "";
    for (let k = 0; k < indent; k++) {
        indent_text += indent_string;
    }

    if ((typeof (node) == 'object') && (node != null)) {
        // node is object -- now see if it is an array or hash
        if (!node.length) { // what about zero-length array?
            // node is hash
            xml += indent_text + "<" + name;

            let num_keys = 0;
            let has_attribs = 0;
            for (let key in node) {
                num_keys++;
            } // there must be a better way...

            if (node["_Attribs"]) {
                has_attribs = 1;
                const sorted_keys = sort ? hashKeysToArray(node["_Attribs"]).sort() : hashKeysToArray(node["_Attribs"]);
                for (let idx = 0, len = sorted_keys.length; idx < len; idx++) {
                    const key = sorted_keys[idx];
                    xml += " " + key + "=\"" + encodeAttribEntities(node["_Attribs"][key]) + "\"";
                }
            } // has attribs

            if (num_keys > has_attribs) {
                // has child elements
                xml += ">";

                if (node["_Data"]) {
                    // simple text child node
                    xml += encodeEntities(node["_Data"]) + "</" + name + ">" + eol;
                } // just text
                else {
                    xml += eol;

                    const sorted_keys = sort ? hashKeysToArray(node).sort() : hashKeysToArray(node);
                    for (let idx = 0, len = sorted_keys.length; idx < len; idx++) {
                        const key = sorted_keys[idx];
                        if ((key !== "_Attribs") && key.match(re_valid_tag_name)) {
                            // recurse for node, with incremented indent value
                            xml += stringify(node[key], key, indent + 1, indent_string, eol, sort);
                        } // not _Attribs key
                    } // foreach key

                    xml += indent_text + "</" + name + ">" + eol;
                } // real children
            } else {
                // no child elements, so self-close
                xml += "/>" + eol;
            }
        } // standard node
        else {
            // node is array
            for (let idx = 0; idx < node.length; idx++) {
                // recurse for node in array with same indent
                xml += stringify(node[idx], name, indent, indent_string, eol, sort);
            }
        } // array of nodes
    } // complex node
    else {
        // node is simple string
        xml += indent_text + "<" + name + ">" + encodeEntities(node) + "</" + name + ">" + eol;
    } // simple text node

    return xml;
}

export function alwaysArray(obj, key) {
    // if object is not array, return array containing object
    // if key is passed, work like XMLalwaysarray() instead
    if (key) {
        if ((typeof (obj[key]) != 'object') || (typeof (obj[key].length) == 'undefined')) {
            const temp = obj[key];
            delete obj[key];
            obj[key] = [];
            obj[key][0] = temp;
        }
        return null;
    } else {
        if ((typeof (obj) != 'object') || (typeof (obj.length) == 'undefined')) {
            return [obj];
        } else return obj;
    }
}

export function hashKeysToArray(hash) {
    // convert hash keys to array (discard values)
    const array = [];
    for (let key in hash) {
        array.push(key);
    }
    return array;
}

export function isaArray(arg) {
    // determine if arg is an array or is array-like
    return Array.isArray(arg);
}

export  function isaHash(arg) {
    // determine if arg is a hash
    return (!!arg && (typeof (arg) == 'object') && !isaArray(arg));
}

export function firstKey(hash) {
    // return first key from hash (unordered)
    for (let key in hash) {
        return key;
    }
    return null; // no keys in hash
}

export  function numKeys(hash) {
    // count the number of keys in a hash
    let count = 0;
    for (let a in hash) {
        count++;
    }
    return count;
}
