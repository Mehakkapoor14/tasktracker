# Changelog

## Unreleased

- 📅 **Calendar:** day, week and month views of your time, for every project (home page → Calendar) or one (a board's Calendar view). Set **working hours** per day with breaks; **block time** for meetings and appointments by dragging, add **time off**, and drag tasks from *To plan* to **book time** for them. Blocks repeat, and one event of a series can be moved, renamed or removed on its own.
- 📊 **What fits:** each day shows its free time, and flags when more estimated work is due by then than there's time for.
- ✨ **Plan my week:** fits what's left of your tasks' estimates into free working time, most important first and before deadlines, in sessions of up to 2h (adjustable). Review the dashed plan, leave sessions out, then book it.
- 🤖 **The assistant and agents plan too:** ask *"fit my high-priority tasks into my free time this week"* and each suggested session appears on the approval card. Five new MCP tools: `get_calendar`, `plan_time`, `block_time`, `update_block`, `delete_block`.
- 🔔 Reminders shortly before meetings and booked task time.
- ⏱️ **Estimates:** size tasks XS–XL (30m to 3d) or set an exact amount; see tracked time against it, with an amber hint when over. Totals on column headers and project cards. Quick add: `~2h`, `~M`.
- 💰 **Cost:** an optional hourly rate and currency per project turns estimates and tracked time into cost. Hidden unless a rate is set.
- 📝 **Markdown notes:** formatted by default, click to write, tickable checklists, tables and code, ` ```mermaid ` diagrams, and an expanded side-by-side writer.
- 🤝 **When two agents touch the same card:** agents can mark a card as being worked on (`claim_task` / `release_task`). Claims are leases, not locks: they expire after 30 minutes without activity, clear when the agent disconnects or the card is done, and you can release one anytime.
- ⚠️ **No stale overwrites:** requests remember the values they'd replace; changes made since the agent asked are flagged and start unticked.
- Side panels now close with a single Esc (the close button's tooltip no longer pops up on open).
- 🔁 **Repeating tasks:** every day, weekday, week, 2 weeks, month or year. Finishing one adds the next with its deadline (and start) moved on, never already overdue, with fresh subtasks. Undo takes the new one back. Agents and chat can set `repeat` too.
- 📦 **Move tasks between projects** from the task panel's ⋯ menu; the task keeps its status when the other project has a column with the same name. Agents and chat can pass `project` to `move_task`.
- ↕️ **Sort the home page by priority** (urgent first), or keep your own drag order.
- Drag subtasks by their grip to reorder them.
- 🎙️ **Push-to-talk:** in chat, hold Space to speak and let go to send.
- 🎨 **Seven new themes:** Catppuccin Latte and Mocha, Tokyo Night, Everforest and Everforest Light, Nord and Kanagawa (31 in all). Colours follow the originals, adjusted where needed so text stays readable.

## v1.0.0 · 2026-10-04

The first stable release: a local-first task board for you and your AI agents.

### 🤖 Work with AI agents
- **MCP server with 19 tools** so Claude Code, Cursor and other agents can plan, update and complete tasks.
- **Agents ask first** (default): their changes wait in the 🤖 Agent requests inbox, in plain words, until you approve. Switch to *Apply right away* when you trust an agent. Agents can check the outcome with `get_request`.

### ✨ Built-in assistant
- Chat with any OpenAI-compatible provider (OpenAI, OpenRouter, Groq, Ollama, LM Studio), grounded in a snapshot of your board.
- **Proposes, you approve**: changes appear on an approval card, are checked against the board's rules, and apply all-or-nothing. It can't delete anything.
- **Voice**: speak your question, hear the answer, hands-free. Uses your provider's speech models or the browser's.
- Plain-language errors when the provider is down, the key is wrong or the URL is off.

### 🗓️ Planning
- **Timeline (Gantt)** per project and across all projects, with drag to reschedule and optional start dates.
- Projects with a home page, **priorities** and **tags**; colour tags on tasks; deadlines that read like a person wrote them.
- Quick add: `Send invoice @fri !high #finance`.

### 🧘 Everyday
- Installable app (PWA) with deadline reminders that work while it's closed.
- Twenty-four focus-friendly themes.
- One SQLite file on your machine. No account, no cloud, no telemetry.
