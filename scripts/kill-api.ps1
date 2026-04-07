Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue
    if ($proc -and ($proc.CommandLine -like '*crm-whatsapp*apps*api*' -or $proc.CommandLine -like '*nest*')) {
      Write-Output ("Killing API PID " + $proc.ProcessId)
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
# Also kill orphan node children matching api
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*crm-whatsapp*apps*api*' -or ($_.CommandLine -like '*nest*' -and $_.CommandLine -like '*api*') } |
  ForEach-Object {
    Write-Output ("Killing orphan API PID " + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
