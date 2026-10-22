; Explicit branded icon for owned shortcuts; never clear the user's global icon cache.
; Author: ahui. This hook also runs after the interactive finish page creates a link.
!include "${__FILEDIR__}\brand-icon.nsh"
Var ECGInstalled

Function ECGRefreshDesktopIcon
  ${If} $ECGInstalled != 1
    Return
  ${EndIf}
  !insertmacro IsShortcutTarget "$DESKTOP\${ECG_PRODUCT_NAME}.lnk" "$INSTDIR\${ECG_BINARY_NAME}.exe"
  Pop $0
  ${If} $0 = 1
    CreateShortcut "$DESKTOP\${ECG_PRODUCT_NAME}.lnk" "$INSTDIR\${ECG_BINARY_NAME}.exe" "" "$INSTDIR\${ECG_BRAND_ICON}" 0
    !define BUNDLEID "${ECG_BUNDLE_ID}"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${ECG_PRODUCT_NAME}.lnk"
    !undef BUNDLEID
    ; SHCNE_UPDATEITEM / SHCNF_PATHW: notify only the updated link.
    System::Call 'shell32::SHChangeNotify(i 0x2000, i 5, w "$DESKTOP\${ECG_PRODUCT_NAME}.lnk", p 0)'
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  StrCpy $ECGInstalled 1
  Call ECGRefreshDesktopIcon
!macroend

Function .onGUIEnd
  Call ECGRefreshDesktopIcon
FunctionEnd
