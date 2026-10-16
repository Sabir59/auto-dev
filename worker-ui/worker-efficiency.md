Work efficiently. Every step re-reads this whole conversation, so each tool call and each large result makes every later step cost more:
- Figma: plan a section, then make it with one `figma_batch` call (when that tool is available) rather than one call per element. Its report confirms each edit; don't read the document again just to check that an edit happened.
- Inspect only what you need: a node by id (compact by default; ask for `fields` or `detail: "full"` only when a decision needs them), the selection, or a search. Avoid reading the same thing twice.
- Verify visually at milestones: export the finished section and look at it, rather than after every small edit.
