; Preview-only shell verbs. Every key name and label is distinct from the
; stable installer's OpenInTerax keys, so installing or uninstalling the
; preview never rewrites or deletes a stable Terax install's context menu.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTeraxSshPreview" "" "Open in Terax SSH Preview"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTeraxSshPreview" "Icon" '"$INSTDIR\terax.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTeraxSshPreview" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTeraxSshPreview\command" "" '"$INSTDIR\terax.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTeraxSshPreview" "" "Open in Terax SSH Preview"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTeraxSshPreview" "Icon" '"$INSTDIR\terax.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTeraxSshPreview" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTeraxSshPreview\command" "" '"$INSTDIR\terax.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTeraxSshPreview" "" "Open in Terax SSH Preview"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTeraxSshPreview" "Icon" '"$INSTDIR\terax.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTeraxSshPreview" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTeraxSshPreview\command" "" '"$INSTDIR\terax.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTeraxSshPreview"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTeraxSshPreview"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTeraxSshPreview"
!macroend
