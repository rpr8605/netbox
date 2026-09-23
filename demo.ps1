# demo.ps1 — one-command Beacon Relay demo launcher for Windows PowerShell.
# Usage:
#   .\demo.ps1          Start the demo stack, seed hospitals, run timeline.
#   .\demo.ps1 -Stop    Stop the stack.
#   .\demo.ps1 -Reset   Stop the stack and remove local demo data.
param(
    [switch]$Stop,
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'

if ($Reset) {
    npm run demo:reset
    exit
}

if ($Stop) {
    docker compose down
    exit
}

# Start the full demo.
$env:DEMO_MODE = '1'
npm run demo

# Best-effort browser launch after the demo starts.
Start-Process 'https://localhost:10443/fleet.html?demo=1'
Start-Process 'https://localhost:10443/index.html?demo=1'
