# ================================================================
# BANDEJA DEL EJECUTOR DE PACOSAT (2.0.1, mejora 31)
# ----------------------------------------------------------------
# El icono junto al reloj de Windows: la prueba visible de que el
# ejecutor vive en este equipo. Solo usa lo que Windows ya trae
# (System.Windows.Forms.NotifyIcon): sin dependencias, sin
# instalar nada.
#
# Qué hace:
#   - Al arrancar, despierta al ejecutor (despertar.vbs) si no
#     está ya en marcha.
#   - Vigila cada pocos segundos: si el ejecutor se durmió, lo
#     vuelve a despertar; el icono dice su estado («en marcha» /
#     «dormido») sin abrir ninguna ventana.
#   - Menú con el botón derecho: «Abrir PacoSAT» (tu PacoSAT en
#     el navegador de siempre) y «Salir» (retira el icono; el
#     ejecutor residente sigue su vida: se apaga cerrando su
#     proceso o quitando el arranque automático en el instalador).
#   - Doble clic en el icono: también abre PacoSAT.
#
# Se lanza oculto y en modo STA, p. ej. desde despertar o a mano:
#   powershell -NoProfile -STA -WindowStyle Hidden -File bandeja.ps1
# ================================================================
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$carpeta = Split-Path -Parent $MyInvocation.MyCommand.Path
$despertar = Join-Path $carpeta 'despertar.vbs'

function Get-UrlPacoSAT {
    $urlFile = Join-Path $carpeta 'url.txt'
    if (Test-Path $urlFile) {
        $linea = (Get-Content $urlFile -TotalCount 1).Trim()
        if ($linea) { return $linea }
    }
    return 'https://pacosat.iglesiasmurrieta.com'
}

function Test-EjecutorEnMarcha {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*ejecutor-local.mjs*' -and $_.CommandLine -like "*$carpeta*" }
    return [bool]$procs
}

function Despertar-Ejecutor {
    if (-not (Test-EjecutorEnMarcha) -and (Test-Path $despertar)) {
        Start-Process wscript.exe -ArgumentList "`"$despertar`"" -WindowStyle Hidden
    }
}

Despertar-Ejecutor

$icono = New-Object System.Windows.Forms.NotifyIcon
$icono.Icon = [System.Drawing.SystemIcons]::Application
$icono.Text = 'PacoSAT Ejecutor: arrancando'
$icono.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemAbrir = $menu.Items.Add('Abrir PacoSAT')
$itemAbrir.add_Click({ Start-Process (Get-UrlPacoSAT) })
$menu.Items.Add('-') | Out-Null
$itemSalir = $menu.Items.Add('Salir')
$itemSalir.add_Click({
    $icono.Visible = $false
    $icono.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$icono.ContextMenuStrip = $menu
$icono.add_DoubleClick({ Start-Process (Get-UrlPacoSAT) })

$temporizador = New-Object System.Windows.Forms.Timer
$temporizador.Interval = 5000
$temporizador.add_Tick({
    if (Test-EjecutorEnMarcha) {
        $icono.Text = 'PacoSAT Ejecutor: en marcha'
    } else {
        $icono.Text = 'PacoSAT Ejecutor: dormido (despertando)'
        Despertar-Ejecutor
    }
})
$temporizador.Start()

[System.Windows.Forms.Application]::Run()
