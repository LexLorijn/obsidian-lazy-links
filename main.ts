import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	Editor,
	MarkdownView,
	Menu,
	debounce,
	HeadingCache,
	MarkdownPostProcessorContext,
	Notice
} from 'obsidian';
import {
	ViewUpdate,
	PluginValue,
	ViewPlugin,
	EditorView,
	Decoration,
	DecorationSet
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// --- Settings ---
interface LazyLinksSettings {
	debugMode: boolean;
	matchStart: boolean;
	matchEnd: boolean;
	matchMiddle: boolean;
	minMatchLength: number;
	// Header Settings
	includeHeaders: boolean;
	headerLevels: {
		h1: boolean;
		h2: boolean;
		h3: boolean;
		h4: boolean;
		h5: boolean;
		h6: boolean;
	};
	// View Settings
	enableReadingMode: boolean;
}

const DEFAULT_SETTINGS: LazyLinksSettings = {
	debugMode: false,
	matchStart: true,
	matchEnd: true,
	matchMiddle: false,
	minMatchLength: 3,
	includeHeaders: false,
	headerLevels: {
		h1: true,
		h2: true,
		h3: true,
		h4: false,
		h5: false,
		h6: false
	},
	enableReadingMode: false
}

// --- Interfaces ---
interface LinkTarget {
	file: TFile;
	isAlias: boolean;
	actualName: string; 
	subpath?: string; // e.g. "#Staff"
}

export default class LazyLinksPlugin extends Plugin {
	settings: LazyLinksSettings;
	linkIndex: Map<string, LinkTarget> = new Map();

	async onload() {
		await this.loadSettings();
		this.debugLog("Plugin loading...");

		this.addSettingTab(new LazyLinksSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.rebuildIndex();
		});

		const debouncedRebuild = debounce(() => {
			this.rebuildIndex();
		}, 2000, true);

		this.registerEvent(
			this.app.metadataCache.on('resolved', () => {
				debouncedRebuild();
			})
		);

		// 1. Editor Extension (For Typing/Edit Mode)
		this.registerEditorExtension(
			ViewPlugin.fromClass(
				class implements PluginValue {
					decorations: DecorationSet;
					plugin: LazyLinksPlugin;
					currentFile: TFile | null = null;

					constructor(view: EditorView) {
						this.plugin = app.plugins.plugins['obsidian-lazy-links'] as LazyLinksPlugin;
						this.currentFile = this.plugin.getFileForView(view);
						this.decorations = this.buildDecorations(view);
					}

					update(update: ViewUpdate) {
						if (update.docChanged || update.viewportChanged) {
							this.currentFile = this.plugin.getFileForView(update.view);
							this.decorations = this.buildDecorations(update.view);
						}
					}

					buildDecorations(view: EditorView): DecorationSet {
						if (!this.plugin || !this.plugin.linkIndex.size) return Decoration.none;
						
						const builder = new RangeSetBuilder<Decoration>();
						
						// Identify Self
						const selfNames = this.currentFile ? this.plugin.getSelfNames(this.currentFile) : new Set<string>();
						const seenInThisView = new Set<string>();

						for (const { from, to } of view.visibleRanges) {
							const text = view.state.doc.sliceString(from, to);
							const regex = /\b\w+\b/g; 
							let match;

							while ((match = regex.exec(text)) !== null) {
								const word = match[0];
								const absoluteStart = from + match.index;
								const absoluteEnd = absoluteStart + word.length;

								const prevChar = view.state.doc.sliceString(Math.max(0, absoluteStart - 2), absoluteStart);
								const nextChar = view.state.doc.sliceString(absoluteEnd, Math.min(view.state.doc.length, absoluteEnd + 2));
								if (prevChar.includes('[[') || nextChar.includes(']]')) continue;

								const matchResult = this.plugin.findBestMatch(word, selfNames);

								if (matchResult.target) {
									let styleClass = "cm-virtual-link";
									if (matchResult.isPartial) {
										styleClass = "cm-virtual-link-muted";
									} else {
										if (seenInThisView.has(matchResult.matchedString)) {
											styleClass = "cm-virtual-link-muted";
										}
										seenInThisView.add(matchResult.matchedString);
									}

									builder.add(
										absoluteStart,
										absoluteEnd,
										Decoration.mark({
											class: styleClass,
											attributes: { 
												"data-link-target": matchResult.target.file.basename
											}
										})
									);
								}
							}
						}
						return builder.finish();
					}
				},
				{
					decorations: v => v.decorations
				}
			)
		);

		// 2. Markdown Post Processor (For Reading Mode & Canvas Cards)
		this.registerMarkdownPostProcessor((element, context) => {
			if (this.settings.enableReadingMode) {
				this.processHtml(element, context);
			}
		});

		// 3. Context Menu
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
				const cursor = editor.getCursor();
				const wordInfo = this.getWordAtPosition(editor, cursor);

				if (wordInfo) {
					const selfNames = view.file ? this.getSelfNames(view.file) : new Set<string>();
					const matchResult = this.findBestMatch(wordInfo.word, selfNames);

					if (matchResult.target) {
						const target = matchResult.target;
						if (view.file && (target.file.path === view.file.path)) return;

						const label = target.subpath 
							? `Create link to "${target.file.basename} > ${target.subpath}"`
							: `Create link to "${target.file.basename}"`;

						menu.addItem((item) => {
							item
								.setTitle(label)
								.setIcon("link")
								.onClick(() => {
									this.convertLink(editor, wordInfo, target);
								});
						});
					}
				}
			})
		);
	}

	// --- Reading Mode / Canvas Processor ---
	processHtml(element: HTMLElement, context: MarkdownPostProcessorContext) {
		const sourceFile = this.app.metadataCache.getFirstLinkpathDest(context.sourcePath, "");
		const selfNames = sourceFile ? this.getSelfNames(sourceFile) : new Set<string>();

		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
		const nodesToReplace: { node: Text, matches: any[] }[] = [];

		let node: Node | null;
		while (node = walker.nextNode()) {
			if (this.shouldSkipNode(node)) continue;

			const text = node.nodeValue || "";
			const regex = /\b\w+\b/g; 
			let match;
			const matches = [];

			while ((match = regex.exec(text)) !== null) {
				const word = match[0];
				const matchResult = this.findBestMatch(word, selfNames);
				if (matchResult.target) {
					matches.push({
						start: match.index,
						end: match.index + word.length,
						result: matchResult,
						word: word
					});
				}
			}
			
			if (matches.length > 0) {
				nodesToReplace.push({ node: node as Text, matches });
			}
		}

		for (const { node, matches } of nodesToReplace) {
			const fragment = document.createDocumentFragment();
			let lastIndex = 0;

			for (const m of matches) {
				if (m.start > lastIndex) {
					fragment.appendChild(document.createTextNode(node.nodeValue!.substring(lastIndex, m.start)));
				}

				const span = document.createElement('span');
				let styleClass = "cm-virtual-link";
				if (m.result.isPartial) {
					styleClass = "cm-virtual-link-muted";
				}
				
				span.className = styleClass;
				span.setAttribute("data-link-target", m.result.target.file.basename);
				span.innerText = node.nodeValue!.substring(m.start, m.end);
				fragment.appendChild(span);
				
				lastIndex = m.end;
			}

			if (lastIndex < node.nodeValue!.length) {
				fragment.appendChild(document.createTextNode(node.nodeValue!.substring(lastIndex)));
			}

			node.parentNode?.replaceChild(fragment, node);
		}
	}

	shouldSkipNode(node: Node): boolean {
		let parent = node.parentNode;
		while (parent && parent !== document.body) {
			const el = parent as HTMLElement;
			if (!el.tagName) { parent = parent.parentNode; continue; } // handle shadow roots/fragments
			
			const tag = el.tagName;
			if (['A', 'PRE', 'CODE', 'STYLE', 'SCRIPT', 'TEXTAREA'].includes(tag)) return true;
			if (el.classList?.contains('cm-virtual-link')) return true;
			if (el.classList?.contains('cm-virtual-link-muted')) return true;
			parent = parent.parentNode;
		}
		return false;
	}

	// --- Core Logic ---

	getSelfNames(file: TFile): Set<string> {
		const selfNames = new Set<string>();
		selfNames.add(file.basename.toLowerCase());
		const cache = this.app.metadataCache.getFileCache(file);
		
		if (cache?.frontmatter?.aliases) {
			const aliases = cache.frontmatter.aliases;
			const arr = Array.isArray(aliases) ? aliases : [aliases];
			arr.forEach(a => { if (typeof a === 'string') selfNames.add(a.toLowerCase()) });
		}

		if (cache?.headings) {
			cache.headings.forEach(h => selfNames.add(h.heading.toLowerCase()));
		}
		return selfNames;
	}

	findBestMatch(word: string, selfNames: Set<string>): { target: LinkTarget | null, isPartial: boolean, matchedString: string } {
		const lower = word.toLowerCase();

		if (this.linkIndex.has(lower)) {
			if (!selfNames.has(lower)) {
				return { target: this.linkIndex.get(lower)!, isPartial: false, matchedString: lower };
			}
		}

		if (!this.settings.matchStart && !this.settings.matchEnd && !this.settings.matchMiddle) {
			return { target: null, isPartial: false, matchedString: "" };
		}

		if (word.length < this.settings.minMatchLength) {
			return { target: null, isPartial: false, matchedString: "" };
		}

		const minLen = this.settings.minMatchLength;
		for (let len = lower.length - 1; len >= minLen; len--) {
			for (let i = 0; i <= lower.length - len; i++) {
				const sub = lower.substring(i, i + len);
				
				if (selfNames.has(sub)) continue;

				if (this.linkIndex.has(sub)) {
					const isStart = (i === 0);
					const isEnd = (i + len === lower.length);
					const isMiddle = !isStart && !isEnd;
					
					let isValid = false;
					if (isStart && this.settings.matchStart) isValid = true;
					if (isEnd && this.settings.matchEnd) isValid = true;
					if (isMiddle && this.settings.matchMiddle) isValid = true;

					if (isValid) {
						return { 
							target: this.linkIndex.get(sub)!, 
							isPartial: true, 
							matchedString: sub 
						};
					}
				}
			}
		}
		return { target: null, isPartial: false, matchedString: "" };
	}

	getFileForView(view: EditorView): TFile | null {
		let foundFile: TFile | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				// @ts-ignore
				if (leaf.view.editor.cm === view) {
					foundFile = leaf.view.file;
				}
			}
		});
		return foundFile;
	}

	debugLog(message: string, ...args: any[]) {
		if (this.settings.debugMode) {
			console.log(`[Lazy Links] ${message}`, ...args);
		}
	}

	rebuildIndex() {
		this.debugLog("Rebuilding Index...");
		const newIndex = new Map<string, LinkTarget>();
		const files = this.app.vault.getMarkdownFiles();
		let aliasCount = 0;
		let headerCount = 0;
		let ignoredCount = 0;

		files.forEach((file) => {
			const cache = this.app.metadataCache.getFileCache(file);

			if (cache?.frontmatter && cache.frontmatter['ignore_linking'] === true) {
				ignoredCount++;
				return;
			}

			if (this.settings.includeHeaders && cache?.headings) {
				cache.headings.forEach((h: HeadingCache) => {
					let isEnabled = false;
					// @ts-ignore
					if (this.settings.headerLevels[`h${h.level}`]) isEnabled = true;

					if (isEnabled) {
						const headerText = h.heading;
						if (headerText.length >= this.settings.minMatchLength) {
							newIndex.set(headerText.toLowerCase(), {
								file: file,
								isAlias: false,
								actualName: headerText,
								subpath: `#${headerText}`
							});
							headerCount++;
						}
					}
				});
			}

			if (cache?.frontmatter?.aliases) {
				const aliases = cache.frontmatter.aliases;
				const aliasArray = Array.isArray(aliases) ? aliases : [aliases];
				aliasArray.forEach((alias: string) => {
					if (typeof alias === 'string') {
						newIndex.set(alias.toLowerCase(), {
							file: file,
							isAlias: true,
							actualName: alias
						});
						aliasCount++;
					}
				});
			}

			newIndex.set(file.basename.toLowerCase(), {
				file: file,
				isAlias: false,
				actualName: file.basename
			});
		});
		
		this.linkIndex = newIndex;
		this.debugLog(`Index rebuilt. Files: ${files.length - ignoredCount}, Aliases: ${aliasCount}, Headers: ${headerCount}`);
	}

	getWordAtPosition(editor: Editor, position: any): { word: string, from: any, to: any } | null {
		const line = editor.getLine(position.line);
		const wordRegex = /\b\w+\b/g; 
		let match;
		while ((match = wordRegex.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.ch >= start && position.ch <= end) {
				return { word: match[0], from: { line: position.line, ch: start }, to: { line: position.line, ch: end } };
			}
		}
		return null;
	}

	convertLink(editor: Editor, wordInfo: { word: string, from: any, to: any }, target: LinkTarget) {
		let replacementText = "";
		const filePart = target.file.basename;
		const linkPath = target.subpath ? `${filePart}${target.subpath}` : filePart;

		if (wordInfo.word === target.actualName) {
			if (target.subpath) replacementText = `[[${linkPath}|${wordInfo.word}]]`;
			else replacementText = `[[${linkPath}]]`;
		} else {
			replacementText = `[[${linkPath}|${wordInfo.word}]]`;
		}
		editor.replaceRange(replacementText, wordInfo.from, wordInfo.to);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class LazyLinksSettingTab extends PluginSettingTab {
	plugin: LazyLinksPlugin;

	constructor(app: App, plugin: LazyLinksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Lazy Links Settings' });

		new Setting(containerEl)
			.setName('Enable Debug Mode')
			.setDesc('Print logs to console.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugMode)
				.onChange(async (value) => {
					this.plugin.settings.debugMode = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Views Support' });
		
		new Setting(containerEl)
			.setName('Enable Reading Mode & Canvas Support')
			.setDesc('Shows lazy links in Reading View and non-editing Canvas cards. NOTE: This may affect performance on large Canvases.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableReadingMode)
				.onChange(async (value) => {
					this.plugin.settings.enableReadingMode = value;
					await this.plugin.saveSettings();
					new Notice('Please reload your Canvas or switch views to see changes.');
				}));

		containerEl.createEl('h3', { text: 'Matching Logic' });

		new Setting(containerEl)
			.setName('Match Start of Word')
			.setDesc('e.g. "Fruits" matches "Fruit"')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.matchStart)
				.onChange(async (value) => {
					this.plugin.settings.matchStart = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Match End of Word')
			.setDesc('e.g. "Pineapple" matches "Apple"')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.matchEnd)
				.onChange(async (value) => {
					this.plugin.settings.matchEnd = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Match Middle of Word')
			.setDesc('e.g. "Snapplejuice" matches "Apple"')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.matchMiddle)
				.onChange(async (value) => {
					this.plugin.settings.matchMiddle = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Minimum Match Length')
			.addText(text => text
				.setValue(String(this.plugin.settings.minMatchLength))
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num)) {
						this.plugin.settings.minMatchLength = num;
						await this.plugin.saveSettings();
					}
				}));

		containerEl.createEl('h3', { text: 'Header Indexing' });

		new Setting(containerEl)
			.setName('Enable Header Indexing')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeHeaders)
				.onChange(async (value) => {
					this.plugin.settings.includeHeaders = value;
					await this.plugin.saveSettings();
					this.plugin.rebuildIndex();
				}));

		const levels = [1, 2, 3, 4, 5, 6];
		levels.forEach(level => {
			new Setting(containerEl)
				.setName(`Index H${level} Headers`)
				.setClass('virtual-linker-sub-setting') 
				.addToggle(toggle => toggle
					// @ts-ignore
					.setValue(this.plugin.settings.headerLevels[`h${level}`])
					.onChange(async (value) => {
						// @ts-ignore
						this.plugin.settings.headerLevels[`h${level}`] = value;
						await this.plugin.saveSettings();
						if (this.plugin.settings.includeHeaders) this.plugin.rebuildIndex();
					}));
		});
	}
}