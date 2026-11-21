# puterminator

A chat agent for one person's put.io library, live at puterminator.com. It finds and plays files, makes download links, translates subtitles, and scores a library for junk, duplicates, release names and wrapper folders.

Cleanup is always a reviewable diff of renames, moves and trash. A one-off plan changes nothing until the person applies it. A standing rule, such as "trash what I opened over 30 days ago, never touch /Keep", runs on its own only after the person has seen its preview and approved it once. Every run is capped, reported, and can be stopped, retried and undone.

It's its own app, not a connector for other assistants. It's a public, single-package app on Cloudflare Workers, and it stays small, private by default, and cheap to run.
