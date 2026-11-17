<#
.SYNOPSIS
    Publica una nueva version de MadPost Desktop en GitHub Releases y actualiza
    el manifiesto Tauri Updater del canal correspondiente.

.DESCRIPTION
    Flujo:
      1. Preflight: dependencias, auth, semver, coincidencia de version compilada.
      2. Opcional: compila con `npm run tauri build` (omitir con -SkipBuild).
      3. Localiza .exe y .exe.sig en la carpeta bundle NSIS.
      4. Crea el GitHub Release y sube .exe + .sig como assets.
      5. Genera el JSON de manifiesto Tauri v2 con la firma real del .sig.
      6. Sube stable-latest.json o beta-latest.json como asset del mismo release.
      7. Actualiza la rama `releases-manifest` con el manifiesto (via git worktree).
      8. Imprime resumen. Codigo de salida != 0 si el proceso es incompleto.

    REPOSITORIO PRIVADO: los manifiestos se publican como assets del release
    (accesibles con el token de GitHub que ya usa update_installer.rs) y tambien
    en la rama releases-manifest (para cuando se active el plugin oficial).

.PARAMETER Version
    Version SemVer sin prefijo "v". Ej: "1.9.0" o "1.10.0-beta.1".

.PARAMETER Channel
    "stable" o "beta". stable exige version sin pre-release. beta exige pre-release.

.PARAMETER Notes
    Notas de release para los usuarios. Se pasan tal cual a GitHub y al manifiesto.

.PARAMETER NotesFile
    Ruta a un archivo .txt o .md con las notas. Alternativa a -Notes.

.PARAMETER SkipBuild
    Si se indica, usa el artefacto ya compilado en la carpeta bundle. Exige
    verificacion extra de que el .exe corresponde exactamente a la version indicada.

.PARAMETER UpdateOnly
    Recompila y reemplaza solo los assets (.exe, .sig, manifiesto) de un release ya
    existente en GitHub. No crea tag ni release nuevo. Las notas NO se modifican a
    menos que se pase -Notes o -NotesFile explicitamente.
    Requiere que el tag v{Version} y el release ya existan en GitHub.

.PARAMETER NotesOnly
    Edita solo las notas de un release existente en GitHub. No recompila ni modifica
    assets. Requiere -Notes o -NotesFile. El release ya debe existir.

.PARAMETER BuildOnly
    Solo compila el proyecto con la clave de firma y deja los artefactos en
    src-tauri\target\release\bundle\nsis\. No crea tag, release ni toca GitHub.
    Util para verificar que el build funciona antes de publicar.

.PARAMETER DryRun
    Ejecuta todas las validaciones y genera el JSON localmente pero NO crea tags,
    releases, commits ni modifica la rama remota.

.PARAMETER Repo
    Repositorio GitHub en formato "owner/repo". Default: detectado del remote origin.

.EXAMPLE
    .\scripts\publish-release.ps1 -Version "1.9.0" -Channel stable -Notes "Mejoras y correcciones"
    .\scripts\publish-release.ps1 -Version "1.10.0-beta.1" -Channel beta -Notes "Vista previa" -DryRun
    .\scripts\publish-release.ps1 -Version "1.9.0" -Channel stable -NotesFile ".\CHANGELOG.md" -SkipBuild
    .\scripts\publish-release.ps1 -Version "1.9.0-beta.1" -Channel beta -UpdateOnly
    .\scripts\publish-release.ps1 -Version "1.9.0-beta.1" -Channel beta -Notes "Nuevas notas" -NotesOnly
    .\scripts\publish-release.ps1 -Version "1.9.0-beta.1" -Channel beta -BuildOnly
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][ValidateSet("stable","beta")][string]$Channel,
    [string]$Notes,
    [string]$NotesFile,
    [switch]$SkipBuild,
    [switch]$UpdateOnly,
    [switch]$NotesOnly,
    [switch]$BuildOnly,
    [switch]$DryRun,
    [string]$Repo
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Ejecuta un comando nativo y retorna su exit code sin que Stop lance excepcion.
function Invoke-Native {
    $ErrorActionPreference = "Continue"
    & $args[0] $args[1..($args.Length-1)] 2>&1
    $ec = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    return $ec
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "    [WARN] $msg" -ForegroundColor Yellow }
function Write-Fail  { param([string]$msg) Write-Host "`n[FAIL] $msg" -ForegroundColor Red; exit 1 }

function Assert-Command {
    param([string]$cmd, [string]$hint)
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Fail "$cmd no encontrado. $hint"
    }
}

function Parse-SemVer {
    param([string]$v)
    # Acepta: 1.9.0  1.10.0-beta.1  1.10.0-beta.1+build
    if ($v -match '^(\d+)\.(\d+)\.(\d+)(-([a-zA-Z0-9.\-]+))?(\+[a-zA-Z0-9.\-]+)?$') {
        return @{
            Major = [int]$Matches[1]
            Minor = [int]$Matches[2]
            Patch = [int]$Matches[3]
            PreRelease = if ($Matches[5]) { $Matches[5] } else { "" }
            Raw = $v
        }
    }
    return $null
}

function Compare-SemVer {
    # Retorna: 1 si a > b, -1 si a < b, 0 si iguales
    # Pre-release se considera MENOR que la version sin pre-release (SemVer spec)
    param($a, $b)
    foreach ($field in @("Major","Minor","Patch")) {
        if ($a.$field -gt $b.$field) { return 1 }
        if ($a.$field -lt $b.$field) { return -1 }
    }
    # Misma base numerica: sin pre-release > con pre-release
    if (-not $a.PreRelease -and $b.PreRelease)  { return 1  }
    if ($a.PreRelease -and -not $b.PreRelease)  { return -1 }
    if ($a.PreRelease -and $b.PreRelease) {
        return [string]::CompareOrdinal($a.PreRelease, $b.PreRelease)
    }
    return 0
}

# ---------------------------------------------------------------------------
# 0. VARIABLES DE FIRMA -- obligatorias antes de todo
# ---------------------------------------------------------------------------
Write-Step "Verificando variables de firma"

# Detectar raiz del proyecto desde la ubicacion del script
$projectRoot = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $projectRoot ".env"

# Leer .env y extraer variables relevantes
$envVars = @{}
if (Test-Path $envFile) {
    Get-Content $envFile | Where-Object { $_ -match '^\s*([^#][^=]+?)\s*=\s*(.*)\s*$' } | ForEach-Object {
        $envVars[$Matches[1].Trim()] = $Matches[2].Trim()
    }
} else {
    Write-Fail @"
No se encontro el archivo .env en la raiz del proyecto.
Crealo con:

    TAURI_SIGNING_PRIVATE_KEY_PATH=C:\Users\juanm\.tauri\madpost-updater.key
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD=

El archivo .env ya esta en .gitignore -- no se sube al repositorio.
"@
}

# Validar y cargar TAURI_SIGNING_PRIVATE_KEY desde la ruta indicada en el .env
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $keyPath = $envVars["TAURI_SIGNING_PRIVATE_KEY_PATH"]
    if (-not $keyPath) {
        Write-Fail "TAURI_SIGNING_PRIVATE_KEY_PATH no esta definida en .env.`nAgrega: TAURI_SIGNING_PRIVATE_KEY_PATH=C:\Users\juanm\.tauri\madpost-updater.key"
    }
    if (-not (Test-Path $keyPath)) {
        Write-Fail "No se encontro la clave de firma en: $keyPath`nVerifica que la ruta en TAURI_SIGNING_PRIVATE_KEY_PATH sea correcta."
    }
    $keyContent = Get-Content $keyPath -Raw -Encoding UTF8
    if (-not $keyContent -or $keyContent.Trim() -eq "") {
        Write-Fail "El archivo de clave esta vacio: $keyPath"
    }
    Set-Item -Path "Env:TAURI_SIGNING_PRIVATE_KEY" -Value $keyContent
}

# Cargar password (puede ser vacia)
if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    $pwd = if ($envVars.ContainsKey("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")) { $envVars["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"] } else { "" }
    Set-Item -Path "Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD" -Value $pwd
}

Write-Ok "Variables de firma cargadas desde: $($envVars['TAURI_SIGNING_PRIVATE_KEY_PATH'])"

# ---------------------------------------------------------------------------
# MODO BuildOnly: compila y sale. No toca GitHub.
# ---------------------------------------------------------------------------
if ($BuildOnly) {
    Write-Step "Modo BuildOnly -- compilando v$Version (sin GitHub)"
    Set-Location $projectRoot
    $ErrorActionPreference = "Continue"
    npm run tauri build 2>&1
    $buildEc = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($buildEc -ne 0) { Write-Fail "La compilacion fallo (exit $buildEc)." }
    $bundleDir = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis"
    $exeFile   = Get-ChildItem $bundleDir -Filter "*.exe" | Where-Object { $_.Name -notlike "*-setup.exe" -or $_.Name -like "*-setup.exe" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $sigFile   = Get-ChildItem $bundleDir -Filter "*.exe.sig" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Write-Ok "Build completado."
    if ($exeFile) { Write-Ok "EXE: $($exeFile.FullName)" }
    if ($sigFile) { Write-Ok "SIG: $($sigFile.FullName)" }
    exit 0
}

# ---------------------------------------------------------------------------
# 1. PREFLIGHT
# ---------------------------------------------------------------------------
Write-Step "Preflight"

Assert-Command "git"  "Instala Git: https://git-scm.com"
Assert-Command "gh"   "Instala GitHub CLI: https://cli.github.com"
Assert-Command "npm"  "Instala Node.js: https://nodejs.org"

# Repo
if (-not $Repo) {
    $remoteUrl = git remote get-url origin 2>&1
    if ($remoteUrl -match "github\.com[:/](.+?)(?:\.git)?$") {
        $Repo = $Matches[1]
    } else {
        Write-Fail "No se pudo detectar el repositorio desde git remote. Usa -Repo owner/repo."
    }
}
Write-Ok "Repo: $Repo"

# Auth gh
$ErrorActionPreference = "Continue"
$authCheck = gh auth status 2>&1
$authEc = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($authEc -ne 0) { Write-Fail "GitHub CLI no autenticado. Ejecuta: gh auth login" }
Write-Ok "gh autenticado"

# Visibilidad del repo
$repoMeta = gh repo view $Repo --json isPrivate | ConvertFrom-Json
$isPrivate = $repoMeta.isPrivate
if ($isPrivate) {
    Write-Warn "El repositorio es PRIVADO. Los manifiestos se publicaran como assets del release."
    Write-Warn "Las URLs raw.githubusercontent.com NO son accesibles sin autenticacion en repos privados."
    Write-Warn "El actualizador actual (update_installer.rs) ya usa token GitHub -- compatible."
}

$tauriConfPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
$cargoTomlPath = Join-Path $projectRoot "src-tauri\Cargo.toml"
if (-not (Test-Path $tauriConfPath)) { Write-Fail "No encontrado: $tauriConfPath. Ejecuta desde la raiz del proyecto." }

# ---------------------------------------------------------------------------
# 1. VALIDACION SEMVER Y CANAL
# ---------------------------------------------------------------------------
Write-Step "Validando version y canal"

$semver = Parse-SemVer $Version
if (-not $semver) { Write-Fail "Version '$Version' no es SemVer valido. Ej: 1.9.0 o 1.10.0-beta.1" }

if ($Channel -eq "stable" -and $semver.PreRelease) {
    Write-Fail "Canal 'stable' requiere version sin pre-release. '$Version' tiene pre-release '$($semver.PreRelease)'."
}
if ($Channel -eq "beta" -and -not $semver.PreRelease) {
    Write-Fail "Canal 'beta' requiere version con pre-release (ej: 1.10.0-beta.1). '$Version' no tiene pre-release."
}
Write-Ok "Version $Version es valida para canal $Channel"

# ---------------------------------------------------------------------------
# 2. NOTAS
# ---------------------------------------------------------------------------
if ($NotesFile) {
    if (-not (Test-Path $NotesFile)) { Write-Fail "NotesFile no encontrado: $NotesFile" }
    $Notes = Get-Content $NotesFile -Raw -Encoding UTF8
}
# NotesOnly siempre requiere notas explicitas
if ($NotesOnly -and -not $Notes) { Write-Fail "-NotesOnly requiere -Notes o -NotesFile con el nuevo texto." }
# Release nuevo siempre requiere notas
if (-not $UpdateOnly -and -not $NotesOnly -and -not $Notes) {
    Write-Fail "Debes proporcionar -Notes o -NotesFile con la descripcion del release."
}
# UpdateOnly sin notas: leer las notas actuales del release para incluirlas en el manifiesto
if ($UpdateOnly -and -not $Notes) {
    Write-Step "Leyendo notas actuales del release v$Version"
    $ErrorActionPreference = "Continue"
    $existingRelease = gh release view "v$Version" --repo $Repo --json body | ConvertFrom-Json
    $ErrorActionPreference = "Stop"
    $Notes = if ($existingRelease.body) { $existingRelease.body } else { "" }
    Write-Ok "Notas leidas del release existente"
}

# ---------------------------------------------------------------------------
# 2b. NOTESONLY: editar solo las notas y salir
# ---------------------------------------------------------------------------
if ($NotesOnly) {
    Write-Step "NotesOnly: actualizando notas del release v$Version"
    $ErrorActionPreference = "Continue"
    $null = gh release view "v$Version" --repo $Repo 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Fail "NotesOnly requiere que el release v$Version ya exista en GitHub." }
    gh release edit "v$Version" --repo $Repo --notes $Notes
    $editEc = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($editEc -ne 0) { Write-Fail "gh release edit fallo." }
    Write-Ok "Notas del release v$Version actualizadas"
    Write-Host "`n[NotesOnly completado] Solo se editaron las notas. Sin recompilacion ni cambio de assets." -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# 3. VERIFICAR COINCIDENCIA DE VERSION EN PROYECTO
# ---------------------------------------------------------------------------
# UpdateOnly solo regenera assets de un release existente -- no recompila,
# por lo que los archivos locales pueden estar en otra version. Se omite la validacion.
if (-not $UpdateOnly) {
Write-Step "Verificando version en Cargo.toml y tauri.conf.json"

# Cargo.toml
$cargoContent = Get-Content $cargoTomlPath -Raw
if ($cargoContent -match 'version\s*=\s*"([^"]+)"') {
    $cargoVersion = $Matches[1]
} else {
    Write-Fail "No se pudo leer la version de Cargo.toml"
}

# tauri.conf.json
$tauriConf = Get-Content $tauriConfPath -Raw | ConvertFrom-Json
$tauriVersion = $tauriConf.version

if ($cargoVersion -ne $Version) {
    Write-Fail "Version en Cargo.toml ('$cargoVersion') != Version indicada ('$Version'). Actualiza Cargo.toml antes de publicar."
}
if ($tauriVersion -ne $Version) {
    Write-Fail "Version en tauri.conf.json ('$tauriVersion') != Version indicada ('$Version'). Actualiza tauri.conf.json antes de publicar."
}
Write-Ok "Versiones sincronizadas: Cargo=$cargoVersion, tauri.conf=$tauriVersion"
} # fin if (-not $UpdateOnly)

# ---------------------------------------------------------------------------
# 4. TAG Y RELEASE DUPLICADO
# ---------------------------------------------------------------------------
Write-Step "Verificando tag v$Version"

$ErrorActionPreference = "Continue"
$tagExists = git tag -l "v$Version"
$null = gh release view "v$Version" --repo $Repo 2>&1
$releaseAlreadyExists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = "Stop"

if ($UpdateOnly) {
    if (-not $releaseAlreadyExists) {
        Write-Fail "UpdateOnly requiere que el release v$Version ya exista en GitHub. Publicalo primero sin -UpdateOnly."
    }
    Write-Ok "UpdateOnly: release v$Version encontrado, se reemplazaran los assets"
} else {
    if ($releaseAlreadyExists) {
        Write-Fail "El release v$Version ya existe en GitHub. Para reemplazar assets usa -UpdateOnly."
    }
    Write-Ok "Tag verificado"
}

# ---------------------------------------------------------------------------
# 5. BUILD O VERIFICACION DE ARTEFACTO EXISTENTE
# ---------------------------------------------------------------------------
$bundleDir = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis"

# Nombre real que genera Tauri: "MadPost Desktop_{version}_x64-setup.exe"
# Al subir a GitHub se renombra a "MadPost.Desktop_{version}_x64-setup.exe" (con punto)
$localExeName = "MadPost Desktop_${Version}_x64-setup.exe"
$localSigName = "MadPost Desktop_${Version}_x64-setup.exe.sig"
$githubAssetName = "MadPost.Desktop_${Version}_x64-setup.exe"
$githubSigName   = "MadPost.Desktop_${Version}_x64-setup.exe.sig"

$exePath = Join-Path $bundleDir $localExeName
$sigPath = Join-Path $bundleDir $localSigName

if (-not $SkipBuild) {
    Write-Step "Compilando (npm run tauri build)"

    if ($DryRun) {
        Write-Warn "DryRun activo: se omite la compilacion real."
    } else {
        Push-Location $projectRoot
        try {
            $ErrorActionPreference = "Continue"
            npm run tauri build
            $buildEc = $LASTEXITCODE
            $ErrorActionPreference = "Stop"
            if ($buildEc -ne 0) { Write-Fail "npm run tauri build fallo con codigo $buildEc." }
        } finally {
            Pop-Location
        }
    }
} else {
    Write-Step "SkipBuild: verificando artefacto existente"
    if (-not (Test-Path $exePath)) {
        Write-Fail "No encontrado: $exePath`nCompila primero con 'npm run tauri build' o quita -SkipBuild."
    }

    # Verificar que el exe es reciente (no un artefacto viejo de otra version)
    $exeModified = (Get-Item $exePath).LastWriteTimeUtc
    $ageHours = ([datetime]::UtcNow - $exeModified).TotalHours
    if ($ageHours -gt 48) {
        Write-Warn "El artefacto $localExeName tiene $([math]::Round($ageHours))h de antiguedad."
        $confirm = Read-Host "    Continuar igualmente? (s/N)"
        if ($confirm -notmatch '^[sS]$') { Write-Fail "Publicacion cancelada por el operador." }
    }
}

# Verificar que existen ambos artefactos
if (-not (Test-Path $exePath)) { Write-Fail "Artefacto no encontrado: $exePath" }
if (-not (Test-Path $sigPath)) {
    Write-Fail @"
Firma no encontrada: $sigPath
Esto ocurre si el build se hizo sin TAURI_SIGNING_PRIVATE_KEY o sin createUpdaterArtifacts:true.
Recompila con las variables de firma definidas en la sesion.
"@
}

# Verificar que .sig no esta vacio
$sigContent = (Get-Content $sigPath -Raw -Encoding UTF8).Trim()
if (-not $sigContent) { Write-Fail "El archivo .sig esta vacio: $sigPath" }
Write-Ok "Artefactos encontrados: $localExeName + .sig"

# ---------------------------------------------------------------------------
# 6. DRY RUN: generar manifiesto local y salir
# ---------------------------------------------------------------------------
$manifestFileName = if ($Channel -eq "stable") { "stable-latest.json" } else { "beta-latest.json" }
$pubDate = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")

# Para dry-run usamos una URL de ejemplo; en run real la completamos tras el upload
$manifestDryRun = [ordered]@{
    version  = $Version
    notes    = $Notes
    pub_date = $pubDate
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            url       = "https://github.com/$Repo/releases/download/v$Version/$githubAssetName"
            signature = $sigContent
        }
    }
}

if ($DryRun) {
    Write-Step "DryRun: manifiesto generado localmente (sin push ni release)"
    $dryJson = $manifestDryRun | ConvertTo-Json -Depth 10 -Compress
    Write-Host $dryJson
    $dryPath = Join-Path $projectRoot "scripts\${manifestFileName}.dryrun"
    $dryJson | Out-File -FilePath $dryPath -Encoding UTF8
    Write-Ok "Manifiesto guardado en: $dryPath"
    Write-Host "`n[DryRun completado] Sin efectos remotos." -ForegroundColor Yellow
    exit 0
}

# ---------------------------------------------------------------------------
# 7. CREAR GITHUB RELEASE O LIMPIAR ASSETS EXISTENTES (UpdateOnly)
# ---------------------------------------------------------------------------
if ($UpdateOnly) {
    Write-Step "UpdateOnly: eliminando assets anteriores de v$Version"
    # Obtener nombres de assets actuales y borrarlos para poder subir los nuevos
    $existingAssets = gh release view "v$Version" --repo $Repo --json assets | ConvertFrom-Json
    foreach ($asset in $existingAssets.assets) {
        if ($asset.name -in @($githubAssetName, $githubSigName, $manifestFileName)) {
            $ErrorActionPreference = "Continue"
            gh release delete-asset "v$Version" $asset.name --repo $Repo --yes 2>&1 | Out-Null
            $ErrorActionPreference = "Stop"
            Write-Ok "Asset eliminado: $($asset.name)"
        }
    }
} else {
    Write-Step "Creando GitHub Release v$Version"
    $releaseArgs = @(
        "release", "create", "v$Version",
        "--repo", $Repo,
        "--title", "v$Version",
        "--notes", $Notes
    )
    if ($Channel -eq "beta") { $releaseArgs += "--prerelease" }

    $ErrorActionPreference = "Continue"
    gh @releaseArgs
    $createEc = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($createEc -ne 0) { Write-Fail "gh release create fallo. El release NO se creo." }
    Write-Ok "Release v$Version creado"
}

# Subir .exe (renombrado con punto para consistencia con releases anteriores)
Write-Step "Subiendo assets al release"
$tempExe = Join-Path ([System.IO.Path]::GetTempPath()) $githubAssetName
$tempSig = Join-Path ([System.IO.Path]::GetTempPath()) $githubSigName
Copy-Item $exePath $tempExe -Force
Copy-Item $sigPath $tempSig -Force

$ErrorActionPreference = "Continue"
gh release upload "v$Version" $tempExe $tempSig --repo $Repo
$uploadEc = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($uploadEc -ne 0) { Write-Fail "gh release upload fallo. El release existe pero sin assets. Reintenta con -SkipBuild." }
Write-Ok "Assets subidos: $githubAssetName + $githubSigName"

# Limpiar temporales
Remove-Item $tempExe, $tempSig -ErrorAction SilentlyContinue

# Obtener URL real del asset .exe confirmada desde la API
$releaseAssets = gh release view "v$Version" --repo $Repo --json assets | ConvertFrom-Json
$exeAsset = $releaseAssets.assets | Where-Object { $_.name -eq $githubAssetName }
if (-not $exeAsset) { Write-Fail "No se encontro el asset '$githubAssetName' en el release tras el upload." }

# Extraer el asset ID numerico desde apiUrl (ej: .../releases/assets/757865100)
$assetIdNumeric = ($exeAsset.apiUrl -split '/')[-1]
# Usar proxy de MadPost-Dash para evitar problemas de red con github.com/releases/download
$exeAssetUrl = "https://madpost.bizzify.lat/api/download?asset_id=$assetIdNumeric&repo=$([Uri]::EscapeDataString($Repo))&name=$([Uri]::EscapeDataString($githubAssetName))"
Write-Ok "URL proxy del exe: $exeAssetUrl"

# ---------------------------------------------------------------------------
# 8. GENERAR MANIFIESTO CON URL REAL
# ---------------------------------------------------------------------------
Write-Step "Generando manifiesto $manifestFileName"

$manifest = [ordered]@{
    version  = $Version
    notes    = $Notes
    pub_date = $pubDate
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            url       = $exeAssetUrl
            signature = $sigContent
        }
    }
}
$manifestJson = $manifest | ConvertTo-Json -Depth 10 -Compress
Write-Ok "Manifiesto generado (firma real del .sig incluida)"

# ---------------------------------------------------------------------------
# 9. SUBIR MANIFIESTO COMO ASSET DEL RELEASE
# ---------------------------------------------------------------------------
# Para repo privado: el manifiesto se sube como asset del release.
# El actualizador actual (update_installer.rs) ya usa token GitHub para acceder a assets.
Write-Step "Subiendo $manifestFileName como asset del release"

$tempManifest = Join-Path ([System.IO.Path]::GetTempPath()) $manifestFileName
[System.IO.File]::WriteAllText($tempManifest, $manifestJson, [System.Text.UTF8Encoding]::new($false))

$ErrorActionPreference = "Continue"
gh release upload "v$Version" $tempManifest --repo $Repo
$manifestUploadEc = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($manifestUploadEc -ne 0) {
    Write-Warn "No se pudo subir $manifestFileName como asset. El release existe pero el manifiesto NO esta publicado."
    Write-Warn "Reintenta con: gh release upload v$Version '$tempManifest' --repo $Repo"
    exit 1
}
Write-Ok "$manifestFileName subido como asset del release"

# Verificar que el asset existe
$releaseAfter = gh release view "v$Version" --repo $Repo --json assets | ConvertFrom-Json
$manifestAsset = $releaseAfter.assets | Where-Object { $_.name -eq $manifestFileName }
if (-not $manifestAsset) {
    Write-Warn "El asset $manifestFileName no aparece tras el upload. Puede ser cache. URL esperada:"
    Write-Warn "  https://github.com/$Repo/releases/download/v$Version/$manifestFileName"
}

# ---------------------------------------------------------------------------
# 10. ACTUALIZAR RAMA releases-manifest (via git worktree)
# ---------------------------------------------------------------------------
Write-Step "Actualizando rama releases-manifest"

$worktreeDir = Join-Path ([System.IO.Path]::GetTempPath()) "madpost-releases-manifest-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"

# Verificar si la rama existe en remoto
$branchExists = git ls-remote --heads origin releases-manifest 2>&1
$branchExistsRemote = $branchExists -match "releases-manifest"

try {
    if (-not $branchExistsRemote) {
        Write-Warn "Rama releases-manifest no existe en remoto. Creando rama huerfana..."
        # Crear worktree con rama huerfana nueva
        $ErrorActionPreference = "Continue"
        git worktree add --orphan -b releases-manifest $worktreeDir
        $wtEc = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
        if ($wtEc -ne 0) { throw "No se pudo crear el worktree huerfano." }

        Push-Location $worktreeDir
        # Inicializar con README para que la rama no este vacia
        @"
# MadPost Desktop -- Manifiestos de actualizacion

Este branch contiene unicamente los manifiestos JSON para el sistema de actualizacion Tauri.

- `stable-latest.json` -- ultima version estable
- `beta-latest.json`   -- ultima version beta autorizada

No modificar manualmente. Actualizado por `scripts/publish-release.ps1`.
"@ | Out-File "README.md" -Encoding UTF8
        git add README.md
        git commit -m "chore: inicializar rama releases-manifest"
        git push origin releases-manifest
        Pop-Location
    } else {
        # La rama existe: hacer checkout via worktree
        git fetch origin releases-manifest
        $ErrorActionPreference = "Continue"
        git worktree add $worktreeDir releases-manifest
        $wtEc2 = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
        if ($wtEc2 -ne 0) { throw "No se pudo crear el worktree de releases-manifest." }
        Push-Location $worktreeDir
        $ErrorActionPreference = "Continue"
        git pull origin releases-manifest --ff-only
        $ErrorActionPreference = "Stop"
    }

    # Leer manifiesto del otro canal para no sobreescribirlo
    $otherManifestFile = if ($Channel -eq "stable") { "beta-latest.json" } else { "stable-latest.json" }

    # Verificar regresion de version antes de escribir
    if (Test-Path $manifestFileName) {
        $existing = Get-Content $manifestFileName -Raw | ConvertFrom-Json
        $existingSemver = Parse-SemVer $existing.version
        $newSemver = Parse-SemVer $Version
        if ($existingSemver -and $newSemver) {
            $cmp = Compare-SemVer $newSemver $existingSemver
            if ($cmp -lt 0) {
                Pop-Location
                Write-Fail "Version $Version es MENOR que la actual en $manifestFileName ($($existing.version)). No se sobreescribe para evitar regresion."
            }
        }
    }

    # Escribir manifiesto del canal actual
    [System.IO.File]::WriteAllText((Resolve-Path $manifestFileName).Path, $manifestJson, [System.Text.UTF8Encoding]::new($false))
    git add $manifestFileName
    git commit -m "release($Channel): v$Version"
    $ErrorActionPreference = "Continue"
    git push origin releases-manifest
    $pushEc = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($pushEc -ne 0) { throw "git push fallo." }
    Write-Ok "Rama releases-manifest actualizada con $manifestFileName"

} catch {
    Write-Warn "Error actualizando releases-manifest: $_"
    Write-Warn "El release de GitHub SI existe y los assets estan subidos."
    Write-Warn "Para reintentar solo el manifiesto, ejecuta el script con -SkipBuild una vez que el worktree este limpio."
    exit 1
} finally {
    if (Get-Location | Select-Object -ExpandProperty Path | Where-Object { $_ -eq $worktreeDir }) {
        Pop-Location
    }
    if (Test-Path $worktreeDir) {
        git worktree remove $worktreeDir --force 2>$null
    }
    Remove-Item $tempManifest -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 11. RESUMEN FINAL
# ---------------------------------------------------------------------------
Write-Host "`n========================================" -ForegroundColor Green
Write-Host " PUBLICACION COMPLETADA" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Version  : v$Version"
Write-Host "  Canal    : $Channel"
Write-Host "  Release  : https://github.com/$Repo/releases/tag/v$Version"
Write-Host "  Exe URL  : $exeAssetUrl"
Write-Host "  Manifiesto asset: https://github.com/$Repo/releases/download/v$Version/$manifestFileName"
Write-Host "  Manifiesto rama : (releases-manifest) $manifestFileName"
if ($isPrivate) {
    Write-Host ""
    Write-Host "  NOTA REPO PRIVADO: El actualizador actual (update_installer.rs) accede" -ForegroundColor Yellow
    Write-Host "  a los assets con MADPOST_GITHUB_TOKEN -- compatible con assets privados." -ForegroundColor Yellow
    Write-Host "  Cuando se active tauri-plugin-updater, configurar endpoints a las URLs" -ForegroundColor Yellow
    Write-Host "  de asset API con token, o hacer el repo publico." -ForegroundColor Yellow
}
Write-Host "========================================" -ForegroundColor Green
exit 0
