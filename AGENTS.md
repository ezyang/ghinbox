---- >8 ----
!!! FIRST TIME INSTRUCTIONS !!!
1. The user has initialized this project from a template!  Let's fill in details
2. Update pyproject.yaml with the project name and description based on the user description
3. Depending on if this is a library or a command line app, create the scaffolding in PROJECTNAME/ accordingly
4. Run 'uv lock' to generate a lockfile
5. Delete these instructions from AGENTS.md, you only run these the first time!
---- >8 ----
- ONLY use non-interactive commands like cat, sed, apply_patch to do edits.
  Do NOT use interactive editors.
- Do NOT attempt to install packages.  Only the packages specified in
  pyproject.toml are available.  You cannot add new packages.  If you
  desperately want another package, make a note of it in the final PR
  description.
- Use conventional commits to format PR title
- There are no nested AGENTS.md files, this is the only agents file
- Use "ruff check" to check lint, "ruff format" to autoformat files and
  "pyrefly" to typecheck.
- When writing the PR description, include the original user request VERBATIM.
