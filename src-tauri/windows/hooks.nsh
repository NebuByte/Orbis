; Orbis's uninstaller also undoes the two things Orbis sets in Windows: starting with Windows, and
; being the screen saver. Settings, the file index and the search engine stay in %LOCALAPPDATA%\Orbis
; (the README says how to remove them).
!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Orbis"
  ReadRegStr $0 HKCU "Control Panel\Desktop" "SCRNSAVE.EXE"
  StrCmp $0 "$LOCALAPPDATA\Orbis\Orbis.scr" 0 +3
    DeleteRegValue HKCU "Control Panel\Desktop" "SCRNSAVE.EXE"
    WriteRegStr HKCU "Control Panel\Desktop" "ScreenSaveActive" "0"
  Delete "$LOCALAPPDATA\Orbis\Orbis.scr"
!macroend
