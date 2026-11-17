' ================================================================
' DESPERTADOR DEL EJECUTOR DE PACOSAT (2.0.1, mejora 31)
' ----------------------------------------------------------------
' El lanzador en segundo plano. Lo invocan, sin que se vea nada:
'   - el protocolo pacosat:// (los botones de PacoSAT), con la URL
'     como argumento: despertar.vbs "pacosat://ejecutar"
'   - el arranque automático de Windows (clave Run), sin argumento
'   - la bandeja (bandeja.ps1), si está en marcha
'
' Instancia única: consulta por WMI si ya corre un node con el
' ejecutor-local.mjs de ESTA carpeta; si ya corre, no hace nada
' (éxito silencioso). Si no corre, lo arranca OCULTO (ventana 0)
' con el mismo entorno que arrancar.bat y se queda esperando:
' si el ejecutor sale con el código 42 (se auto-actualizó), lo
' relanza con la versión nueva, igual que hacía el .bat.
'
' Aquí no hay secretos impresos ni pedidos a nadie: la dirección
' de PacoSAT sale de url.txt de ESTA carpeta (o la de siempre) y
' la llave, de token.txt de ESTA carpeta — el servidor no sabe
' ni tiene que saber dónde vive este programa en tu PC.
' ================================================================
Option Explicit

Dim fso, shell, carpeta, env
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
Set env = shell.Environment("PROCESS")
shell.CurrentDirectory = carpeta

Function LeerPrimeraLinea(ruta)
  LeerPrimeraLinea = ""
  If fso.FileExists(ruta) Then
    Dim ts
    Set ts = fso.OpenTextFile(ruta, 1)
    If Not ts.AtEndOfStream Then LeerPrimeraLinea = Trim(ts.ReadLine())
    ts.Close
  End If
End Function

Function YaCorre()
  YaCorre = False
  Dim wmi, procesos, p
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set procesos = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name = 'node.exe' AND CommandLine LIKE '%ejecutor-local.mjs%'")
  For Each p In procesos
    If Not IsNull(p.CommandLine) Then
      If InStr(1, p.CommandLine, carpeta, vbTextCompare) > 0 Then
        YaCorre = True
        Exit Function
      End If
    End If
  Next
End Function

If YaCorre() Then
  WScript.Quit 0
End If

' El mismo entorno que arrancar.bat fija hoy.
Dim urlBase
urlBase = LeerPrimeraLinea(carpeta & "\url.txt")
If urlBase = "" Then urlBase = "https://pacosat.iglesiasmurrieta.com"
env.Item("PACOSAT_URL") = urlBase

Dim token
token = LeerPrimeraLinea(carpeta & "\token.txt")
If token <> "" Then env.Item("PACOSAT_EXECUTOR_TOKEN") = token

If fso.FileExists("C:\Program Files\Google\Chrome\Application\chrome.exe") Then
  env.Item("PACOSAT_CHROMIUM_PATH") = "C:\Program Files\Google\Chrome\Application\chrome.exe"
End If
If fso.FileExists("C:\Program Files (x86)\Google\Chrome\Application\chrome.exe") Then
  env.Item("PACOSAT_CHROMIUM_PATH") = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
End If
env.Item("PACOSAT_EFIRMA_DIR") = carpeta & "\efirma-local"

' Arranque oculto (ventana 0), esperando la salida: el 42 es
' «me actualicé solo», y se relanza igual que en arrancar.bat.
Dim codigoSalida
Do
  codigoSalida = shell.Run("node """ & carpeta & "\ejecutor-local.mjs""", 0, True)
Loop While codigoSalida = 42

WScript.Quit 0
