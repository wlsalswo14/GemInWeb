# Opens Gemini web in Chrome (warns first if the native host is not registered).
# Normally started hidden through open-gemini.vbs.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Open-DsgSite 'https://gemini.google.com/app'
