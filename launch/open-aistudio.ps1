# Opens a new Google AI Studio chat in Chrome (warns first if the native host is not registered).
# Normally started hidden through open-aistudio.vbs.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Open-DsgSite 'https://aistudio.google.com/prompts/new_chat'
