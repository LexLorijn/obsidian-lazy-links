Lazy Links for Obsidian 🔗

Let's face it: manually wrapping every other word in [[brackets]] kills your flow.

You're trying to write, but you're also trying to manage your knowledge graph at the same time. "Do I have a note for this?" "Should I link this?" "Wait, did I call that file Apple or Apples?"

Lazy Links solves this by separating writing from linking.

What it does

Lazy Links scans your text while you type. If you type a word that matches an existing note (or Alias, or Header), it highlights it with a subtle dashed underline.

It's not a real link yet. It stays as plain text. It doesn't clutter your markdown.

It's there if you need it. Right-click the highlighted word to instantly convert it into a [[Real Link]].

Why "Lazy"?

Because you shouldn't have to work hard to connect your thoughts.

Write now, link later. Just get your thoughts down. The plugin will light up the connections for you.

No more "False Links". Stop creating [[Links To Nowhere]] just because you thought you had a note on that topic. Lazy Links only highlights what actually exists.

Clutter-free Canvas. Works beautifully in Obsidian Canvas cards to show connections without the visual noise of blue text everywhere.

Features

1. Smart Matching (The "Pineapple" Problem)

Computers are usually dumb. If you have a note called Apple, they won't recognize the word Pineapple or Applepie. We fixed that.

Start Matching: Matches Fruits to Fruit.

End Matching: Matches Pineapple to Apple.

Middle Matching: (Optional) Matches Snapplejuice to Apple.

2. Header Deep-Linking

If you have a massive note called Business.md with a section ## Staff, typing "Staff" in another note can suggest a link directly to [[Business#Staff]].

3. Visual Zen

First Match: The first time a word appears, it gets a nice accent color.

Subsequent Matches: If you use the word "Apple" 10 times in a paragraph, we fade the highlights out so your screen doesn't look like a Christmas tree.

Flash: When you click a header link, we customized the flash to be a subtle transparent pulse instead of that jarring bright yellow.

4. Reading Mode & Canvas Support

By default, Lazy Links runs in the Editor. You can enable support for Reading Mode and Canvas in the settings. This turns your static notes into a discovery engine.

Configuration

Ignoring Common Words

Have a note called The.md or It.md? You probably don't want every sentence to light up.
Simply add this to the frontmatter of that file:

---
ignore_linking: true
---


Performance

We built this with large vaults in mind.

Typing is O(1): Typing is instantaneous, no matter how many files you have.

Indexing is Debounced: We wait until you stop renaming files before we rebuild the index, so your computer doesn't freeze up during batch changes.

Installation

Via BRAT (Recommended for Beta)

The easiest way to install this before it hits the Community Store is using BRAT:

Install BRAT from the Obsidian Community Plugins list.

Open the Command Palette (Ctrl/Cmd + P) and search for BRAT: Add a beta plugin for testing.

Paste this repo URL: https://github.com/yourusername/obsidian-lazy-links.

Click "Add Plugin".

Manual Installation

Download main.js, manifest.json, and styles.css from the latest Release.

Copy them to your vault folder: .obsidian/plugins/obsidian-lazy-links.

Reload Obsidian.

MIT License. Made with ❤️ and a lot of coffee.