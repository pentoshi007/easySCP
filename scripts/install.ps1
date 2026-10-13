function Fail([string] $message) {
  throw "easyscp: $message"
}

function Install-Easyscp {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $repo = 'pentoshi007/easySCP'
  $installDir = if ($env:EASYSCP_INSTALL_DIR) { $env:EASYSCP_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\easyscp' }
  $version = if ($env:EASYSCP_VERSION) { $env:EASYSCP_VERSION.TrimStart('v') } else { 'latest' }

  try {
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    $architecture = $env:PROCESSOR_ARCHITECTURE
  }
  $arch = switch ($architecture) {
    { $_ -in 'X64', 'AMD64' } { 'x64' }
    { $_ -in 'Arm64', 'ARM64' } { 'arm64' }
    default { Fail "there is no standalone easyscp for $architecture. Install it with npm: npm install -g easyscp" }
  }

  $base = if ($env:EASYSCP_DOWNLOAD_BASE) {
    $env:EASYSCP_DOWNLOAD_BASE
  } elseif ($version -eq 'latest') {
    "https://github.com/$repo/releases/latest/download"
  } else {
    "https://github.com/$repo/releases/download/v$version"
  }

  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $asset = "easyscp-windows-$arch.exe.gz"
  $work = Join-Path ([IO.Path]::GetTempPath()) ("easyscp-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $work | Out-Null

  try {
    Write-Host "Downloading $asset"
    $archive = Join-Path $work $asset
    $sums = Join-Path $work 'SHA256SUMS'
    try {
      Invoke-WebRequest -Uri "$base/$asset" -OutFile $archive -UseBasicParsing
      Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
    } catch {
      Fail "couldn't download easyscp from $base ($($_.Exception.Message))"
    }

    $pattern = '^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($asset) + '$'
    $expected = Get-Content $sums | ForEach-Object { if ($_.Trim() -match $pattern) { $Matches[1].ToLower() } } | Select-Object -First 1
    if (-not $expected) { Fail "the release checksums don't list $asset" }
    if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower() -ne $expected) {
      Fail "the download doesn't match its published checksum"
    }

    $exe = Join-Path $work 'easyscp.exe'
    $compressed = [IO.File]::OpenRead($archive)
    try {
      $unpacked = [IO.File]::Create($exe)
      try {
        $gzip = New-Object IO.Compression.GZipStream($compressed, [IO.Compression.CompressionMode]::Decompress)
        $gzip.CopyTo($unpacked)
        $gzip.Dispose()
      } finally {
        $unpacked.Dispose()
      }
    } finally {
      $compressed.Dispose()
    }

    $env:EASYSCP_NO_UPDATE_CHECK = '1'
    try {
      $installed = (& $exe --version | Out-String).Trim()
    } catch {
      $installed = ''
    } finally {
      Remove-Item Env:EASYSCP_NO_UPDATE_CHECK -ErrorAction SilentlyContinue
    }
    if ($LASTEXITCODE -ne 0 -or -not $installed) { Fail "the downloaded easyscp doesn't run on this computer" }

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    foreach ($name in 'easyscp.exe', 'escp.exe') {
      $target = Join-Path $installDir $name
      if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath "$target.old" -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $target -Destination "$target.old" -Force
      }
    }
    $main = Join-Path $installDir 'easyscp.exe'
    $alias = Join-Path $installDir 'escp.exe'
    for ($attempt = 1; ; $attempt++) {
    try {
      Move-Item -LiteralPath $exe -Destination $main
      break
    } catch {
      if ($attempt -ge 20) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
    try {
      New-Item -ItemType HardLink -Path $alias -Target $main | Out-Null
    } catch {
      Copy-Item -LiteralPath $main -Destination $alias
    }
    foreach ($name in 'easyscp.exe', 'escp.exe') {
      Remove-Item -LiteralPath (Join-Path $installDir "$name.old") -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Installed easyscp $installed to $installDir"
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split ';' | Where-Object { $_ })
  if ($entries -notcontains $installDir) {
    [Environment]::SetEnvironmentVariable('Path', (@($installDir) + $entries) -join ';', 'User')
    Write-Host "Added $installDir to your PATH"
  }
  if (@($env:Path -split ';') -notcontains $installDir) {
    $env:Path = "$installDir;$env:Path"
  }

  if (-not $env:EASYSCP_NO_COMPLETION) {
    & $main completion install powershell
  }

  Write-Host 'Open a new terminal and run: easyscp'
}

Install-Easyscp
