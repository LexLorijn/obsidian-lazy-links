import {
    App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf,
    ItemView, MarkdownView, Menu, Editor, TFile, Notice,
    debounce, setIcon, MarkdownRenderer, EditorPosition,
    TFolder, View, EditorSuggest, EditorSuggestContext,
    EditorSuggestTriggerInfo
} from "obsidian";
import { ViewPlugin, Decoration, DecorationSet, EditorView, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { editorInfoField } from "obsidian";

/* --- CONSTANTS & SETTINGS --- */
const VIEW_TYPE_LAZY_LINKS = "lazy-links-view";

interface LazyLinksSettings {
    matchStart: boolean;
    matchEnd: boolean;
    matchMiddle: boolean;
    minMatchLength: number;
    includeHeaders: boolean;
    headerLevels: Record<string, boolean>;
    enableReadingMode: boolean;
    firstMentionStyle: string;
    subsequentMentionStyle: string;
    customAccentColor: string;
    ignoredWords: string[];
    showHighlights: boolean;
}

const DEFAULT_SETTINGS: LazyLinksSettings = {
    matchStart: true,
    matchEnd: true,
    matchMiddle: false,
    minMatchLength: 3,
    includeHeaders: false,
    headerLevels: { h1: true, h2: true, h3: true, h4: false, h5: false, h6: false },
    enableReadingMode: true,
    firstMentionStyle: "full",
    subsequentMentionStyle: "minimal",
    customAccentColor: "",
    ignoredWords: [],
    showHighlights: true
};

/* --- TRIE & MATCHING LOGIC --- */
class TrieNode {
    children = new Map<string, TrieNode>();
    match: any = null; // Stores target info
}

class WordTrie {
    root = new TrieNode();

    insert(phrase: string, target: any) {
        const tokens = this.tokenize(phrase);
        if (tokens.length === 0) return;
        let node = this.root;
        for (const token of tokens) {
            if (!node.children.has(token)) {
                node.children.set(token, new TrieNode());
            }
            node = node.children.get(token)!;
        }
        node.match = target;
    }

    tokenize(text: string): string[] {
        return (text.toLowerCase().match(/[\p{L}\d]+/gu) || []);
    }

    findLongestMatch(tokens: any[], startIndex: number, selfNames: Set<string>, settings: LazyLinksSettings, allowSelf = false) {
        let node = this.root;
        let lastMatch = null;
        let lastMatchLength = 0;
        let currentLength = 0;

        for (let i = startIndex; i < tokens.length; i++) {
            const tokenText = tokens[i].text.toLowerCase();
            let exactMatchFound = false;

            if (node.children.has(tokenText)) {
                node = node.children.get(tokenText)!;
                currentLength++;
                exactMatchFound = true;

                if (node.match) {
                    if (allowSelf || !selfNames.has(node.match.actualName.toLowerCase())) {
                        lastMatch = node.match;
                        lastMatchLength = currentLength;
                    }
                }
            }

            if (!exactMatchFound) {
                // Check for partial matches on children (if not exact)
                for (const [key, childNode] of node.children) {
                    if (childNode.match) {
                        let isMatch = false;
                        if (settings.matchStart && tokenText.startsWith(key)) isMatch = true;
                        if (settings.matchEnd && tokenText.endsWith(key)) isMatch = true;
                        if (settings.matchMiddle && tokenText.includes(key)) isMatch = true;

                        if (isMatch) {
                            if (allowSelf || !selfNames.has(childNode.match.actualName.toLowerCase())) {
                                lastMatch = childNode.match;
                                lastMatchLength = currentLength + 1;
                            }
                        }
                    }
                }
                break;
            }
        }
        return { length: lastMatchLength, target: lastMatch };
    }
}

/* --- MAIN PLUGIN CLASS --- */
export default class LazyLinksPlugin extends Plugin {
    settings: LazyLinksSettings;
    phraseTrie: WordTrie;
    singleWordIndex: Map<string, any>;
    view: LazyLinksView | null = null;
    previewTimeout: NodeJS.Timeout | null = null;
    
    async onload() {
        await this.loadSettings();
        this.phraseTrie = new WordTrie();
        this.singleWordIndex = new Map();
        
        this.applyCustomStyles();

        // 1. Settings
        this.addSettingTab(new LazyLinksSettingTab(this.app, this));

        // 2. Sidebar View
        this.registerView(VIEW_TYPE_LAZY_LINKS, (leaf) => this.view = new LazyLinksView(leaf, this));

        // 3. Commands
        this.addCommand({ id: "open-lazy-links-view", name: "Open Side Panel", callback: () => this.activateView() });
        this.addCommand({ id: "rebuild-lazy-links-index", name: "Rebuild Index", callback: () => { this.rebuildIndex(); new Notice("Index Rebuilt"); }});
        this.addCommand({ id: "toggle-lazy-links-view", name: "Toggle Highlights", callback: () => this.toggleViewMode() });
        this.addCommand({ id: "cycle-lazy-links-mode", name: "Cycle View Mode", callback: () => this.cycleViewMode() });

        // 4. Editor Extension (The red underlines)
        this.registerEditorExtension(ViewPlugin.fromClass(class {
            decorations: DecorationSet;
            plugin: LazyLinksPlugin;
            currentFile: TFile | null = null;

            constructor(view: EditorView) {
                this.plugin = this.plugin || app.plugins.plugins["obsidian-lazy-links"]; // Fallback if capture fails
                // @ts-ignore
                if (!this.plugin) this.plugin = app.plugins.getPlugin("obsidian-lazy-links");
                
                this.updateCurrentFile(view);
                this.decorations = this.buildDecorations(view);
            }

            update(update: ViewUpdate) {
                if (update.docChanged || update.viewportChanged || update.transactions.some(t => t.isUserEvent('lazy-links-refresh'))) {
                    this.updateCurrentFile(update.view);
                    this.decorations = this.buildDecorations(update.view);
                }
            }

            updateCurrentFile(view: EditorView) {
                const stateField = view.state.field(editorInfoField, false);
                if (stateField && stateField.file) {
                    this.currentFile = stateField.file;
                }
            }

            buildDecorations(view: EditorView): DecorationSet {
                if (!this.plugin || !this.plugin.settings.showHighlights || !this.currentFile) return Decoration.none;

                const builder = new RangeSetBuilder<Decoration>();
                const selfNames = this.plugin.getSelfNames(this.currentFile);
                const seenInThisView = new Set<string>();
                
                // Visible Ranges loop (optimization)
                for (const { from, to } of view.visibleRanges) {
                    const text = view.state.doc.sliceString(from, to);
                    // Adjust offsets relative to 'from'
                    const tokens = [];
                    const wordRegex = /[\p{L}\d]+/gu;
                    let match;
                    
                    // Exclude existing links [[ ]] and [ ]( )
                    const ignoreRanges: {start: number, end: number}[] = [];
                    const linkRegex = /\[\[.*?\]\]|\[.*?\]\(.*?\)/g;
                    while ((match = linkRegex.exec(text)) !== null) {
                        ignoreRanges.push({ start: match.index, end: match.index + match[0].length });
                    }

                    while ((match = wordRegex.exec(text)) !== null) {
                        const start = match.index;
                        const end = start + match[0].length;
                        const isIgnored = ignoreRanges.some(r => start >= r.start && end <= r.end);
                        if (!isIgnored) tokens.push({ text: match[0], start: from + start, end: from + end });
                    }

                    let tIndex = 0;
                    while (tIndex < tokens.length) {
                        const phraseMatch = this.plugin.phraseTrie.findLongestMatch(tokens, tIndex, selfNames, this.plugin.settings, false);
                        
                        if (phraseMatch.target && phraseMatch.length > 0) {
                            const startToken = tokens[tIndex];
                            const endToken = tokens[tIndex + phraseMatch.length - 1];
                            const key = phraseMatch.target.actualName.toLowerCase();
                            
                            const style = seenInThisView.has(key) ? this.plugin.settings.subsequentMentionStyle : this.plugin.settings.firstMentionStyle;
                            
                            if (style !== "off") {
                                builder.add(startToken.start, endToken.end, Decoration.mark({
                                    class: `cm-virtual-link lazy-style-${style}`,
                                    attributes: { "data-link-target": phraseMatch.target.file.basename }
                                }));
                            }
                            seenInThisView.add(key);
                            tIndex += phraseMatch.length;
                        } else {
                            // Single word check
                            const token = tokens[tIndex];
                            const single = this.plugin.findBestMatchSingle(token.text, selfNames, false);
                            if (single.target) {
                                const key = single.matchedString;
                                const style = seenInThisView.has(key) ? this.plugin.settings.subsequentMentionStyle : this.plugin.settings.firstMentionStyle;
                                if (style !== "off") {
                                    builder.add(token.start, token.end, Decoration.mark({
                                        class: `cm-virtual-link lazy-style-${style}`,
                                        attributes: { "data-link-target": single.target.file.basename }
                                    }));
                                }
                                seenInThisView.add(key);
                            }
                            tIndex++;
                        }
                    }
                }
                return builder.finish();
            }
        }, { decorations: v => v.decorations }));

        // 5. Reading Mode Support
        this.registerMarkdownPostProcessor((el, ctx) => {
            if (this.settings.enableReadingMode && this.settings.showHighlights) this.processHtml(el, ctx);
        });

        // 6. Context Menu
        this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
            const cursor = editor.getCursor();
            const info = this.getMatchAtCursor(editor, cursor);
            if (info) {
                // Check if inside existing link
                const line = editor.getLine(cursor.line);
                if (line.lastIndexOf("[[", info.from.ch) > line.lastIndexOf("]]", info.from.ch)) return;

                if (view.file && info.target.file.path === view.file.path) return;
                
                const label = info.target.subpath ? `Link to "${info.target.file.basename} > ${info.target.subpath}"` : `Link to "${info.target.file.basename}"`;
                
                menu.addItem((item) => {
                    item.setTitle(label).setIcon("link").onClick(() => this.convertLink(editor, info, info.target));
                });
                menu.addItem((item) => {
                    item.setTitle(`Ignore "${info.word}"`).setIcon("cross").onClick(async () => {
                         this.settings.ignoredWords.push(info.word.toLowerCase());
                         await this.saveSettings();
                         this.rebuildIndex();
                         new Notice(`"${info.word}" ignored.`);
                    });
                });
            }
        }));

        // 7. Mouse Events (Hover/Click)
        this.registerDomEvent(document, 'mouseover', (evt) => {
            const target = evt.target as HTMLElement;
            if (target?.matches('.cm-virtual-link, .lazy-reading-link')) this.showPreview(target, evt);
        });
        this.registerDomEvent(document, 'mouseout', (evt) => {
            const target = evt.target as HTMLElement;
            if (target?.matches('.cm-virtual-link, .lazy-reading-link')) this.hidePreview();
        });
        this.registerDomEvent(document, 'click', (evt) => {
            const target = evt.target as HTMLElement;
            if (target?.matches('.cm-virtual-link, .lazy-reading-link')) {
                evt.preventDefault(); evt.stopPropagation();
                const link = target.getAttribute('data-link-target');
                if (link) this.openFile(link, evt);
            }
        });

        // Wait for layout
        this.app.workspace.onLayoutReady(() => this.rebuildIndex());
        
        // Auto-rebuild on file changes
        const debouncedRebuild = debounce(() => this.rebuildIndex(), 5000, false);
        this.registerEvent(this.app.metadataCache.on("resolved", debouncedRebuild));
        this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.view?.refresh()));
    }

    /* --- HELPERS --- */
    
    rebuildIndex() {
        this.singleWordIndex.clear();
        this.phraseTrie = new WordTrie();
        const files = this.app.vault.getMarkdownFiles();
        
        files.forEach(file => {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.frontmatter?.["ignore_linking"] === true) return;
            
            const addTerm = (term: string, target: any) => {
                const t = term.toLowerCase();
                if (this.settings.ignoredWords.includes(t)) return;
                this.phraseTrie.insert(t, target);
                if (!t.includes(" ")) this.singleWordIndex.set(t, target);
            };

            addTerm(file.basename, { file, actualName: file.basename });
            
            cache?.frontmatter?.aliases?.forEach((a: any) => {
                if (typeof a === "string") addTerm(a, { file, actualName: a });
            });

            if (this.settings.includeHeaders && cache?.headings) {
                cache.headings.forEach(h => {
                    if (this.settings.headerLevels[`h${h.level}`] && h.heading.length >= this.settings.minMatchLength) {
                        addTerm(h.heading, { file, actualName: h.heading, subpath: `#${h.heading}` });
                    }
                });
            }
        });
        this.refreshEditors();
    }

    refreshEditors() {
        // Dispatch event to update CodeMirror views
        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view?.editor?.cm) leaf.view.editor.cm.dispatch({ userEvent: 'lazy-links-refresh' });
        });
        // Rerender preview mode
        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof MarkdownView && leaf.view.getMode() === 'preview') leaf.view.previewMode.rerender(true);
        });
        this.view?.refresh();
    }

    getSelfNames(file: TFile): Set<string> {
        const selfNames = new Set<string>();
        selfNames.add(file.basename.toLowerCase());
        const cache = this.app.metadataCache.getFileCache(file);
        cache?.frontmatter?.aliases?.forEach((a: string) => selfNames.add(a.toLowerCase()));
        return selfNames;
    }

    findBestMatchSingle(word: string, selfNames: Set<string>, allowSelf = false) {
        const lower = word.toLowerCase();
        if (this.singleWordIndex.has(lower)) {
            if (allowSelf || !selfNames.has(lower)) 
                return { target: this.singleWordIndex.get(lower), matchedString: lower };
        }
        
        if (!this.settings.matchStart && !this.settings.matchEnd && !this.settings.matchMiddle)
            return { target: null };
            
        if (word.length < this.settings.minMatchLength) return { target: null };
        
        for (let len = lower.length - 1; len >= this.settings.minMatchLength; len--) {
            for (let i = 0; i <= lower.length - len; i++) {
                const isStart = i === 0;
                const isEnd = i + len === lower.length;
                // Skip positions the enabled modes can't accept *before* allocating — avoids O(L^2) substring churn when matchMiddle is off (the default).
                if (!((isStart && this.settings.matchStart) || (isEnd && this.settings.matchEnd) || (!isStart && !isEnd && this.settings.matchMiddle))) continue;
                const sub = lower.substring(i, i + len);
                if (!allowSelf && selfNames.has(sub)) continue;
                if (this.singleWordIndex.has(sub)) {
                    return { target: this.singleWordIndex.get(sub), matchedString: sub };
                }
            }
        }
        return { target: null };
    }

    /* --- DOM & HTML --- */

    processHtml(element: HTMLElement, context: any) {
        const sourceFile = this.app.metadataCache.getFirstLinkpathDest(context.sourcePath, "");
        if (!sourceFile) return;
        
        const selfNames = this.getSelfNames(sourceFile);
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const nodesToReplace: {node: Node, matches: any[]}[] = [];
        
        let node;
        while (node = walker.nextNode()) {
            if (this.shouldSkipNode(node)) continue;
            const text = node.nodeValue || "";
            const tokens: any[] = [];
            const regex = /[\p{L}\d]+/gu;
            let match;
            while ((match = regex.exec(text)) !== null) {
                tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
            }

            const matches = [];
            let tIndex = 0;
            while (tIndex < tokens.length) {
                const phraseMatch = this.phraseTrie.findLongestMatch(tokens, tIndex, selfNames, this.settings, false);
                if (phraseMatch.target && phraseMatch.length > 0) {
                    const startToken = tokens[tIndex];
                    const endToken = tokens[tIndex + phraseMatch.length - 1];
                    matches.push({
                        start: startToken.start, end: endToken.end,
                        result: { target: phraseMatch.target }, word: text.substring(startToken.start, endToken.end)
                    });
                    tIndex += phraseMatch.length;
                } else {
                    const token = tokens[tIndex];
                    const single = this.findBestMatchSingle(token.text, selfNames, false);
                    if (single.target) {
                         matches.push({ start: token.start, end: token.end, result: single, word: token.text });
                    }
                    tIndex++;
                }
            }
            if (matches.length > 0) nodesToReplace.push({ node, matches });
        }

        // Apply replacements
        for (const { node, matches } of nodesToReplace) {
            const frag = document.createDocumentFragment();
            let lastIdx = 0;
            for (const m of matches) {
                if (m.start > lastIdx) frag.appendChild(document.createTextNode(node.nodeValue!.substring(lastIdx, m.start)));
                
                const span = document.createElement("span");
                span.className = `lazy-reading-link lazy-style-${this.settings.firstMentionStyle}`;
                span.setAttribute("data-link-target", m.result.target.file.basename);
                span.innerText = node.nodeValue!.substring(m.start, m.end);
                frag.appendChild(span);
                
                lastIdx = m.end;
            }
            if (lastIdx < node.nodeValue!.length) frag.appendChild(document.createTextNode(node.nodeValue!.substring(lastIdx)));
            node.parentNode?.replaceChild(frag, node);
        }
    }

    shouldSkipNode(node: Node) {
        let parent = node.parentNode as HTMLElement;
        while (parent && parent !== document.body) {
            if (["A", "PRE", "CODE", "STYLE", "SCRIPT", "TEXTAREA"].includes(parent.tagName)) return true;
            if (parent.classList?.contains("cm-virtual-link") || parent.classList?.contains("lazy-reading-link")) return true;
            parent = parent.parentNode as HTMLElement;
        }
        return false;
    }

    /* --- INTERACTIONS --- */

    getMatchAtCursor(editor: Editor, position: EditorPosition) {
        const line = editor.getLine(position.line);
        const wordRegex = /[\p{L}\d]+/gu;
        let match;
        const tokens = [];
        while ((match = wordRegex.exec(line)) !== null) {
            tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
        }
        
        const hitIndex = tokens.findIndex(t => position.ch >= t.start && position.ch <= t.end);
        if (hitIndex === -1) return null;

        const selfNames = this.getSelfNames(this.getFileForView(editor as any) || new TFile());
        
        // Search backwards a bit to find phrases
        const startSearch = Math.max(0, hitIndex - 5);
        for (let i = startSearch; i <= hitIndex; i++) {
            const res = this.phraseTrie.findLongestMatch(tokens, i, selfNames, this.settings, false);
            if (res.target && i + res.length > hitIndex) {
                 const startT = tokens[i];
                 const endT = tokens[i + res.length - 1];
                 return { word: line.substring(startT.start, endT.end), from: {line: position.line, ch: startT.start}, to: {line: position.line, ch: endT.end}, target: res.target };
            }
        }
        // Fallback single
        const token = tokens[hitIndex];
        const single = this.findBestMatchSingle(token.text, selfNames, false);
        if (single.target) {
            return { word: token.text, from: {line: position.line, ch: token.start}, to: {line: position.line, ch: token.end}, target: single.target };
        }
        return null;
    }

    convertLink(editor: Editor, info: any, target: any) {
        const filePart = target.file.basename;
        const linkPath = target.subpath ? `${filePart}${target.subpath}` : filePart;
        let text = "";
        if (info.word.toLowerCase() === target.actualName.toLowerCase() && !target.subpath) {
            text = `[[${linkPath}]]`;
        } else {
            text = `[[${linkPath}|${info.word}]]`;
        }
        editor.replaceRange(text, info.from, info.to);
    }

    getFileForView(editor: any): TFile | null {
        // Safe fallback
        let found = null;
        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof MarkdownView && leaf.view.editor == editor) found = leaf.view.file;
        });
        return found;
    }

    showPreview(element: HTMLElement, evt: any) {
        if (this.previewTimeout) clearTimeout(this.previewTimeout);
        this.previewTimeout = setTimeout(() => {
            const target = element.getAttribute('data-link-target');
            if (target) {
                const file = this.app.metadataCache.getFirstLinkpathDest(target, "");
                if (file) this.createPreviewPopup(element, file);
            }
        }, 300);
    }

    hidePreview() {
        if (this.previewTimeout) clearTimeout(this.previewTimeout);
        const existing = document.querySelector('.lazy-links-preview-popup');
        if (existing) {
            existing.classList.add('lazy-preview-hiding');
            setTimeout(() => existing.remove(), 200);
        }
    }

    async createPreviewPopup(element: HTMLElement, file: TFile) {
        this.hidePreview(); // Clear others
        const popup = document.createElement('div');
        popup.className = 'lazy-links-preview-popup popover';
        const content = popup.createDiv('lazy-preview-content markdown-rendered');
        document.body.appendChild(popup);

        try {
            const data = await this.app.vault.read(file);
            MarkdownRenderer.render(this.app, data.slice(0, 500) + "...", content, file.path, this);
        } catch(e) {}

        const rect = element.getBoundingClientRect();
        let left = rect.left;
        if (left + 350 > window.innerWidth) left = window.innerWidth - 370;
        
        popup.style.top = `${rect.bottom + 10}px`;
        popup.style.left = `${left}px`;
        requestAnimationFrame(() => popup.classList.add('lazy-preview-visible'));
    }

    async openFile(target: string, evt: MouseEvent) {
        const file = this.app.metadataCache.getFirstLinkpathDest(target, "");
        if (file) {
            const leaf = (evt.ctrlKey || evt.metaKey) ? this.app.workspace.getLeaf('tab') : this.app.workspace.getLeaf(false);
            leaf.openFile(file);
        }
    }

    /* --- SETTINGS OPS --- */
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }
    applyCustomStyles() {
        if (this.settings.customAccentColor) document.body.style.setProperty("--lazy-links-accent", this.settings.customAccentColor);
    }
    toggleViewMode() {
        this.settings.showHighlights = !this.settings.showHighlights;
        this.saveSettings();
        this.refreshEditors();
    }
    cycleViewMode() {
        const modes = ['off', 'minimal', 'accent', 'full'];
        const next = (m: string) => modes[(modes.indexOf(m) + 1) % modes.length];
        this.settings.firstMentionStyle = next(this.settings.firstMentionStyle);
        this.settings.subsequentMentionStyle = next(this.settings.subsequentMentionStyle);
        this.saveSettings();
        this.refreshEditors();
        new Notice(`First: ${this.settings.firstMentionStyle} / Sub: ${this.settings.subsequentMentionStyle}`);
    }
    async activateView() {
        if (this.app.workspace.getLeavesOfType(VIEW_TYPE_LAZY_LINKS).length === 0) {
            await this.app.workspace.getRightLeaf(false).setViewState({ type: VIEW_TYPE_LAZY_LINKS, active: true });
        }
        this.app.workspace.revealLeaf(this.app.workspace.getLeavesOfType(VIEW_TYPE_LAZY_LINKS)[0]);
    }
}

/* --- SIDEBAR VIEW (EXPLORER) --- */
class LazyLinksView extends ItemView {
    plugin: LazyLinksPlugin;
    refreshDebounce: Function;

    constructor(leaf: WorkspaceLeaf, plugin: LazyLinksPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.refreshDebounce = debounce(this.render.bind(this), 500, true);
    }
    getViewType() { return VIEW_TYPE_LAZY_LINKS; }
    getDisplayText() { return "Lazy Links Explorer"; }
    getIcon() { return "link"; }
    async onOpen() { this.render(); }
    refresh() { this.refreshDebounce(); }

    async render() {
        const container = this.contentEl;
        container.empty();
        container.addClass("lazy-links-sidebar");
        
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") {
            container.createDiv({ text: "No active markdown file.", cls: "lazy-empty-state" });
            return;
        }

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return; // Wait for view to be ready

        const text = view.editor.getValue();
        const selfNames = this.plugin.getSelfNames(file);
        
        // Scan for matches manually (lines -> tokens -> matches)
        const matches: any[] = [];
        const lines = text.split("\n");
        let offset = 0;
        
        // Ignore frontmatter
        let startLine = 0;
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.frontmatterPosition) {
             offset = cache.frontmatterPosition.end.offset + 1; // approx
             startLine = cache.frontmatterPosition.end.line + 1;
        }

        for (let i = startLine; i < lines.length; i++) {
            const line = lines[i];
            const tokens: any[] = [];
            const regex = /[\p{L}\d]+/gu;
            let match;
            
            // Calc absolute offset for line start
            const lineStart = view.editor.posToOffset({line: i, ch: 0});
            
            // Ignore links in line
            const ignore = [];
            const linkRegex = /\[\[.*?\]\]|\[.*?\]\(.*?\)/g;
            while ((match = linkRegex.exec(line)) !== null) ignore.push({s: match.index, e: match.index + match[0].length});

            while ((match = regex.exec(line)) !== null) {
                if (!ignore.some(r => match.index >= r.s && match.index + match[0].length <= r.e)) {
                    tokens.push({text: match[0], start: lineStart + match.index, end: lineStart + match.index + match[0].length});
                }
            }
            
            let tIdx = 0;
            while (tIdx < tokens.length) {
                const res = this.plugin.phraseTrie.findLongestMatch(tokens, tIdx, selfNames, this.plugin.settings, false);
                if (res.target && res.length > 0) {
                     const s = tokens[tIdx];
                     const e = tokens[tIdx + res.length - 1];
                     matches.push({ word: text.substring(s.start, e.end), target: res.target, start: s.start, end: e.end });
                     tIdx += res.length;
                } else {
                     const s = tokens[tIdx];
                     const single = this.plugin.findBestMatchSingle(s.text, selfNames, false);
                     if (single.target) matches.push({ word: s.text, target: single.target, start: s.start, end: s.end });
                     tIdx++;
                }
            }
        }

        if (matches.length === 0) {
            container.createDiv({ text: "No unlinked mentions found.", cls: "lazy-empty-state" });
            return;
        }

        // Grouping
        const groups = new Map();
        matches.forEach(m => {
            const p = m.target.file.path;
            if (!groups.has(p)) groups.set(p, []);
            groups.get(p).push(m);
        });

        groups.forEach((group, path) => {
             const target = group[0].target;
             const div = container.createDiv("lazy-file-group");
             
             // Header
             const h = div.createDiv("lazy-file-header");
             h.createSpan({ text: target.file.basename });
             h.createSpan({ text: `${group.length}`, cls: "lazy-file-count" });
             
             const content = div.createDiv();
             h.onclick = () => { content.style.display = content.style.display === 'none' ? 'block' : 'none'; };

             // Matches
             group.forEach((m: any, idx: number) => {
                 if (idx > 0 && idx === 1) { // Hide after first, show "Show more"
                     const moreBtn = content.createEl("button", { text: `See ${group.length - 1} more...`, cls: "lazy-btn-secondary" });
                     const hiddenDiv = content.createDiv({ cls: "lazy-hidden-matches" });
                     hiddenDiv.style.display = "none";
                     moreBtn.onclick = () => { hiddenDiv.style.display = "block"; moreBtn.remove(); };
                     
                     // "Link All" button inside hidden
                     const linkAll = hiddenDiv.createEl("button", { text: "Link All Matches", cls: "lazy-btn-primary lazy-btn-block" });
                     linkAll.onclick = (e) => { e.stopPropagation(); this.convertAll(view, group, target); };
                     
                     // Append remaining matches to hiddenDiv
                     this.renderMatch(hiddenDiv, m, view, target, text);
                     return; 
                 }
                 
                 // If idx > 1, append to hidden div if exists, else just render
                 const containerToUse = (idx > 0) ? content.querySelector(".lazy-hidden-matches") || content : content;
                 this.renderMatch(containerToUse as HTMLElement, m, view, target, text);
             });
        });
    }

    renderMatch(container: HTMLElement, m: any, view: MarkdownView, target: any, fullText: string) {
        const item = container.createDiv("lazy-match-item");
        const ctxPre = fullText.substring(Math.max(0, m.start - 20), m.start);
        const ctxPost = fullText.substring(m.end, Math.min(fullText.length, m.end + 20));
        
        const ctxDiv = item.createDiv("lazy-match-context");
        ctxDiv.innerHTML = `...${ctxPre}<span class="lazy-match-highlight">${m.word}</span>${ctxPost}...`;
        
        const actions = item.createDiv("lazy-match-actions");
        const btn = actions.createEl("button", { cls: "lazy-link-btn" });
        setIcon(btn, "link"); btn.createSpan({text: "Link"});
        
        btn.onclick = (e) => {
            e.stopPropagation();
            const start = view.editor.offsetToPos(m.start);
            const end = view.editor.offsetToPos(m.end);
            this.plugin.convertLink(view.editor, {word: m.word, from: start, to: end}, target);
        };
        
        item.onclick = () => {
             const pos = view.editor.offsetToPos(m.start);
             view.editor.setCursor(pos);
             view.editor.scrollIntoView({from: pos, to: pos}, true);
        };
    }

    convertAll(view: MarkdownView, matches: any[], target: any) {
        // Sort descending
        matches.sort((a, b) => b.start - a.start);
        matches.forEach(m => {
            const start = view.editor.offsetToPos(m.start);
            const end = view.editor.offsetToPos(m.end);
            this.plugin.convertLink(view.editor, {word: m.word, from: start, to: end}, target);
        });
    }
}

/* --- SETTINGS TAB --- */
class LazyLinksSettingTab extends PluginSettingTab {
    plugin: LazyLinksPlugin;
    constructor(app: App, plugin: LazyLinksPlugin) { super(app, plugin); this.plugin = plugin; }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "Lazy Links Settings" });

        new Setting(containerEl).setName("Show Highlights").addToggle(t => t.setValue(this.plugin.settings.showHighlights).onChange(async v => {
            this.plugin.settings.showHighlights = v; await this.plugin.saveSettings(); this.plugin.refreshEditors();
        }));
        
        new Setting(containerEl).setName("First Mention Style").addDropdown(d => 
            d.addOption("full", "Full").addOption("accent", "Accent").addOption("minimal", "Minimal")
             .setValue(this.plugin.settings.firstMentionStyle)
             .onChange(async v => { this.plugin.settings.firstMentionStyle = v; await this.plugin.saveSettings(); this.plugin.refreshEditors(); }));

        new Setting(containerEl).setName("Subsequent Mention Style").addDropdown(d => 
             d.addOption("full", "Full").addOption("accent", "Accent").addOption("minimal", "Minimal").addOption("off", "Off")
              .setValue(this.plugin.settings.subsequentMentionStyle)
              .onChange(async v => { this.plugin.settings.subsequentMentionStyle = v; await this.plugin.saveSettings(); this.plugin.refreshEditors(); }));

        new Setting(containerEl).setName("Ignored Words").addTextArea(t => 
             t.setValue(this.plugin.settings.ignoredWords.join(", ")).onChange(async v => {
                 this.plugin.settings.ignoredWords = v.split(",").map(s => s.trim().toLowerCase()).filter(s => s);
                 await this.plugin.saveSettings(); this.plugin.rebuildIndex();
             }));

        new Setting(containerEl).setName("Include Headers").addToggle(t => t.setValue(this.plugin.settings.includeHeaders).onChange(async v => {
             this.plugin.settings.includeHeaders = v; await this.plugin.saveSettings(); this.plugin.rebuildIndex();
        }));
    }
}