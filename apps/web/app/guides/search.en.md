# Search files

Search finds titles and the body text of HTML and Markdown files, including HTML and Markdown pages in static sites. It uses the current published version. PDF and video files match by title and description; PDF body text and video speech are not included.

Open search with **⌘K / Ctrl+K**, or press **/** outside a text-entry field. Shortcuts and Enter do not run search actions while you are composing text with an IME.

Enter search words and narrow by **Owner**, **Project**, and **Period**. For the period, choose **Updated date** for file activity or **Last viewed by me** for your own latest visit, then set the date range.

Press **Enter** without selecting a suggestion to open the full results page. After selecting a suggestion with the arrow keys, Enter activates that suggestion:

- An owner or project adds a search condition.
- A file opens that file.
- A search history entry reruns that search.
- The all-results option opens the full results page.

Suggestions cover a narrower set of files than full results, so a missing suggestion does not mean there are no matches.

Admin rights alone do not make a file appear in search, even if those rights let you open it. Search includes eligible files you own, files shared directly with you, and files shared with you through a workspace or project. Files available to you only through link sharing appear only after you have opened them while signed in, and only while the link is active and workspace link sharing is enabled. Files in archived projects are excluded by default.

Agents and scripts search these files through MCP `list_artifacts` and the CLI `artifacts list --q`; restricted agent and bot credentials see only the projects they can read. The filters and error handling are described in the [CLI reference](/guides/cli#recovery).
