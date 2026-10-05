@echo off
rem Windows stand-in for the fake Codex: runs through cmd.exe like an npm-installed codex.cmd.
node "%~dp0fake-codex.cjs" %*
