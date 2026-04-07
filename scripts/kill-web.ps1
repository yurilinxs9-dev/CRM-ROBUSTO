Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*crm-whatsapp*apps*web*' -or $_.CommandLine -like '*next dev*' } |
  ForEach-Object {
    Write-Output ("Killing PID " + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
