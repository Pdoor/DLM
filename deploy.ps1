param(
    [string]$Message = "Deploy Destiny Lore Masters web app"
)

$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/Pdoor/DLM.git"
$Branch = "main"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Set-Location $ProjectDir

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git non trovato. Installa Git oppure apri questo script da un terminale dove git e disponibile."
}

if (-not (Test-Path ".git")) {
    git init
}

$currentBranch = git branch --show-current
if (-not $currentBranch) {
    git checkout -b $Branch
} elseif ($currentBranch -ne $Branch) {
    git branch -M $Branch
}

$remotes = @(git remote)
if ($remotes -notcontains "origin") {
    git remote add origin $RepoUrl
} else {
    $remoteExists = git remote get-url origin
    if ($remoteExists -ne $RepoUrl) {
    git remote set-url origin $RepoUrl
    }
}

git add index.html DLM.jpg dlm.ico server.py README.md .github/workflows/pages.yml scripts/fetch-data.js data/clan-status.json deploy.ps1 deploy.sh

$changes = git status --porcelain
if (-not $changes) {
    Write-Host "Nessuna modifica da committare."
} else {
    git commit -m $Message
}

git push -u origin $Branch

Write-Host ""
Write-Host "Deploy inviato su $RepoUrl"
Write-Host "GitHub Pages: Settings > Pages > Build and deployment > GitHub Actions"
